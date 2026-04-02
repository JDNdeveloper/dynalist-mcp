import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
import { makeSyncToken } from "../../sync-token";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ─── edit_items ───────────────────────────────────────────────────────

describe("edit_items", () => {
  test("updates content of a single node", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "Updated content" }],
    });
    expect(result.file_id).toBe("doc1");
    expect(result.edited_count).toBe(1);

    // Verify the change persisted.
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.content).toBe("Updated content");
  });

  test("edits multiple nodes in one call", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [
        { item_id: "n1", content: "First updated" },
        { item_id: "n2", content: "Second updated" },
      ],
    });
    expect(result.edited_count).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")!.content).toBe("First updated");
    expect(doc.nodes.find((n) => n.id === "n2")!.content).toBe("Second updated");
  });

  test("edits multiple nodes with different fields per node", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    const n2 = doc.nodes.find((n) => n.id === "n2")!;
    const n1OriginalContent = n1.content;
    const n2OriginalContent = n2.content;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [
        { item_id: "n1", heading: "h2", color: "yellow" },
        { item_id: "n2", note: "new note", show_checkbox: true },
      ],
    });
    expect(result.edited_count).toBe(2);
    // Verify each node only got the fields specified.
    expect(n1.content).toBe(n1OriginalContent);
    expect(n1.heading).toBe(2);
    expect(n1.color).toBe(3);
    expect(n2.content).toBe(n2OriginalContent);
    expect(n2.note).toBe("new note");
    expect(n2.checkbox).toBe(true);
  });

  test("partial update: only specified fields change", async () => {
    // Set initial state.
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "original note";

    // Edit only content, not note.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "New content" }],
    });

    expect(node.content).toBe("New content");
    expect(node.note).toBe("original note");
  });

  test("empty content is allowed", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.content).toBe("");
  });

  test("empty note clears it", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "some note";

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", note: "" }],
    });
    expect(node.note).toBe("");
  });

  test("sets heading and color", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", heading: "h2", color: "yellow" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.heading).toBe(2);
    expect(node.color).toBe(3);
  });

  test("empty nodes array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: "zzzzz",
      items: [],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("nonexistent document returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "nonexistent",
      expected_sync_token: "zzzzz",
      items: [{ item_id: "n1", content: "test" }],
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent item returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: makeSyncToken("doc1", 1),
      items: [{ item_id: "nonexistent", content: "test" }],
    });
    expect(err.error).toBe("ItemNotFound");
  });

  test("nonexistent item returns ItemNotFound with specific item ID", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "xyz_bad", content: "test" }],
    });
    expect(err.error).toBe("ItemNotFound");
    expect(err.message).toContain("xyz_bad");
  });

  test("node with only item_id and no other fields returns InvalidInput", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1" }],
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("no fields to edit");
  });

  test("note content fidelity: multi-line with code blocks round-trips", async () => {
    const complexNote = "Line 1\n\n```python\ndef foo():\n    return 42\n```\n\nLine after code";
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", note: complexNote }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.note).toBe(complexNote);
  });

  // ─── 10b: field independence ────────────────────────────────────────

  test("edit only content preserves note, heading, color, show_checkbox, checked", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "keep this note";
    node.heading = 2;
    node.color = 4;
    node.checkbox = true;
    node.checked = true;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "Changed content only" }],
    });

    expect(node.content).toBe("Changed content only");
    expect(node.note).toBe("keep this note");
    expect(node.heading).toBe(2);
    expect(node.color).toBe(4);
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(true);
  });

  test("edit only note preserves content", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    const originalContent = node.content;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", note: "brand new note" }],
    });

    expect(node.content).toBe(originalContent);
    expect(node.note).toBe("brand new note");
  });

  test("edit only heading preserves everything else", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "my note";
    node.color = 5;
    const originalContent = node.content;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", heading: "h3" }],
    });

    expect(node.content).toBe(originalContent);
    expect(node.note).toBe("my note");
    expect(node.heading).toBe(3);
    expect(node.color).toBe(5);
  });

  test("edit only color preserves everything else", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.heading = 1;
    const originalContent = node.content;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", color: "purple" }],
    });

    expect(node.content).toBe(originalContent);
    expect(node.heading).toBe(1);
    expect(node.color).toBe(6);
  });

  test("edit only show_checkbox preserves everything else", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "note here";
    const originalContent = node.content;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", show_checkbox: true }],
    });

    expect(node.content).toBe(originalContent);
    expect(node.note).toBe("note here");
    expect(node.checkbox).toBe(true);
  });

  test("edit only checked preserves everything else", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.checkbox = true;
    node.note = "keep me";
    const originalContent = node.content;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", checked: true }],
    });

    expect(node.content).toBe(originalContent);
    expect(node.note).toBe("keep me");
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(true);
  });

  // ─── 10c: specific field values ─────────────────────────────────────

  test("heading: 'none' removes heading", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.heading = 2;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", heading: "none" }],
    });

    expect(node.heading).toBeUndefined();
  });

  test("heading: h1, h2, h3 all set correctly", async () => {
    const headings: Array<[string, number]> = [["h1", 1], ["h2", 2], ["h3", 3]];
    for (const [str, num] of headings) {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "doc1",
        expected_sync_token: syncToken,
        items: [{ item_id: "n1", heading: str }],
      });
      const doc = ctx.server.documents.get("doc1")!;
      const node = doc.nodes.find((n) => n.id === "n1")!;
      expect(node.heading).toBe(num);
    }
  });

  test("color: 'none' removes color", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.color = 3;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", color: "none" }],
    });

    expect(node.color).toBeUndefined();
  });

  test("all color values set correctly", async () => {
    const colors: Array<[string, number]> = [
      ["red", 1], ["orange", 2], ["yellow", 3],
      ["green", 4], ["blue", 5], ["purple", 6],
    ];
    for (const [str, num] of colors) {
      const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
      await callToolOk(ctx.mcpClient, "edit_items", {
        file_id: "doc1",
        expected_sync_token: syncToken,
        items: [{ item_id: "n1", color: str }],
      });
      const doc = ctx.server.documents.get("doc1")!;
      const node = doc.nodes.find((n) => n.id === "n1")!;
      expect(node.color).toBe(num);
    }
  });

  test("show_checkbox: false removes checkbox", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.checkbox = true;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", show_checkbox: false }],
    });

    expect(node.checkbox).toBe(false);
  });

  test("checked: true with show_checkbox: true marks node as checked", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", show_checkbox: true, checked: true }],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(true);
  });

  test("checked: false unchecks the node", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.checked = true;
    node.checkbox = true;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", checked: false }],
    });

    expect(node.checked).toBe(false);
  });

  // ─── 10d: response shape ────────────────────────────────────────────

  test("response includes file_id and edited_count", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "shape test" }],
    });

    expect(result.file_id).toBe("doc1");
    expect(result.edited_count).toBe(1);
  });

  // ─── 10e: error codes ──────────────────────────────────────────────

  test("nonexistent document returns NotFound error code", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "no_such_doc",
      expected_sync_token: "zzzzz",
      items: [{ item_id: "n1", content: "test" }],
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent item returns ItemNotFound error code", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: makeSyncToken("doc1", 1),
      items: [{ item_id: "no_such_node", content: "test" }],
    });
    expect(err.error).toBe("ItemNotFound");
  });

  // ─── 10f: bulk-specific behavior ─────────────────────────────────

  test("state round-trip: edit then read_document to verify", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [
        { item_id: "n1", content: "Round-trip A", note: "note A" },
        { item_id: "n2", content: "Round-trip B", heading: "h2" },
      ],
    });

    const doc = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const children = (doc.item as { children: Array<{ item_id: string; content: string; note?: string; heading?: string }> }).children;
    const n1 = children.find((c) => c.item_id === "n1")!;
    const n2 = children.find((c) => c.item_id === "n2")!;
    expect(n1.content).toBe("Round-trip A");
    expect(n1.note).toBe("note A");
    expect(n2.content).toBe("Round-trip B");
    expect(n2.heading).toBe("h2");
  });

  test("duplicate item_id in array applies last-write-wins", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [
        { item_id: "n1", content: "First write" },
        { item_id: "n1", content: "Second write" },
      ],
    });
    expect(result.edited_count).toBe(2);
    // The Dynalist API processes changes sequentially, so the second
    // write should win.
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.content).toBe("Second write");
  });
});

// ─── insert_items ────────────────────────────────────────────────────

describe("insert_items", () => {
  test("inserts flat list", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "item1" }, { content: "item2" }, { content: "item3" }],
      position: "last_child",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.created_count).toBe(3);
    expect(result.root_item_ids).toBeDefined();
    expect((result.root_item_ids as string[]).length).toBe(3);
  });

  test("inserts nested hierarchy", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      position: "last_child",
      items: [{
        content: "parent",
        children: [{
          content: "child",
          children: [{ content: "grandchild" }],
        }],
      }],
    });
    expect(result.created_count).toBe(3);

    // Verify the tree structure in the dummy server.
    const doc = ctx.server.documents.get("doc1")!;
    const parentNode = doc.nodes.find((n) => n.content === "parent")!;
    expect(parentNode.children!.length).toBe(1);
    const childNode = doc.nodes.find((n) => n.id === parentNode.children![0])!;
    expect(childNode.content).toBe("child");
    expect(childNode.children!.length).toBe(1);
  });

  test("first_child position", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "top item" }],
      position: "first_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const firstChild = doc.nodes.find((n) => n.id === root.children![0])!;
    expect(firstChild.content).toBe("top item");
  });

  test("omitting reference_item_id inserts at document root", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "root-level item" }],
      position: "last_child",
    });
    expect(result.created_count).toBe(1);
  });

  test("empty nodes array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: "zzzzz",
      items: [],
      position: "last_child",
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── hierarchy fidelity ────────────────────────────────────────────

  test("3-level hierarchy: parent > child > grandchild", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      position: "last_child",
      items: [{
        content: "level1",
        children: [{
          content: "level2",
          children: [{ content: "level3" }],
        }],
      }],
    });
    expect(result.created_count).toBe(3);

    const doc = ctx.server.documents.get("doc1")!;
    const l1 = doc.nodes.find((n) => n.content === "level1")!;
    expect(l1.children!.length).toBe(1);
    const l2 = doc.nodes.find((n) => n.id === l1.children![0])!;
    expect(l2.content).toBe("level2");
    expect(l2.children!.length).toBe(1);
    const l3 = doc.nodes.find((n) => n.id === l2.children![0])!;
    expect(l3.content).toBe("level3");
  });

  test("4-level hierarchy with multiple branches preserves ordering", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      position: "last_child",
      items: [
        {
          content: "A",
          children: [
            {
              content: "A1",
              children: [{
                content: "A1a",
                children: [{ content: "A1a-deep" }],
              }],
            },
            { content: "A2" },
          ],
        },
        {
          content: "B",
          children: [{ content: "B1" }],
        },
      ],
    });
    expect(result.created_count).toBe(7);

    const doc = ctx.server.documents.get("doc1")!;
    const nodeA = doc.nodes.find((n) => n.content === "A")!;
    expect(nodeA.children!.length).toBe(2);

    const nodeA1 = doc.nodes.find((n) => n.id === nodeA.children![0])!;
    expect(nodeA1.content).toBe("A1");
    const nodeA2 = doc.nodes.find((n) => n.id === nodeA.children![1])!;
    expect(nodeA2.content).toBe("A2");

    const nodeA1a = doc.nodes.find((n) => n.id === nodeA1.children![0])!;
    expect(nodeA1a.content).toBe("A1a");
    expect(nodeA1a.children!.length).toBe(1);

    const nodeB = doc.nodes.find((n) => n.content === "B")!;
    expect(nodeB.children!.length).toBe(1);
    const nodeB1 = doc.nodes.find((n) => n.id === nodeB.children![0])!;
    expect(nodeB1.content).toBe("B1");
  });

  test("multiple top-level items each with children", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      position: "last_child",
      items: [
        { content: "Parent1", children: [{ content: "Child1a" }, { content: "Child1b" }] },
        { content: "Parent2", children: [{ content: "Child2a" }] },
      ],
    });
    expect(result.created_count).toBe(5);
    expect((result.root_item_ids as string[]).length).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    const p1 = doc.nodes.find((n) => n.content === "Parent1")!;
    expect(p1.children!.length).toBe(2);
    const p2 = doc.nodes.find((n) => n.content === "Parent2")!;
    expect(p2.children!.length).toBe(1);
  });

  test("mixed depths: some branches deeper than others", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      position: "last_child",
      items: [
        { content: "Shallow" },
        {
          content: "Deep",
          children: [{
            content: "D1",
            children: [{
              content: "D2",
              children: [{ content: "D3" }],
            }],
          }],
        },
      ],
    });
    expect(result.created_count).toBe(5);

    const doc = ctx.server.documents.get("doc1")!;
    const shallow = doc.nodes.find((n) => n.content === "Shallow")!;
    expect(shallow.children!.length).toBe(0);
    const deep = doc.nodes.find((n) => n.content === "Deep")!;
    expect(deep.children!.length).toBe(1);
  });

  // ─── position behavior ────────────────────────────────────────────

  test("last_child appends to end of parent children", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalLastChildId = root.children![root.children!.length - 1];

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "appended item" }],
      position: "last_child",
    });

    // The new node should be after the original last child.
    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    const newLastChildId = rootAfter.children![rootAfter.children!.length - 1];
    const newLastChild = doc.nodes.find((n) => n.id === newLastChildId)!;
    expect(newLastChild.content).toBe("appended item");
    expect(newLastChildId).not.toBe(originalLastChildId);
  });

  test("first_child prepends to start of parent children", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalFirstChildId = root.children![0];

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "prepended item" }],
      position: "first_child",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    const newFirstChildId = rootAfter.children![0];
    const newFirstChild = doc.nodes.find((n) => n.id === newFirstChildId)!;
    expect(newFirstChild.content).toBe("prepended item");

    // Original first child should still be present.
    expect(rootAfter.children).toContain(originalFirstChildId);
  });

  test("last_child with multiple items preserves input order", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalChildCount = root.children!.length;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Order A" }, { content: "Order B" }, { content: "Order C" }],
      position: "last_child",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    expect(rootAfter.children!.length).toBe(originalChildCount + 3);

    // Items should appear in input order at the end.
    const newChildren = rootAfter.children!.slice(originalChildCount);
    const contents = newChildren.map(id => doc.nodes.find((n) => n.id === id)!.content);
    expect(contents).toEqual(["Order A", "Order B", "Order C"]);
  });

  test("last_child with multiple items under leaf node succeeds", async () => {
    // Regression: the real Dynalist API omits `children` for leaf nodes.
    // Inserting multiple items last_child under a leaf resolves the
    // parent's child count, which must handle a missing `children` field.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1a",
      items: [{ content: "Leaf A" }, { content: "Leaf B" }],
      position: "last_child",
    });

    expect(result.created_count).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    const n1a = doc.nodes.find(n => n.id === "n1a")!;
    expect(n1a.children!.length).toBe(2);
  });

  test("first_child with multiple items preserves input order", async () => {
    const doc = ctx.server.documents.get("doc1")!;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "First A" }, { content: "First B" }, { content: "First C" }],
      position: "first_child",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;

    // Items should appear in input order at the start.
    const firstThree = rootAfter.children!.slice(0, 3);
    const contents = firstThree.map(id => doc.nodes.find((n) => n.id === id)!.content);
    expect(contents).toEqual(["First A", "First B", "First C"]);
  });

  test("existing children preserved after insert", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalChildren = [...root.children!];

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "new item" }],
      position: "last_child",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    for (const childId of originalChildren) {
      expect(rootAfter.children).toContain(childId);
    }
  });

  // ─── per-node fields ──────────────────────────────────────────────

  test("node with note", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Noted item", note: "This is a note" }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Noted item")!;
    expect(newNode.note).toBe("This is a note");
  });

  test("node with show_checkbox and checked", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Todo", show_checkbox: true, checked: false }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Todo")!;
    expect(newNode.checkbox).toBe(true);
    expect(newNode.checked).toBe(false);
  });

  test("checked: true without checkbox does not add a checkbox", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Checked no checkbox", checked: true }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Checked no checkbox")!;
    expect(newNode.checked).toBe(true);
    expect(newNode.checkbox).toBeUndefined();
  });

  test("show_checkbox: false is preserved on insert", async () => {
    // Regression: a truthy check previously dropped checkbox: false.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "No checkbox explicit", show_checkbox: false }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No checkbox explicit")!;
    expect(newNode.checkbox).toBe(false);
  });

  test("heading is included on the inserted node", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Heading node", heading: "h2" }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Heading node")!;
    expect(newNode.heading).toBe(2);
  });

  test("heading 'none' is passed through to the inserted node", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "No heading node", heading: "none" }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No heading node")!;
    expect(newNode.heading).toBe(0);
  });

  test("color is included on the inserted node", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Colored node", color: "yellow" }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Colored node")!;
    expect(newNode.color).toBe(3);
  });

  test("color 'none' is passed through to the inserted node", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "No color node", color: "none" }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No color node")!;
    expect(newNode.color).toBe(0);
  });

  test("multiline content round-trips", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Line 1\nLine 2\nLine 3" }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Line 1\nLine 2\nLine 3")!;
    expect(newNode).toBeDefined();
  });

  test("multiline note round-trips", async () => {
    const noteContent = "First line\n\n```python\ndef foo():\n    return 42\n```";
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "Code item", note: noteContent }],
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Code item")!;
    expect(newNode.note).toBe(noteContent);
  });

  test("per-node fields on children in hierarchy", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      position: "last_child",
      items: [{
        content: "Parent",
        heading: "h1",
        children: [{
          content: "Child",
          note: "child note",
          color: "blue",
          show_checkbox: true,
          checked: true,
        }],
      }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const parent = doc.nodes.find((n) => n.content === "Parent")!;
    expect(parent.heading).toBe(1);
    const child = doc.nodes.find((n) => n.id === parent.children![0])!;
    expect(child.content).toBe("Child");
    expect(child.note).toBe("child note");
    expect(child.color).toBe(5);
    expect(child.checkbox).toBe(true);
    expect(child.checked).toBe(true);
  });

  // ─── partial failure ──────────────────────────────────────────────

  test("partial failure returns PartialWrite error with reread guidance", async () => {
    // Insert a 4-level deep hierarchy. Fail after 2 successful editDocument
    // calls, so levels 0 and 1 succeed but level 2 fails.
    ctx.server.failEditAfterNCalls(2);

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callTool(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      position: "last_child",
      items: [{
        content: "A",
        children: [{
          content: "B",
          children: [{
            content: "C",
            children: [{ content: "D" }],
          }],
        }],
      }],
    });

    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("PartialWrite");
    expect(parsedError.file_id).toBe("doc1");
    expect(parsedError.message).toContain("read_document");
  });

  test("partial failure persists nodes inserted before the fault", async () => {
    // Same 4-level hierarchy, fail after 2 levels.
    ctx.server.failEditAfterNCalls(2);

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callTool(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      position: "last_child",
      items: [{
        content: "PersistA",
        children: [{
          content: "PersistB",
          children: [{
            content: "PersistC",
            children: [{ content: "PersistD" }],
          }],
        }],
      }],
    });

    // Levels 0 and 1 should have been committed to the document.
    const doc = ctx.server.documents.get("doc1")!;
    const nodeA = doc.nodes.find((n) => n.content === "PersistA");
    const nodeB = doc.nodes.find((n) => n.content === "PersistB");
    const nodeC = doc.nodes.find((n) => n.content === "PersistC");
    const nodeD = doc.nodes.find((n) => n.content === "PersistD");

    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();
    expect(nodeC).toBeUndefined();
    expect(nodeD).toBeUndefined();

    // Verify the parent-child relationship was established.
    expect(nodeA!.children!.length).toBe(1);
    expect(nodeA!.children![0]).toBe(nodeB!.id);
  });

  // ─── response shape ───────────────────────────────────────────────

  test("response includes file_id, created_count, root_item_ids", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "shape test a" }, { content: "shape test b" }],
      position: "last_child",
    });

    expect(result.file_id).toBe("doc1");
    expect(result.created_count).toBe(2);
    expect(Array.isArray(result.root_item_ids)).toBe(true);
    expect((result.root_item_ids as string[]).length).toBe(2);
  });

  // ─── sibling-relative positioning (after/before) ─────────────────

  test("insert after a sibling", async () => {
    // root has children: n1, n2, n3. Insert after n1.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "After n1" }],
      reference_item_id: "n1",
      position: "after",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children!.indexOf("n1");
    const insertedId = root.children![n1Index + 1];
    const inserted = doc.nodes.find((n) => n.id === insertedId)!;
    expect(inserted.content).toBe("After n1");
  });

  test("insert before a sibling", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "Before n2" }],
      reference_item_id: "n2",
      position: "before",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n2Index = root.children!.indexOf("n2");
    const insertedId = root.children![n2Index - 1];
    const inserted = doc.nodes.find((n) => n.id === insertedId)!;
    expect(inserted.content).toBe("Before n2");
  });

  test("insert after the last sibling appends at end", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const rootBefore = doc.nodes.find((n) => n.id === "root")!;
    const childCountBefore = rootBefore.children!.length;

    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "After last" }],
      reference_item_id: "n3",
      position: "after",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    expect(rootAfter.children!.length).toBe(childCountBefore + 1);
    const lastChildId = rootAfter.children![rootAfter.children!.length - 1];
    const lastChild = doc.nodes.find((n) => n.id === lastChildId)!;
    expect(lastChild.content).toBe("After last");
  });

  test("insert before the first sibling places at index 0", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "Before first" }],
      reference_item_id: "n1",
      position: "before",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const firstChildId = root.children![0];
    const firstChild = doc.nodes.find((n) => n.id === firstChildId)!;
    expect(firstChild.content).toBe("Before first");
  });

  test("insert multiple top-level nodes after a sibling preserves order", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "Multi A" }, { content: "Multi B" }, { content: "Multi C" }],
      reference_item_id: "n1",
      position: "after",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children!.indexOf("n1");
    const insertedA = doc.nodes.find((n) => n.id === root.children![n1Index + 1])!;
    const insertedB = doc.nodes.find((n) => n.id === root.children![n1Index + 2])!;
    const insertedC = doc.nodes.find((n) => n.id === root.children![n1Index + 3])!;
    expect(insertedA.content).toBe("Multi A");
    expect(insertedB.content).toBe("Multi B");
    expect(insertedC.content).toBe("Multi C");
  });

  test("insert hierarchy after a sibling preserves tree structure", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{
        content: "Hier parent",
        children: [{ content: "Hier child" }],
      }],
      reference_item_id: "n2",
      position: "after",
    });

    expect(result.created_count).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    const parent = doc.nodes.find((n) => n.content === "Hier parent")!;
    expect(parent.children!.length).toBe(1);
    const child = doc.nodes.find((n) => n.id === parent.children![0])!;
    expect(child.content).toBe("Hier child");
  });

  test("after position infers parent from reference node", async () => {
    // n1 has children n1a, n1b. Insert after n1a; parent is inferred as n1.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "After n1a" }],
      reference_item_id: "n1a",
      position: "after",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    const n1aIndex = n1.children!.indexOf("n1a");
    const insertedId = n1.children![n1aIndex + 1];
    const inserted = doc.nodes.find((n) => n.id === insertedId)!;
    expect(inserted.content).toBe("After n1a");
  });

  // ─── sibling-relative positioning: validation errors ─────────────

  test("after without reference_item_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: "zzzzz",
      items: [{ content: "test" }],
      position: "after",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("before without reference_item_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: "zzzzz",
      items: [{ content: "test" }],
      position: "before",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("reference_item_id with first_child inserts as child", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "first child of n1" }],
      reference_item_id: "n1",
      position: "first_child",
    });
    expect(result.created_count).toBe(1);

    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    const firstChildId = n1.children![0];
    const firstChild = doc.nodes.find((n) => n.id === firstChildId)!;
    expect(firstChild.content).toBe("first child of n1");
  });

  test("reference_item_id with last_child inserts as child", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "last child of n1" }],
      reference_item_id: "n1",
      position: "last_child",
    });
    expect(result.created_count).toBe(1);

    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    const lastChildId = n1.children![n1.children!.length - 1];
    const lastChild = doc.nodes.find((n) => n.id === lastChildId)!;
    expect(lastChild.content).toBe("last child of n1");
  });

  test("after/before with root node as reference returns error", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const err = await callToolError(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "test" }],
      reference_item_id: "root",
      position: "after",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("root item");
  });

  test("before with root node as reference returns error", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const err = await callToolError(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "test" }],
      reference_item_id: "root",
      position: "before",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("root item");
  });

  test("nonexistent reference_item_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: makeSyncToken("doc1", 1),
      items: [{ content: "test" }],
      reference_item_id: "nonexistent",
      position: "after",
    });
    expect(err.error).toBe("ItemNotFound");
  });
});

// ─── send_to_inbox ───────────────────────────────────────────────────

describe("send_to_inbox", () => {
  test("sends single item to inbox", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Inbox item",
    });
    expect(result.file_id).toBe("inbox_doc");
    expect(result.item_id).toBeDefined();
  });

  test("empty content returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("sends with note on first item", async () => {
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Item with note",
      note: "This is a note",
    });
    // Verify note was set on the inbox item.
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Item with note")!;
    expect(node.note).toBe("This is a note");
  });

  // ─── 13b: checkbox behavior ────────────────────────────────────────

  test("omitting show_checkbox sends no checkbox to the API", async () => {
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "No checkbox item",
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "No checkbox item")!;
    expect(node.checkbox).toBeUndefined();
  });

  test("explicit show_checkbox: true sends checkbox to API", async () => {
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Explicit checkbox",
      show_checkbox: true,
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Explicit checkbox")!;
    expect(node.checkbox).toBe(true);
  });

  // ─── 13b2: heading, color, checked ──────────────────────────────────

  test("sends with heading", async () => {
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Heading item",
      heading: "h2",
    });
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Heading item")!;
    expect(node.heading).toBe(2);
  });

  test("sends with color", async () => {
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Colored item",
      color: "green",
    });
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Colored item")!;
    expect(node.color).toBe(4);
  });

  test("sends with checked and show_checkbox", async () => {
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Checked item",
      show_checkbox: true,
      checked: true,
    });
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Checked item")!;
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(true);
  });

  // ─── 13c: response shape ───────────────────────────────────────────

  test("response includes file_id, item_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "shape item",
    });

    expect(result.file_id).toBe("inbox_doc");
    expect(typeof result.item_id).toBe("string");
  });
});
