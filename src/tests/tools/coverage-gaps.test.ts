/**
 * Tests for coverage gaps: T2, T5, T6, T7, T8, T9, T10, T11, T12.
 * Each section targets a specific feature or edge case identified
 * in the fix plan.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  getVersion,
  standardSetup,
  type TestContext,
} from "./test-helpers";
import { setTestConfig } from "../../config";
import { DummyDynalistServer } from "../dummy-server";
import {
  wrapToolHandler,
  makeResponse,
  ToolInputError,
  checkContentSize,
} from "../../utils/dynalist-helpers";
import { DynalistApiError } from "../../dynalist-client";
import { ConfigError } from "../../config";

// ═══════════════════════════════════════════════════════════════════════
// T2: Config reloading integration test
// ═══════════════════════════════════════════════════════════════════════

describe("T2: config reloading between tool invocations", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("readOnly change is picked up on next tool invocation", async () => {
    // Start with readOnly: false, so writes succeed.
    ctx = await createTestContext(standardSetup, { readOnly: false });

    const version = await getVersion(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      expected_version: version,
      nodes: [{ node_id: "n1", content: "Updated" }],
    });
    expect(result.file_id).toBe("doc1");

    // Switch to readOnly: true via setTestConfig.
    setTestConfig({
      readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
      sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },

      readOnly: true,
      cache: { ttlSeconds: 300 },
      logLevel: "warn",
    });

    // The next write tool invocation should see readOnly and refuse.
    const version2 = await getVersion(ctx.mcpClient, "doc1");
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      expected_version: version2,
      nodes: [{ node_id: "n1", content: "Should fail" }],
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readDefaults change affects read_document behavior", async () => {
    // Start with includeChecked: true.
    ctx = await createTestContext(standardSetup, {
      readDefaults: { maxDepth: 10, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
    });

    // n3 has checked: true. It should appear.
    const result1 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const node1 = result1.node as Record<string, unknown>;
    const children1 = node1.children as Record<string, unknown>[];
    expect(children1.some((c) => c.node_id === "n3")).toBe(true);

    // Switch includeChecked to false.
    setTestConfig({
      readDefaults: { maxDepth: 10, includeCollapsedChildren: false, includeNotes: true, includeChecked: false },
      sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },

      readOnly: false,
      cache: { ttlSeconds: 300 },
      logLevel: "warn",
    });

    // n3 should no longer appear because the config now excludes checked items.
    const result2 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const node2 = result2.node as Record<string, unknown>;
    const children2 = node2.children as Record<string, unknown>[];
    expect(children2.some((c) => c.node_id === "n3")).toBe(false);
  });

  test("sizeWarning threshold change takes effect on next read", async () => {
    // Start with high thresholds so nothing triggers a warning.
    ctx = await createTestContext(standardSetup, {
      sizeWarning: { warningTokenThreshold: 100000, maxTokenThreshold: 200000 },
    });

    const result1 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    expect(result1.warning).toBeUndefined();
    expect(result1.node).toBeDefined();

    // Lower thresholds so the same read triggers a warning.
    setTestConfig({
      readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
      sizeWarning: { warningTokenThreshold: 1, maxTokenThreshold: 24500 },

      readOnly: false,
      cache: { ttlSeconds: 300 },
      logLevel: "warn",
    });

    const result2 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    expect(result2.warning).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T5: wrapToolHandler error path coverage
// ═══════════════════════════════════════════════════════════════════════

describe("T5: wrapToolHandler error paths", () => {
  test("ToolInputError is caught and returned as structured error", async () => {
    const handler = wrapToolHandler(async () => {
      throw new ToolInputError("NodeNotFound", "Node 'xyz' not found in document.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("NodeNotFound");
    expect(result.structuredContent.message).toContain("Node 'xyz' not found");
  });

  test("DynalistApiError is caught and returned with its code", async () => {
    const handler = wrapToolHandler(async () => {
      throw new DynalistApiError("TooManyRequests", "Rate limited.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("TooManyRequests");
    expect(result.structuredContent.message).toContain("Rate limited");
  });

  test("ConfigError is caught and returned with ConfigError code", async () => {
    const handler = wrapToolHandler(async () => {
      throw new ConfigError("Config file is invalid: bad field.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("ConfigError");
    expect(result.structuredContent.message).toContain("Config file is invalid");
  });

  test("generic Error is caught and returned with Unknown code", async () => {
    const handler = wrapToolHandler(async () => {
      throw new Error("Something unexpected happened.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("Unknown");
    expect(result.structuredContent.message).toBe("Something unexpected happened.");
  });

  test("non-Error throwable is caught and stringified", async () => {
    const handler = wrapToolHandler(async () => {
      throw "string error";
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("Unknown");
    expect(result.structuredContent.message).toBe("string error");
  });

  test("successful handler returns result without error flag", async () => {
    const handler = wrapToolHandler(async () => {
      return makeResponse({ status: "ok" });
    });
    const result = await handler();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("ok");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T6: get_recent_changes date parsing edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("T6: get_recent_changes date parsing edge cases", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  // All tests use a node created at a known timestamp.
  const knownTs = new Date("2025-03-11T12:00:00.000Z").getTime();

  function timedSetup(server: DummyDynalistServer): void {
    server.addDocument("timed_doc", "Timed Doc", "root_folder", [
      server.makeNode("root", "Timed Doc", ["t1"]),
      server.makeNode("t1", "Timed node", [], { created: knownTs, modified: knownTs }),
    ]);
  }

  test("date-only string for since is treated as start-of-day UTC", async () => {
    ctx = await createTestContext(timedSetup);

    // The node was created at 2025-03-11T12:00:00Z. Using "2025-03-11"
    // as since should be midnight, so the node falls within range.
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(true);
  });

  test("date-only string for since excludes nodes from the previous day", async () => {
    ctx = await createTestContext(timedSetup);

    // Using "2025-03-12" as since should exclude a node from 2025-03-11T12:00.
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-12",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(false);
  });

  test("date-only string for until is treated as end-of-day UTC", async () => {
    ctx = await createTestContext(timedSetup);

    // "2025-03-11" for until should cover up to 23:59:59.999 UTC.
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: 0,
      until: "2025-03-11",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(true);
  });

  test("date-only string for until on previous day excludes the node", async () => {
    ctx = await createTestContext(timedSetup);

    // "2025-03-10" as until ends before the node's timestamp.
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: 0,
      until: "2025-03-10",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(false);
  });

  test("full ISO timestamp is parsed correctly", async () => {
    ctx = await createTestContext(timedSetup);

    // Using the exact ISO timestamp should include the node.
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11T12:00:00.000Z",
      until: "2025-03-11T12:00:00.000Z",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(true);
  });

  test("full ISO timestamp one second later excludes the node from since", async () => {
    ctx = await createTestContext(timedSetup);

    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11T12:00:01.000Z",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(false);
  });

  test("millisecond timestamp works for since parameter", async () => {
    ctx = await createTestContext(timedSetup);

    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: knownTs,
      until: knownTs,
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(true);
  });

  test("millisecond timestamp one ms after the node excludes it from until", async () => {
    ctx = await createTestContext(timedSetup);

    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: knownTs + 1,
      until: knownTs + 100,
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "t1")).toBe(false);
  });

  test("invalid date format for since returns error", async () => {
    ctx = await createTestContext(timedSetup);

    const err = await callToolError(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "not-a-date",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("since");
  });

  test("invalid date format for until returns error", async () => {
    ctx = await createTestContext(timedSetup);

    const err = await callToolError(ctx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: 0,
      until: "garbage-date",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("until");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T7: move_nodes complex sequential moves between different parents
// ═══════════════════════════════════════════════════════════════════════

describe("T7: move_nodes cross-parent sequential moves", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext((server) => {
      // Build a tree with multiple parents and children to test
      // cross-parent sequential moves.
      //
      // root -> [p1, p2, p3]
      // p1 -> [a, b]
      // p2 -> [c, d]
      // p3 -> [e]
      server.addDocument("xp_doc", "Cross Parent Doc", "root_folder", [
        server.makeNode("root", "Cross Parent Doc", ["p1", "p2", "p3"]),
        server.makeNode("p1", "Parent 1", ["a", "b"]),
        server.makeNode("a", "A", []),
        server.makeNode("b", "B", []),
        server.makeNode("p2", "Parent 2", ["c", "d"]),
        server.makeNode("c", "C", []),
        server.makeNode("d", "D", []),
        server.makeNode("p3", "Parent 3", ["e"]),
        server.makeNode("e", "E", []),
      ]);
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("sequential moves between different parents", async () => {
    // Move 'a' from p1 to p2, then move 'e' from p3 to p1.
    // The second move must see that p1 lost 'a' from the first move.
    const version = await getVersion(ctx.mcpClient, "xp_doc");
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "xp_doc",
      moves: [
        { node_id: "a", reference_node_id: "p2", position: "first_child" },
        { node_id: "e", reference_node_id: "p1", position: "first_child" },
      ],
      expected_version: version,
    });

    const doc = ctx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p2 = doc.nodes.find((n) => n.id === "p2")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    // p1 should have [e, b] (e at first, b remained).
    expect(p1.children).toEqual(["e", "b"]);
    // p2 should have [a, c, d] (a at first, c and d remained).
    expect(p2.children).toEqual(["a", "c", "d"]);
    // p3 should be empty.
    expect(p3.children).toEqual([]);
  });

  test("chain of cross-parent moves where each move changes the reference context", async () => {
    // Move 'c' from p2 as last_child of p1.
    // Move 'd' from p2 as last_child of p3.
    // Move 'a' from p1 after 'c' in p1.
    // After move 1: p1=[a,b,c], p2=[d], p3=[e].
    // After move 2: p1=[a,b,c], p2=[], p3=[e,d].
    // After move 3: p1=[b,c,a], p2=[], p3=[e,d].
    const version = await getVersion(ctx.mcpClient, "xp_doc");
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "xp_doc",
      moves: [
        { node_id: "c", reference_node_id: "p1", position: "last_child" },
        { node_id: "d", reference_node_id: "p3", position: "last_child" },
        { node_id: "a", reference_node_id: "c", position: "after" },
      ],
      expected_version: version,
    });

    const doc = ctx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p2 = doc.nodes.find((n) => n.id === "p2")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    expect(p1.children).toEqual(["b", "c", "a"]);
    expect(p2.children).toEqual([]);
    expect(p3.children).toEqual(["e", "d"]);
  });

  test("later move uses reference node that was relocated by earlier move", async () => {
    // Move 'a' as first_child of p3 (a goes from p1 to p3).
    // Move 'e' after 'a' (reference is 'a', which is now in p3).
    // The second move should place 'e' after 'a' within p3 (not the old parent).
    const version = await getVersion(ctx.mcpClient, "xp_doc");
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "xp_doc",
      moves: [
        { node_id: "a", reference_node_id: "p3", position: "first_child" },
        { node_id: "e", reference_node_id: "a", position: "after" },
      ],
      expected_version: version,
    });

    const doc = ctx.server.documents.get("xp_doc")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;

    // p3 should have [a, e]: 'a' was moved to first_child of p3, then 'e' was
    // moved to after 'a' (which is now in p3). 'e' was originally already in p3.
    expect(p3.children).toEqual(["a", "e"]);
    // p1 should only have 'b' remaining.
    expect(p1.children).toEqual(["b"]);
  });

  test("move empties one parent then moves into the empty parent", async () => {
    // Move 'e' out of p3 to p1, then move 'b' into (now empty) p3.
    const version = await getVersion(ctx.mcpClient, "xp_doc");
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "xp_doc",
      moves: [
        { node_id: "e", reference_node_id: "p1", position: "last_child" },
        { node_id: "b", reference_node_id: "p3", position: "first_child" },
      ],
      expected_version: version,
    });

    const doc = ctx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    // p1 lost 'b' (moved to p3), gained 'e'. So p1=[a, e].
    expect(p1.children).toEqual(["a", "e"]);
    // p3 lost 'e', gained 'b'. So p3=[b].
    expect(p3.children).toEqual(["b"]);
  });

  test("three-way swap across parents", async () => {
    // Swap nodes across three parents in sequence:
    // Move 'a' from p1 to first_child of p2.
    // Move 'c' from p2 to first_child of p3.
    // Move 'e' from p3 to first_child of p1.
    //
    // Starting: p1=[a,b], p2=[c,d], p3=[e].
    // After move 1: p1=[b], p2=[a,c,d], p3=[e].
    // After move 2: p1=[b], p2=[a,d], p3=[c,e].
    // After move 3: p1=[e,b], p2=[a,d], p3=[c].
    const version = await getVersion(ctx.mcpClient, "xp_doc");
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "xp_doc",
      moves: [
        { node_id: "a", reference_node_id: "p2", position: "first_child" },
        { node_id: "c", reference_node_id: "p3", position: "first_child" },
        { node_id: "e", reference_node_id: "p1", position: "first_child" },
      ],
      expected_version: version,
    });

    const doc = ctx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p2 = doc.nodes.find((n) => n.id === "p2")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    expect(p1.children).toEqual(["e", "b"]);
    expect(p2.children).toEqual(["a", "d"]);
    expect(p3.children).toEqual(["c"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T8: check_document_versions mixed allowed/denied IDs
// ═══════════════════════════════════════════════════════════════════════

describe("T8: check_document_versions mixed allowed/denied IDs", () => {
  let ctx: TestContext;

  const ACL_CONFIG = {
    access: {
      default: "deny" as const,
      rules: [
        { path: "/Allowed Folder/**", policy: "allow" as const },
        { path: "/Inbox", policy: "allow" as const },
      ],
    },
  };

  function aclSetup(server: DummyDynalistServer): void {
    server.addFolder("allowed_folder", "Allowed Folder", "root_folder");
    server.addFolder("denied_folder", "Denied Folder", "root_folder");

    server.addDocument("allowed_doc", "Allowed Doc", "allowed_folder", [
      server.makeNode("root", "Allowed Doc", ["x1"]),
      server.makeNode("x1", "Item", []),
    ]);

    server.addDocument("denied_doc", "Denied Doc", "denied_folder", [
      server.makeNode("root", "Denied Doc", ["y1"]),
      server.makeNode("y1", "Secret", []),
    ]);

    server.addDocument("inbox_doc", "Inbox", "root_folder", [
      server.makeNode("inbox_root", "Inbox", []),
    ]);
    server.setInbox("inbox_doc", "inbox_root");
  }

  beforeEach(async () => {
    ctx = await createTestContext(aclSetup, ACL_CONFIG);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("mixed batch returns real versions for allowed and -1 for denied", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc", "denied_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.allowed_doc).toBeGreaterThan(0);
    expect(versions.denied_doc).toBe(-1);
  });

  test("all denied IDs return version -1", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["denied_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.denied_doc).toBe(-1);
  });

  test("nonexistent ID returns -1 same as denied", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc", "denied_doc", "fake_id"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.allowed_doc).toBeGreaterThan(0);
    expect(versions.denied_doc).toBe(-1);
    expect(versions.fake_id).toBe(-1);
  });

  test("empty file_ids array returns empty versions map", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: [],
    });
    const versions = result.versions as Record<string, number>;
    expect(Object.keys(versions)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T9: list_documents/search_documents denied-content filtering
// ═══════════════════════════════════════════════════════════════════════

/**
 * Flatten a recursive list_documents files tree into a flat array.
 */
function flattenListFiles(files: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const f of files) {
    result.push(f);
    if (Array.isArray(f.children)) {
      result.push(...flattenListFiles(f.children as Record<string, unknown>[]));
    }
  }
  return result;
}

describe("T9: denied-content filtering", () => {
  let ctx: TestContext;

  const ACL_CONFIG = {
    access: {
      default: "allow" as const,
      rules: [
        { path: "/Secret Folder/**", policy: "deny" as const },
      ],
    },
  };

  function filterSetup(server: DummyDynalistServer): void {
    server.addFolder("public_folder", "Public Folder", "root_folder");
    server.addFolder("secret_folder", "Secret Folder", "root_folder");

    server.addDocument("public_doc", "Public Doc", "public_folder", [
      server.makeNode("root", "Public Doc", []),
    ]);

    server.addDocument("secret_doc", "Secret Doc", "secret_folder", [
      server.makeNode("root", "Secret Doc", []),
    ]);

    server.addDocument("inbox_doc", "Inbox", "root_folder", [
      server.makeNode("inbox_root", "Inbox", []),
    ]);
    server.setInbox("inbox_doc", "inbox_root");
  }

  beforeEach(async () => {
    ctx = await createTestContext(filterSetup, ACL_CONFIG);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("list_documents excludes denied documents", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenListFiles(result.files as Record<string, unknown>[]);
    expect(all.find((d) => d.file_id === "secret_doc")).toBeUndefined();
    // Public doc should still be present.
    expect(all.find((d) => d.file_id === "public_doc")).toBeDefined();
  });

  test("list_documents excludes denied folders", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenListFiles(result.files as Record<string, unknown>[]);
    expect(all.find((f) => f.file_id === "secret_folder")).toBeUndefined();
  });

  test("list_documents filters denied items from recursive tree", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenListFiles(result.files as Record<string, unknown>[]);
    const allIds = all.map((f) => f.file_id);
    expect(allIds).not.toContain("secret_folder");
    expect(allIds).not.toContain("secret_doc");
  });

  test("list_documents count reflects filtered count", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenListFiles(result.files as Record<string, unknown>[]);
    const docs = all.filter((f) => f.type === "document");
    expect(result.count).toBe(docs.length);
    // secret_doc should not be included.
    expect(docs.every((d) => d.file_id !== "secret_doc")).toBe(true);
  });

  test("search_documents excludes denied documents", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "Doc",
    });
    const matches = result.matches as Record<string, unknown>[];
    const secretMatch = matches.find((m) => m.file_id === "secret_doc");
    expect(secretMatch).toBeUndefined();
    const publicMatch = matches.find((m) => m.file_id === "public_doc");
    expect(publicMatch).toBeDefined();
  });

  test("search_documents excludes denied folders", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "Folder",
      type: "folder",
    });
    const matches = result.matches as Record<string, unknown>[];
    const secretFolder = matches.find((m) => m.file_id === "secret_folder");
    expect(secretFolder).toBeUndefined();
    const publicFolder = matches.find((m) => m.file_id === "public_folder");
    expect(publicFolder).toBeDefined();
  });

  test("search_documents count reflects filtered count", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "Doc",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(result.count).toBe(matches.length);
    for (const m of matches) {
      expect(m.file_id).not.toBe("secret_doc");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T10: Size warning boundary values
// ═══════════════════════════════════════════════════════════════════════

describe("T10: checkContentSize boundary values", () => {
  // checkContentSize estimates tokens as Math.ceil(text.length / 4).

  test("content at exactly warning threshold returns null (no warning)", () => {
    // 5000 tokens = 20000 chars. estimateTokens(20000 chars) = 5000.
    const content = "x".repeat(20000);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).toBeNull();
  });

  test("content one token above warning threshold triggers warning", () => {
    // 5001 tokens = 20001..20004 chars. Ceil(20001/4) = 5001.
    const content = "x".repeat(20001);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain("LARGE RESULT WARNING");
    expect(result!.canBypass).toBe(true);
  });

  test("content at exactly max threshold with bypass returns null", () => {
    // 24500 tokens = 98000 chars. Ceil(98000/4) = 24500.
    const content = "x".repeat(98000);
    const result = checkContentSize(content, true, ["Narrow scope"], 5000, 24500);
    expect(result).toBeNull();
  });

  test("content one token above max threshold with bypass is NOT bypassed", () => {
    // 24501 tokens = 98001..98004 chars. Ceil(98001/4) = 24501.
    const content = "x".repeat(98001);
    const result = checkContentSize(content, true, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.canBypass).toBe(false);
    expect(result!.warning).toContain("too large");
  });

  test("content above warning but below max threshold is bypassable", () => {
    // 10000 tokens = 40000 chars.
    const content = "x".repeat(40000);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.canBypass).toBe(true);
    expect(result!.warning).toContain("bypass_warning: true");
  });

  test("content above max threshold is not bypassable even without bypass", () => {
    // 30000 tokens = 120000 chars.
    const content = "x".repeat(120000);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.canBypass).toBe(false);
    expect(result!.warning).toContain("too large");
  });

  test("bypass_warning on small content warns about incorrect usage", () => {
    // Content under warning threshold, but bypass is true.
    const content = "x".repeat(100);
    const result = checkContentSize(content, true, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain("INCORRECT USAGE");
    expect(result!.canBypass).toBe(false);
  });

  test("empty content returns null", () => {
    const result = checkContentSize("", false, ["Narrow scope"], 5000, 24500);
    expect(result).toBeNull();
  });

  test("recommendations appear in warning text", () => {
    const content = "x".repeat(40000);
    const recs = ["Use max_depth", "Target a node_id"];
    const result = checkContentSize(content, false, recs, 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain("Use max_depth");
    expect(result!.warning).toContain("Target a node_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T11: File operation index out-of-bounds
// ═══════════════════════════════════════════════════════════════════════

describe("T11: file operation out-of-bounds index", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext(standardSetup);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("create_document with index far beyond folder child count succeeds", async () => {
    // folder_a has 1 child (doc1). Using index=1000 should still create.
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Out of Bounds Doc",
      index: 1000,
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Out of Bounds Doc");

    // Verify the document was created in the folder.
    const folder = ctx.server.files.get("folder_a")!;
    expect(folder.children).toContain(result.file_id as string);
  });

  test("create_folder with index far beyond parent child count succeeds", async () => {
    // root_folder has a few children. Using index=1000 should still create.
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      parent_folder_id: "root_folder",
      title: "Out of Bounds Folder",
      index: 1000,
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Out of Bounds Folder");

    // Verify the folder was created.
    const root = ctx.server.files.get("root_folder")!;
    expect(root.children).toContain(result.file_id as string);
  });

  test("create_document with index 0 in empty folder places it first", async () => {
    // Add an empty folder.
    ctx.server.addFolder("empty_folder", "Empty Folder", "root_folder");
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "empty_folder",
      title: "First Doc",
      index: 0,
    });
    expect(result.file_id).toBeDefined();
    const folder = ctx.server.files.get("empty_folder")!;
    expect(folder.children).toHaveLength(1);
    expect(folder.children![0]).toBe(result.file_id as string);
  });

  test("create_document with large index in folder with children appends at end", async () => {
    // folder_a has [doc1]. Using index=999 should place the new doc after doc1.
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Appended Doc",
      index: 999,
    });
    const folder = ctx.server.files.get("folder_a")!;
    // The new doc should be at the end (splice with out-of-bounds index appends).
    const lastChild = folder.children![folder.children!.length - 1];
    expect(lastChild).toBe(result.file_id as string);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T12: read_document field omission rules
// ═══════════════════════════════════════════════════════════════════════

describe("T12: read_document field omission rules", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("note field omitted when empty string", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("omit_doc", "Omit Test", "root_folder", [
        server.makeNode("root", "Omit Test", ["n1"]),
        server.makeNode("n1", "No note", [], { note: "" }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "omit_doc",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.note).toBeUndefined();
  });

  test("note field present when non-empty", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("note_doc", "Note Test", "root_folder", [
        server.makeNode("root", "Note Test", ["n1"]),
        server.makeNode("n1", "Has note", [], { note: "Important note" }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "note_doc",
      max_depth: 10,
      include_notes: true,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.note).toBe("Important note");
  });

  test("heading field omitted when 0", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("heading_doc", "Heading Test", "root_folder", [
        server.makeNode("root", "Heading Test", ["n1"]),
        server.makeNode("n1", "No heading", [], { heading: 0 }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "heading_doc",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.heading).toBeUndefined();
  });

  test("heading field present when non-zero", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("heading_doc2", "Heading Test 2", "root_folder", [
        server.makeNode("root", "Heading Test 2", ["n1"]),
        server.makeNode("n1", "H1 heading", [], { heading: 1 }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "heading_doc2",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.heading).toBe("h1");
  });

  test("color field omitted when 0", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("color_doc", "Color Test", "root_folder", [
        server.makeNode("root", "Color Test", ["n1"]),
        server.makeNode("n1", "No color", [], { color: 0 }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "color_doc",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.color).toBeUndefined();
  });

  test("color field present when non-zero", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("color_doc2", "Color Test 2", "root_folder", [
        server.makeNode("root", "Color Test 2", ["n1"]),
        server.makeNode("n1", "Red node", [], { color: 1 }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "color_doc2",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.color).toBe("red");
  });

  test("show_checkbox field omitted when not set on node", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("cb_doc", "Checkbox Test", "root_folder", [
        server.makeNode("root", "Checkbox Test", ["n1"]),
        // No checkbox or checked fields at all.
        server.makeNode("n1", "Plain node", []),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "cb_doc",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.show_checkbox).toBeUndefined();
    expect(n1.checked).toBeUndefined();
  });

  test("show_checkbox and checked fields present when set", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("cb_doc2", "Checkbox Test 2", "root_folder", [
        server.makeNode("root", "Checkbox Test 2", ["n1"]),
        server.makeNode("n1", "Checked node", [], { checkbox: true, checked: true }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "cb_doc2",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.show_checkbox).toBe(true);
    expect(n1.checked).toBe(true);
  });

  test("all optional fields present simultaneously", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("all_fields_doc", "All Fields", "root_folder", [
        server.makeNode("root", "All Fields", ["n1"]),
        server.makeNode("n1", "Full node", [], {
          note: "A note",
          heading: 2,
          color: 3,
          checkbox: true,
          checked: false,
        }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "all_fields_doc",
      max_depth: 10,
      include_notes: true,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.note).toBe("A note");
    expect(n1.heading).toBe("h2");
    expect(n1.color).toBe("yellow");
    expect(n1.show_checkbox).toBe(true);
    expect(n1.checked).toBe(false);
  });

  test("all optional fields omitted simultaneously", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("no_fields_doc", "No Fields", "root_folder", [
        server.makeNode("root", "No Fields", ["n1"]),
        // makeNode sets note: "", no heading/color/checkbox/checked.
        server.makeNode("n1", "Bare node", []),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "no_fields_doc",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.note).toBeUndefined();
    expect(n1.heading).toBeUndefined();
    expect(n1.color).toBeUndefined();
    expect(n1.show_checkbox).toBeUndefined();
    expect(n1.checked).toBeUndefined();
  });

  test("note field omitted when include_notes is false, even if non-empty", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("note_off_doc", "Note Off", "root_folder", [
        server.makeNode("root", "Note Off", ["n1"]),
        server.makeNode("n1", "Has note but hidden", [], { note: "Should not appear" }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "note_off_doc",
      max_depth: 10,
      include_notes: false,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.note).toBeUndefined();
  });

  test("whitespace-only note is treated as empty and omitted", async () => {
    ctx = await createTestContext((server) => {
      server.addDocument("ws_doc", "Whitespace Note", "root_folder", [
        server.makeNode("root", "Whitespace Note", ["n1"]),
        server.makeNode("n1", "Whitespace note", [], { note: "   \n  " }),
      ]);
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "ws_doc",
      max_depth: 10,
      include_notes: true,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    // Whitespace-only notes should be omitted (buildNodeTree checks node.note.trim()).
    expect(n1.note).toBeUndefined();
  });
});
