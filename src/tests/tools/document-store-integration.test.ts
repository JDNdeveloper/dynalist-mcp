/**
 * Integration test: verifies that read_document after a write returns
 * fresh data (confirming the cache is invalidated on write).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  getSyncToken,
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

describe("document store cache invalidation", () => {
  test("read after edit reflects the edit", async () => {
    // Read the document to populate the cache.
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    expect(before.sync_token).toBeDefined();

    // Edit a node.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "Edited via integration test" }],
    });

    // Read again. The cache should have been invalidated by the edit,
    // so we get fresh data with the updated content.
    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    // Sync token should have changed.
    expect(after.sync_token as string).not.toBe(before.sync_token as string);

    // The edited content should be visible in the node tree.
    const serialized = JSON.stringify(after.item);
    expect(serialized).toContain("Edited via integration test");
  });

  test("read after insert reflects the insert", async () => {
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Newly inserted node" }],
      position: "last_child",
    });

    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    expect(after.sync_token as string).not.toBe(before.sync_token as string);
    const serialized = JSON.stringify(after.item);
    expect(serialized).toContain("Newly inserted node");
  });

  test("read after delete reflects the deletion", async () => {
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const serializedBefore = JSON.stringify(before.item);
    expect(serializedBefore).toContain("Third item");

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      item_ids: ["n3"],
    });

    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    expect(after.sync_token as string).not.toBe(before.sync_token as string);
    const serializedAfter = JSON.stringify(after.item);
    expect(serializedAfter).not.toContain("Third item");
  });

  test("read after move reflects the new position", async () => {
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    // Move n3 to be the first child of root (before n1).
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "before" }],
    });

    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    expect(after.sync_token as string).not.toBe(before.sync_token as string);

    // n3 ("Third item") should now be the first child of root.
    const root = after.item as Record<string, unknown>;
    const children = root.children as Array<Record<string, unknown>>;
    expect(children[0].content).toBe("Third item");
  });

  test("writing to doc B does not invalidate cached doc A", async () => {
    // Read doc1 to populate the cache.
    const firstRead = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const doc1TokenBefore = firstRead.sync_token as string;

    // Write to doc2 (a different document).
    const doc2SyncToken = await getSyncToken(ctx.mcpClient, "doc2");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc2",
      expected_sync_token: doc2SyncToken,
      items: [{ item_id: "m1", content: "Edited in doc2" }],
    });

    // Read doc1 again. It should still return valid data.
    const secondRead = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    // Sync token should be the same since doc1 was not modified.
    expect(secondRead.sync_token as string).toBe(doc1TokenBefore);
    const serialized = JSON.stringify(secondRead.item);
    expect(serialized).toContain("First item");
  });

  test("read inbox after send_to_inbox reflects the new item", async () => {
    // Read the inbox document to populate the cache.
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "inbox_doc",
    });

    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Inbox integration test item",
    });

    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "inbox_doc",
    });

    expect(after.sync_token as string).not.toBe(before.sync_token as string);
    const serialized = JSON.stringify(after.item);
    expect(serialized).toContain("Inbox integration test item");
  });
});
