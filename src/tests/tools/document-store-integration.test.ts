/**
 * Integration test: verifies that read_document after a write returns
 * fresh data (confirming the cache is invalidated on write).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
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
    expect(before.version).toBeDefined();

    // Edit a node.
    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Edited via integration test",
    });

    // Read again. The cache should have been invalidated by the edit,
    // so we get fresh data with the updated content.
    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    // Version should have advanced.
    expect(after.version as number).toBeGreaterThan(before.version as number);

    // The edited content should be visible in the node tree.
    const serialized = JSON.stringify(after.node);
    expect(serialized).toContain("Edited via integration test");
  });

  test("read after insert reflects the insert", async () => {
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Newly inserted node" }],
    });

    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    expect(after.version as number).toBeGreaterThan(before.version as number);
    const serialized = JSON.stringify(after.node);
    expect(serialized).toContain("Newly inserted node");
  });

  test("read after delete reflects the deletion", async () => {
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const serializedBefore = JSON.stringify(before.node);
    expect(serializedBefore).toContain("Third item");

    await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n3",
    });

    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    expect(after.version as number).toBeGreaterThan(before.version as number);
    const serializedAfter = JSON.stringify(after.node);
    expect(serializedAfter).not.toContain("Third item");
  });

  test("read after move reflects the new position", async () => {
    const before = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    // Move n3 to be the first child of root (before n1).
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "before",
    });

    const after = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });

    expect(after.version as number).toBeGreaterThan(before.version as number);

    // n3 ("Third item") should now be the first child of root.
    const root = after.node as Record<string, unknown>;
    const children = root.children as Array<Record<string, unknown>>;
    expect(children[0].content).toBe("Third item");
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

    expect(after.version as number).toBeGreaterThan(before.version as number);
    const serialized = JSON.stringify(after.node);
    expect(serialized).toContain("Inbox integration test item");
  });
});
