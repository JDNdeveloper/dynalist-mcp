/**
 * Tests for send_to_inbox when no inbox is configured on the server.
 * Verifies that the DynalistApiError with code "NoInbox" is surfaced
 * as a structured error response.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createTestContext,
  callToolError,
  type TestContext,
} from "./test-helpers";
import type { DummyDynalistServer } from "../dummy-server";

/**
 * Setup with documents but no inbox configured. The DummyDynalistServer
 * defaults to no inbox (inboxFileId and inboxRootNodeId are null) unless
 * setInbox is called.
 */
function setupWithoutInbox(server: DummyDynalistServer): void {
  server.addFolder("folder_a", "Folder A", "root_folder");
  server.addDocument("doc1", "Test Document", "folder_a", [
    server.makeNode("root", "Test Document", []),
  ]);
}

let ctx: TestContext;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
  }
});

describe("send_to_inbox without inbox configured", () => {
  test("returns NoInbox error when no inbox is configured", async () => {
    ctx = await createTestContext(setupWithoutInbox);

    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "This should fail",
    });

    expect(err.error).toBe("NoInbox");
    expect(err.message).toContain("inbox");
  });
});
