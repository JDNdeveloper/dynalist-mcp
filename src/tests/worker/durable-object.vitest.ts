import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import type { Client } from "@modelcontextprotocol/client";
import { DummyDynalistServer } from "../dummy-server";
import { DEFAULT_TEST_CONFIG, callToolOk, standardSetup } from "../tools/test-helpers";
import { setTestConfig } from "../../config";
import {
  DynalistCallLog,
  GithubStub,
  authorize,
  connectMcpClient,
  installOutboundStubs,
  mcpObjectStub,
  postMcp,
  resetDurableObject,
} from "./harness";

describe("DynalistMcpDurableObject", () => {
  let dynalist: DummyDynalistServer;
  let callLog: DynalistCallLog;
  let client: Client;
  let accessToken: string;

  beforeEach(async () => {
    dynalist = new DummyDynalistServer();
    dynalist.init();
    standardSetup(dynalist);
    callLog = new DynalistCallLog();
    installOutboundStubs(dynalist, new GithubStub(), callLog);
    await resetDurableObject();
    accessToken = await authorize();
    client = await connectMcpClient(accessToken);
  });

  afterEach(async () => {
    await client.close();
    setTestConfig(null);
    vi.restoreAllMocks();
  });

  describe("batched writes", () => {
    it("accepts a batch_index 0, 1 sequence across separate HTTP requests", async () => {
      const read = await callToolOk(client, "read_document", { file_id: "doc1" });
      const syncToken = read.sync_token as string;

      await callToolOk(client, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n1", content: "First update" }],
        expected_sync_token: syncToken,
        batch_index: 0,
      });
      const second = await callToolOk(client, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n2", content: "Second update" }],
        expected_sync_token: syncToken,
        batch_index: 1,
      });

      expect(second.sync_warning).toBeUndefined();
      const nodes = dynalist.documents.get("doc1")!.nodes;
      expect(nodes.find((node) => node.id === "n2")!.content).toBe("Second update");
    });

    // Hibernation wipes the object's memory between tool calls, so batch
    // state must come back from Durable Object storage.
    it("accepts batch_index 1 after the object restarts between batch members", async () => {
      const read = await callToolOk(client, "read_document", { file_id: "doc1" });
      const syncToken = read.sync_token as string;

      await callToolOk(client, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n1", content: "First update" }],
        expected_sync_token: syncToken,
        batch_index: 0,
      });

      await evictDurableObject(mcpObjectStub());

      const second = await callToolOk(client, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n2", content: "Second update" }],
        expected_sync_token: syncToken,
        batch_index: 1,
      });
      expect(second.sync_warning).toBeUndefined();
    });
  });

  describe("file tree cache", () => {
    it("reuses the persisted file tree cache after the object restarts", async () => {
      setTestConfig({ ...DEFAULT_TEST_CONFIG, access: { default: "allow", rules: [{ path: "/Folder B/**", policy: "read" }] } });

      await callToolOk(client, "read_document", { file_id: "doc1" });
      await evictDurableObject(mcpObjectStub());

      callLog.calls = [];
      await callToolOk(client, "read_document", { file_id: "doc2" });
      expect(callLog.count("/file/list")).toBe(0);
    });

    it("refetches the file tree when the access rules change", async () => {
      setTestConfig({ ...DEFAULT_TEST_CONFIG, access: { default: "allow", rules: [{ path: "/Folder B/**", policy: "read" }] } });
      await callToolOk(client, "read_document", { file_id: "doc1" });

      setTestConfig({ ...DEFAULT_TEST_CONFIG, access: { default: "allow", rules: [{ path: "/Folder A/**", policy: "read" }] } });
      callLog.calls = [];
      await callToolOk(client, "read_document", { file_id: "doc2" });
      expect(callLog.count("/file/list")).toBe(1);
    });
  });

  describe("platform failures", () => {
    it("converts an exception thrown inside the object into a JSON-RPC error", async () => {
      await runInDurableObject(mcpObjectStub(), (instance) => {
        (instance as unknown as { handler: () => never }).handler = () => {
          throw new Error("simulated platform failure");
        };
      });

      const response = await postMcp({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }, accessToken);
      expect(response.status).toBe(500);
      const body = await response.json() as { id: number; error: { message: string } };
      expect(body.id).toBe(7);
      expect(body.error.message).toContain("A write may have been partially applied");
    });
  });
});
