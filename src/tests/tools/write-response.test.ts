/**
 * Tests for the readback tree and sync_token returned by item write tools.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  getSyncToken,
  standardSetup,
  type TestContext,
} from "./test-helpers";
import type { DummyDynalistServer } from "../dummy-server";

let ctx: TestContext;

afterEach(async () => {
  await ctx.cleanup();
});

interface ReadbackNode {
  item_id: string;
  content: string;
  child_count?: number;
  children?: Array<ReadbackNode | { omitted: number }>;
}

function readbackOf(result: Record<string, unknown>): ReadbackNode {
  return result.readback as ReadbackNode;
}

/**
 * Render a readback tree the way the MCP instructions tell agents to: one
 * bullet line per item and one `...` line per omitted marker.
 */
function outlineOf(node: ReadbackNode, depth: number = 0): string[] {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}• ${node.content}`];
  for (const child of node.children ?? []) {
    if ("omitted" in child) {
      lines.push(`${indent}  ...`);
    } else {
      lines.push(...outlineOf(child, depth + 1));
    }
  }
  return lines;
}

// Every item with children must account for all of them: shown items plus
// omitted counts add up to child_count.
function expectChildCountsConsistent(node: ReadbackNode): void {
  if (!node.children) return;
  let total = 0;
  for (const child of node.children) {
    if ("omitted" in child) {
      total += child.omitted;
    } else {
      total += 1;
      expectChildCountsConsistent(child);
    }
  }
  expect(total).toBe(node.child_count!);
}

// A document whose root has ten leaf children (l0..l9), large enough that
// the readback is windowed instead of showing every child. l5 has eight
// children (c0..c7) for testing windows below a windowed ancestor.
function largeParentSetup(server: DummyDynalistServer): void {
  standardSetup(server);
  const leafIds = Array.from({ length: 10 }, (_, i) => `l${i}`);
  const nestedIds = Array.from({ length: 8 }, (_, i) => `c${i}`);
  server.addDocument("big", "Big Document", "folder_a", [
    server.makeNode("root", "Big Document", leafIds),
    ...leafIds.map((id) => server.makeNode(id, `Leaf ${id}`, id === "l5" ? nestedIds : [])),
    ...nestedIds.map((id) => server.makeNode(id, `Nested ${id}`, [])),
  ]);
}

describe("write response readback", () => {
  describe("with the standard document", () => {
    beforeEach(async () => {
      ctx = await createTestContext(standardSetup);
    });

    test("edit_items returns the tree from the root down to the edited item and a token matching read_document", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const result = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n1a", content: "Edited A" }],
        expected_sync_token: syncToken,
      });

      expect(outlineOf(readbackOf(result))).toEqual([
        "• Test Document",
        "  • First item",
        "    • Edited A",
        "    • Child B",
        "  ...",
      ]);
      expect(result.sync_token).toBe(await getSyncToken(ctx.mcpClient, "doc1"));
    });

    test("the returned sync_token is accepted by the next write without a read", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const first = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n1a", content: "First" }],
        expected_sync_token: syncToken,
      });
      const second = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n1a", content: "Second" }],
        expected_sync_token: first.sync_token,
      });

      expect(second.sync_warning).toBeUndefined();
      expect(outlineOf(readbackOf(second))).toContain("    • Second");
    });

    test("insert_items expands the full subtree of inserted items", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const result = await callToolOk(ctx.mcpClient, "insert_items", {
        file_id: "doc1",
        inserts: [{
          position: "last_child",
          reference_item_id: "n2",
          items: [{ content: "New", children: [{ content: "Kid", children: [{ content: "Grandkid" }] }] }],
        }],
        expected_sync_token: syncToken,
      });

      expect(outlineOf(readbackOf(result))).toEqual([
        "• Test Document",
        "  ...",
        "  • Second item",
        "    • Nested child",
        "    • New",
        "      • Kid",
        "        • Grandkid",
        "  ...",
      ]);
    });

    // The root has only three children, which would be shown in full if the
    // root were a changed parent. As an ancestor on the path it shows only
    // the child leading to the change.
    test("an insert below a small root shows only the path through the root", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const result = await callToolOk(ctx.mcpClient, "insert_items", {
        file_id: "doc1",
        inserts: [{ position: "last_child", reference_item_id: "n2", items: [{ content: "New" }] }],
        expected_sync_token: syncToken,
      });

      const root = readbackOf(result);
      expect(outlineOf(root)).toEqual([
        "• Test Document",
        "  ...",
        "  • Second item",
        "    • Nested child",
        "    • New",
        "  ...",
      ]);
      expectChildCountsConsistent(root);
    });

    test("delete_items shows the parent as a leaf when it loses all children", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const result = await callToolOk(ctx.mcpClient, "delete_items", {
        file_id: "doc1",
        item_ids: ["n2a"],
        expected_sync_token: syncToken,
      });

      const root = readbackOf(result);
      const secondItem = root.children![1] as ReadbackNode;
      expect(secondItem).toEqual({ item_id: "n2", content: "Second item" });
    });

    test("delete_items with promote shows the promoted children in the former parent's place", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const result = await callToolOk(ctx.mcpClient, "delete_items", {
        file_id: "doc1",
        item_ids: ["n1"],
        children: "promote",
        expected_sync_token: syncToken,
      });

      expect(outlineOf(readbackOf(result))).toEqual([
        "• Test Document",
        "  • Child A",
        "  • Child B",
        "  • Second item",
        "  • Third item",
      ]);
    });

    test("move_items shows both the source and destination parents in one tree", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const result = await callToolOk(ctx.mcpClient, "move_items", {
        file_id: "doc1",
        moves: [{ item_id: "n1a", reference_item_id: "n2", position: "last_child" }],
        expected_sync_token: syncToken,
      });

      expect(outlineOf(readbackOf(result))).toEqual([
        "• Test Document",
        "  • First item",
        "    • Child B",
        "  • Second item",
        "    • Nested child",
        "    • Child A",
        "  ...",
      ]);
    });

    test("reorder_items shows every child of the reordered parent", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      const result = await callToolOk(ctx.mcpClient, "reorder_items", {
        file_id: "doc1",
        reorders: [{ item_ids: ["n3", "n1", "n2"] }],
        expected_sync_token: syncToken,
      });

      expect(outlineOf(readbackOf(result))).toEqual([
        "• Test Document",
        "  • Third item",
        "  • First item",
        "  • Second item",
      ]);
    });

    // The readback happens after the guard's post-write check, so an edit
    // landing between the two is only visible to the readback's version.
    test("a concurrent edit before the readback omits readback and sync_token", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      ctx.server.onNextRead((fileId) => ctx.server.simulateConcurrentEdit(fileId));

      const result = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "doc1",
        items: [{ item_id: "n1a", content: "Edited" }],
        expected_sync_token: syncToken,
      });

      expect(result.sync_warning).toBeDefined();
      expect(result.sync_token).toBeUndefined();
      expect(result.readback).toBeUndefined();
    });
  });

  describe("with a parent large enough to window", () => {
    beforeEach(async () => {
      ctx = await createTestContext(largeParentSetup);
    });

    test("separate changed positions are separated by one omitted marker per gap", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "big");
      const result = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "big",
        items: [{ item_id: "l2", content: "Edited 2" }, { item_id: "l7", content: "Edited 7" }],
        expected_sync_token: syncToken,
      });

      const root = readbackOf(result);
      expect(outlineOf(root)).toEqual([
        "• Big Document",
        "  ...",
        "  • Leaf l1",
        "  • Edited 2",
        "  • Leaf l3",
        "  ...",
        "  • Leaf l6",
        "  • Edited 7",
        "  • Leaf l8",
        "  ...",
      ]);
      expect(root.child_count).toBe(10);
      expectChildCountsConsistent(root);
    });

    // An ancestor on the path shows only the child leading to the change,
    // not its own adjacent siblings.
    test("an edit below a windowed ancestor shows only the path through that ancestor", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "big");
      const result = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "big",
        items: [{ item_id: "c4", content: "Edited c4" }],
        expected_sync_token: syncToken,
      });

      const root = readbackOf(result);
      expect(outlineOf(root)).toEqual([
        "• Big Document",
        "  ...",
        "  • Leaf l5",
        "    ...",
        "    • Nested c3",
        "    • Edited c4",
        "    • Nested c5",
        "    ...",
        "  ...",
      ]);
      expectChildCountsConsistent(root);
    });

    test("delete_items shows the siblings on both sides of each removed position", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "big");
      const result = await callToolOk(ctx.mcpClient, "delete_items", {
        file_id: "big",
        item_ids: ["l3", "l4"],
        expected_sync_token: syncToken,
      });

      expect(outlineOf(readbackOf(result))).toEqual([
        "• Big Document",
        "  ...",
        "  • Leaf l2",
        "  • Leaf l5",
        "  ...",
      ]);
    });

    // The second move shifts the first move's source gap left by one, so the
    // gap must be located in the final document, not at its original index.
    test("move_items shows both neighbours of each source gap after several moves out of one parent", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "big");
      const result = await callToolOk(ctx.mcpClient, "move_items", {
        file_id: "big",
        moves: [
          { item_id: "l7", reference_item_id: "l0", position: "last_child" },
          { item_id: "l1", reference_item_id: "l0", position: "last_child" },
        ],
        expected_sync_token: syncToken,
      });

      expect(outlineOf(readbackOf(result))).toEqual([
        "• Big Document",
        "  • Leaf l0",
        "    • Leaf l7",
        "    • Leaf l1",
        "  • Leaf l2",
        "  ...",
        "  • Leaf l6",
        "  • Leaf l8",
        "  ...",
      ]);
    });

    test("the last batch member's sync_token is accepted by the next write", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "big");
      await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "big",
        items: [{ item_id: "l1", content: "Batch 0" }],
        expected_sync_token: syncToken,
        batch_index: 0,
      });
      const last = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "big",
        items: [{ item_id: "l2", content: "Batch 1" }],
        expected_sync_token: syncToken,
        batch_index: 1,
      });
      const next = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "big",
        items: [{ item_id: "l3", content: "After batch" }],
        expected_sync_token: last.sync_token,
      });

      expect(next.sync_warning).toBeUndefined();
    });
  });

  describe("with a low size threshold", () => {
    beforeEach(async () => {
      ctx = await createTestContext(largeParentSetup, {
        sizeWarning: { warningTokenThreshold: 10, maxTokenThreshold: 24500 },
      });
    });

    test("an oversized readback is replaced by a warning while sync_token is kept", async () => {
      const syncToken = await getSyncToken(ctx.mcpClient, "big");
      const result = await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "big",
        items: [{ item_id: "l2", content: "Edited" }],
        expected_sync_token: syncToken,
      });

      expect(result.readback).toBeUndefined();
      expect(result.warning).toBeDefined();
      expect(result.sync_token).toBe(await getSyncToken(ctx.mcpClient, "big"));
    });
  });
});
