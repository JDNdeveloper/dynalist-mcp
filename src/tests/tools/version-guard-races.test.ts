/**
 * Race simulation and edge case tests for the version guard. Uses
 * dummy server hooks to inject concurrent modifications at precise
 * points in the tool's execution.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { makeSyncToken } from "../../sync-token";
import {
  createTestContext,
  callTool,
  callToolOk,
  callToolError,
  getSyncToken,
  parseErrorContent,
  standardSetup,
  type TestContext,
} from "./test-helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ═════════════════════════════════════════════════════════════════════
// Race simulation: insert_items
// ═════════════════════════════════════════════════════════════════════
describe("insert_items race simulation", () => {
  test("last_child multi-item race: concurrent child added", async () => {
    // After insert_items reads the parent's child count but before the
    // write, another client adds a child. The version guard detects the
    // concurrent modification.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const n1 = doc.nodes.find(n => n.id === "n1")!;
      const intruder = ctx.server.makeNode("intruder", "Intruder", []);
      doc.nodes.push(intruder);
      n1.children!.push("intruder");
      doc.version++;
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      items: [{ content: "Item A" }, { content: "Item B" }],
      position: "last_child",
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.created_count).toBe(2);
  });

  test("first_child multi-item race: concurrent insert at position 0", async () => {
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const n1 = doc.nodes.find(n => n.id === "n1")!;
      const intruder = ctx.server.makeNode("intruder", "Intruder", []);
      doc.nodes.push(intruder);
      n1.children!.unshift("intruder");
      doc.version++;
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      items: [{ content: "First A" }, { content: "First B" }],
      position: "first_child",
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.created_count).toBe(2);
  });

  test("after/before race: sibling reorder during position resolution", async () => {
    // After the tool reads to resolve the reference node's position but
    // before the write, another client reorders siblings.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const root = doc.nodes.find(n => n.id === "root")!;
      // Reverse the children order to simulate a reorder.
      root.children!.reverse();
      doc.version++;
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      items: [{ content: "After n1" }],
      position: "after",
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.created_count).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Race simulation: delete_items
// ═════════════════════════════════════════════════════════════════════
describe("delete_items race simulation", () => {
  test("subtree race: new child added during subtree enumeration", async () => {
    // After delete_items reads to enumerate the subtree but before the
    // delete call, another client adds a child under the target.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const n2 = doc.nodes.find(n => n.id === "n2")!;
      const newChild = ctx.server.makeNode("n2_new", "New under n2", []);
      doc.nodes.push(newChild);
      n2.children!.push("n2_new");
      doc.version++;
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      item_ids: ["n2"],
    });

    // The delete succeeded but missed the new child (orphaned).
    expect(result.sync_warning).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Race simulation: move_items
// ═════════════════════════════════════════════════════════════════════
describe("move_items race simulation", () => {
  test("index race: sibling reorder during move computation", async () => {
    // After move_items reads and computes the target index but before
    // the move call, another client reorders siblings.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const root = doc.nodes.find(n => n.id === "root")!;
      root.children!.reverse();
      doc.version++;
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "after" }],
    });

    expect(result.sync_warning).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Edge cases
// ═════════════════════════════════════════════════════════════════════
describe("version guard edge cases", () => {
  test("version goes backwards (unexpected) produces warning", async () => {
    // Simulate a version that goes backwards between pre and post check.
    // This is abnormal but the guard should handle it gracefully.
    ctx.server.onNextEdit((fileId) => {
      // After the edit, manually set version to something lower.
      const doc = ctx.server.documents.get(fileId)!;
      // The edit will increment version. Set it so that post-check sees
      // a lower version than pre-check. We decrement by 5 to overcome
      // the +1 from the edit itself.
      doc.version -= 5;
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "test" }],
    });

    // Negative delta != 1, so a warning should be produced.
    expect(result.sync_warning).toBeDefined();
  });

  test("operations on different documents have independent version tracking", async () => {
    // Edit doc1, verify its version changes independently of doc2.
    const doc1Before = ctx.server.documents.get("doc1")!.version;
    const doc2Before = ctx.server.documents.get("doc2")!.version;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "Updated doc1" }],
    });

    const doc1After = ctx.server.documents.get("doc1")!.version;
    const doc2After = ctx.server.documents.get("doc2")!.version;

    expect(doc1After).toBe(doc1Before + 1);
    expect(doc2After).toBe(doc2Before);
  });

  test("insert_items with nested tree counts batches across levels", async () => {
    // A 3-level tree should produce 3 editDocument calls.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      position: "last_child",
      items: [{
        content: "Level 1",
        children: [{
          content: "Level 2",
          children: [{ content: "Level 3" }],
        }],
      }],
    });

    expect(result.created_count).toBe(3);
    expect(result.sync_warning).toBeUndefined();
  });

  test("concurrent edit during multi-level insert produces warning", async () => {
    // Inject concurrent edit on first editDocument call. The insert
    // will make 3 API calls (3 levels), but version advances by 4.
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      position: "last_child",
      items: [{
        content: "Level 1",
        children: [{
          content: "Level 2",
          children: [{ content: "Level 3" }],
        }],
      }],
    });

    expect(result.sync_warning).toBeDefined();
  });

  test("partial write failure does not prevent reading partial writes", async () => {
    // Warm the cache so the store has a cached version.
    await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });

    // Insert a 3-level hierarchy, failing after 1 successful batch. Level
    // 0 succeeds (creates 1 node), level 1 fails. The PartialWriteError
    // propagates through the version guard, which invalidates the cache in
    // its finally block so subsequent reads see the partial writes.
    //
    // NOTE: the document store's warm-path version check also self-heals
    // stale cache entries, so this test passes even without explicit
    // invalidation. It documents the expected behavior rather than
    // regressing on the finally-block fix specifically.
    ctx.server.failEditAfterNCalls(1);

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callTool(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      position: "last_child",
      items: [{
        content: "Partial parent",
        children: [{ content: "Partial child" }],
      }],
    });

    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("PartialWrite");

    // A subsequent read should reflect the partial write (the level-0
    // node was created even though the level-1 insert failed).
    const readResult = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      item_id: "n1",
    });
    const children = (readResult.item as Record<string, unknown>).children as Record<string, unknown>[];
    const contents = children.map(c => c.content);
    expect(contents).toContain("Partial parent");
  });

  test("expected_sync_token with concurrent edit: abort before write", async () => {
    // Simulate a concurrent edit that happens between the agent's
    // read_document and the write tool call. The pre-write check
    // should detect the stale sync token and abort.
    const doc = ctx.server.documents.get("doc1")!;
    const staleToken = makeSyncToken("doc1", doc.version);

    // Simulate someone else editing the document.
    ctx.server.simulateConcurrentEdit("doc1");

    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Should not apply" }],
      expected_sync_token: staleToken,
    });

    expect(err.error).toBe("SyncTokenMismatch");
  });
});
