/**
 * Integration tests for version guard wiring. Verifies that every write
 * tool passes through the version guard correctly, and that post-write
 * concurrent modification detection works.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callTool,
  callToolOk,
  callToolError,
  getSyncToken,
  standardSetup,
  type TestContext,
} from "./test-helpers";
import { makeSyncToken } from "../../sync-token";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ═════════════════════════════════════════════════════════════════════
// edit_items version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("edit_items version guard", () => {
  test("stale expected_sync_token aborts with SyncTokenMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("SyncTokenMismatch");

    // Verify the node was not modified.
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find(n => n.id === "n1")!;
    expect(node.content).toBe("First item");
  });

  test("correct expected_sync_token succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const syncToken = makeSyncToken("doc1", doc.version);

    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: syncToken,
    });
    expect((result.item_ids as string[])).toEqual(["n1"]);
    expect(result.sync_warning).toBeUndefined();
  });

  test("omitted expected_sync_token returns schema validation error", async () => {
    const result = await callTool(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("expected_sync_token");
  });
});

// ═════════════════════════════════════════════════════════════════════
// insert_items version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("insert_items version guard", () => {
  test("stale expected_sync_token aborts with SyncTokenMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      reference_item_id: "n1",
      items: [{ content: "New child" }],
      position: "last_child",
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("SyncTokenMismatch");

    // Verify no nodes were created.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find(n => n.id === "n1")!;
    expect(n1.children).toEqual(["n1a", "n1b"]);
  });

  test("correct expected_sync_token succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const syncToken = makeSyncToken("doc1", doc.version);

    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      reference_item_id: "n1",
      items: [{ content: "New child" }],
      position: "last_child",
      expected_sync_token: syncToken,
    });
    expect(result.total_created).toBe(1);
    expect(result.sync_warning).toBeUndefined();
  });

  test("omitted expected_sync_token returns schema validation error", async () => {
    const result = await callTool(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      reference_item_id: "n1",
      items: [{ content: "New child" }],
      position: "last_child",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("expected_sync_token");
  });
});

// ═════════════════════════════════════════════════════════════════════
// delete_items version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("delete_items version guard", () => {
  test("stale expected_sync_token aborts with SyncTokenMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a"],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("SyncTokenMismatch");

    // Verify node was not deleted.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.some(n => n.id === "n1a")).toBe(true);
  });

  test("correct expected_sync_token succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const syncToken = makeSyncToken("doc1", doc.version);

    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a"],
      expected_sync_token: syncToken,
    });
    expect(result.deleted_count).toBe(1);
    expect(result.sync_warning).toBeUndefined();
  });

  test("omitted expected_sync_token returns schema validation error", async () => {
    const result = await callTool(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("expected_sync_token");
  });

  test("stale expected_sync_token aborts child promotion path", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("SyncTokenMismatch");

    // Verify node was not deleted.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.some(n => n.id === "n1")).toBe(true);
  });

  test("correct expected_sync_token succeeds for child promotion", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const syncToken = makeSyncToken("doc1", doc.version);

    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: syncToken,
    });
    expect(result.deleted_count).toBe(1);
    expect(result.promoted_children).toBe(2);
    expect(result.sync_warning).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// move_items version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("move_items version guard", () => {
  test("stale expected_sync_token aborts with SyncTokenMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "last_child" }],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("SyncTokenMismatch");

    // Verify node was not moved.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find(n => n.id === "n1")!;
    expect(n1.children).toContain("n1a");
  });

  test("correct expected_sync_token succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const syncToken = makeSyncToken("doc1", doc.version);

    const result = await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "last_child" }],
      expected_sync_token: syncToken,
    });
    expect(result.item_ids).toEqual(["n1a"]);
    expect(result.sync_warning).toBeUndefined();
  });

  test("omitted expected_sync_token returns schema validation error", async () => {
    const result = await callTool(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "last_child" }],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("expected_sync_token");
  });
});

// ═════════════════════════════════════════════════════════════════════
// Post-write concurrent modification detection
// ═════════════════════════════════════════════════════════════════════
describe("post-write concurrent modification detection", () => {
  test("clean write has no sync_warning", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: syncToken,
    });
    expect(result.sync_warning).toBeUndefined();
  });

  test("concurrent edit during write produces sync_warning", async () => {
    // Hook: simulate concurrent edit when editDocument is called.
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: syncToken,
    });

    expect(result.sync_warning).toBeDefined();
  });

  test("concurrent edit during insert produces sync_warning", async () => {
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      reference_item_id: "n1",
      items: [{ content: "New" }],
      position: "last_child",
      expected_sync_token: syncToken,
    });

    expect(result.sync_warning).toBeDefined();
  });

  test("concurrent edit during delete produces sync_warning", async () => {
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a"],
      expected_sync_token: syncToken,
    });

    expect(result.sync_warning).toBeDefined();
  });

  test("concurrent edit during move produces sync_warning", async () => {
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "last_child" }],
      expected_sync_token: syncToken,
    });

    expect(result.sync_warning).toBeDefined();
  });

  test("concurrent edit during multi-batch delete_items with child promotion", async () => {
    // delete_items with children: "promote" makes 2 editDocument calls.
    // Inject a concurrent edit on the first call. Total expected delta = 2
    // (move batch + delete batch), actual delta = 3 (2 + concurrent).
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: syncToken,
    });

    expect(result.sync_warning).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// CAS check fires with version 0
// ═════════════════════════════════════════════════════════════════════
describe("CAS check fires with sync token 0", () => {
  test("expected_sync_token 0 aborts with SyncTokenMismatch on fresh document", async () => {
    // A freshly created document starts at version 1, so passing sync token 0
    // should trigger the sync token mismatch guard.
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: "00000",
    });
    expect(err.error).toBe("SyncTokenMismatch");
  });
});

// ═════════════════════════════════════════════════════════════════════
// read_document sync_token field
// ═════════════════════════════════════════════════════════════════════
describe("read_document sync_token", () => {
  test("includes sync_token in response", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    expect(typeof result.sync_token).toBe("string");
    expect((result.sync_token as string).length).toBe(5);
  });

  test("sync_token changes after edits", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: syncToken,
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    expect(result.sync_token).not.toBe(syncToken);
  });
});
