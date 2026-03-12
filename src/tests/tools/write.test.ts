import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getConfig } from "../../config";
import {
  createTestContext,
  callTool,
  callToolOk,
  callToolError,
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

// ─── edit_node ───────────────────────────────────────────────────────

describe("edit_node", () => {
  test("updates content", async () => {
    const result = await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated content",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.node_id).toBe("n1");
    expect(result.url).toContain("doc1");

    // Verify the change persisted.
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.content).toBe("Updated content");
  });

  test("partial update: only specified fields change", async () => {
    // Set initial state.
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "original note";

    // Edit only content, not note.
    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      content: "New content",
    });

    expect(node.content).toBe("New content");
    expect(node.note).toBe("original note");
  });

  test("empty content is allowed", async () => {
    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      content: "",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.content).toBe("");
  });

  test("empty note clears it", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "some note";

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      note: "",
    });
    expect(node.note).toBe("");
  });

  test("sets heading and color", async () => {
    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      heading: 2,
      color: 3,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.heading).toBe(2);
    expect(node.color).toBe(3);
  });

  test("nonexistent document returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "nonexistent",
      node_id: "n1",
      content: "test",
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent node returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "nonexistent",
      content: "test",
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("note content fidelity: multi-line with code blocks round-trips", async () => {
    const complexNote = "Line 1\n\n```python\ndef foo():\n    return 42\n```\n\nLine after code";
    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      note: complexNote,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    expect(node.note).toBe(complexNote);
  });

  // ─── 10b: field independence ────────────────────────────────────────

  test("edit only content preserves note, heading, color, checkbox, checked", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "keep this note";
    node.heading = 2;
    node.color = 4;
    node.checkbox = true;
    node.checked = true;

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      content: "Changed content only",
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

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      note: "brand new note",
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

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      heading: 3,
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

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      color: 6,
    });

    expect(node.content).toBe(originalContent);
    expect(node.heading).toBe(1);
    expect(node.color).toBe(6);
  });

  test("edit only checkbox preserves everything else", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.note = "note here";
    const originalContent = node.content;

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      checkbox: true,
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

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      checked: true,
    });

    expect(node.content).toBe(originalContent);
    expect(node.note).toBe("keep me");
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(true);
  });

  // ─── 10c: specific field values ─────────────────────────────────────

  test("heading: 0 removes heading", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.heading = 2;

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      heading: 0,
    });

    expect(node.heading).toBeUndefined();
  });

  test("heading: 1, 2, 3 all set correctly", async () => {
    for (const h of [1, 2, 3]) {
      await callToolOk(ctx.mcpClient, "edit_node", {
        file_id: "doc1",
        node_id: "n1",
        heading: h,
      });
      const doc = ctx.server.documents.get("doc1")!;
      const node = doc.nodes.find((n) => n.id === "n1")!;
      expect(node.heading).toBe(h);
    }
  });

  test("color: 0 removes color", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.color = 3;

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      color: 0,
    });

    expect(node.color).toBeUndefined();
  });

  test("color: 1 through 6 all set correctly", async () => {
    for (const c of [1, 2, 3, 4, 5, 6]) {
      await callToolOk(ctx.mcpClient, "edit_node", {
        file_id: "doc1",
        node_id: "n1",
        color: c,
      });
      const doc = ctx.server.documents.get("doc1")!;
      const node = doc.nodes.find((n) => n.id === "n1")!;
      expect(node.color).toBe(c);
    }
  });

  test("checkbox: false removes checkbox", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find((n) => n.id === "n1")!;
    node.checkbox = true;

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      checkbox: false,
    });

    expect(node.checkbox).toBe(false);
  });

  test("checked: true with checkbox: true marks node as checked", async () => {
    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      checkbox: true,
      checked: true,
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

    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      checked: false,
    });

    expect(node.checked).toBe(false);
  });

  // ─── 10d: response shape ────────────────────────────────────────────

  test("response includes file_id, node_id, and url", async () => {
    const result = await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      content: "shape test",
    });

    expect(result.file_id).toBe("doc1");
    expect(result.node_id).toBe("n1");
    expect(typeof result.url).toBe("string");
    expect(result.url).toContain("doc1");
  });

  // ─── 10e: error codes ──────────────────────────────────────────────

  test("nonexistent document returns NotFound error code", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "no_such_doc",
      node_id: "n1",
      content: "test",
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent node returns NodeNotFound error code", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "no_such_node",
      content: "test",
    });
    expect(err.error).toBe("NodeNotFound");
  });
});

// ─── insert_node ─────────────────────────────────────────────────────

describe("insert_node", () => {
  test("inserts a node and returns id", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "New node",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.node_id).toBeDefined();
    expect(result.node_id).not.toBe("unknown");
    expect(result.url).toContain("doc1");
  });

  test("index: 0 inserts as first child", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "First!",
      index: 0,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const firstChildId = root.children[0];
    const firstChild = doc.nodes.find((n) => n.id === firstChildId)!;
    expect(firstChild.content).toBe("First!");
  });

  test("index: -1 inserts at end", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Last!",
      index: -1,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const lastChildId = root.children[root.children.length - 1];
    const lastChild = doc.nodes.find((n) => n.id === lastChildId)!;
    expect(lastChild.content).toBe("Last!");
  });

  test("with checkbox and checked", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Todo",
      checkbox: true,
      checked: false,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Todo")!;
    expect(newNode.checkbox).toBe(true);
    expect(newNode.checked).toBe(false);
  });

  test("with note", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Noted item",
      note: "This is a note",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Noted item")!;
    expect(newNode.note).toBe("This is a note");
  });

  // ─── 11b: auto-checkbox behavior ───────────────────────────────────

  test("checked: false without checkbox does not auto-enable checkbox", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "No auto checkbox",
      checked: false,
    });

    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No auto checkbox")!;
    // Explicitly setting checked: false should not force a checkbox to appear.
    expect(newNode.checkbox).toBeUndefined();
  });

  test("checked: true without checkbox auto-enables checkbox", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Auto checkbox",
      checked: true,
    });

    // Verify the node has both checkbox and checked set.
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Auto checkbox")!;
    expect(newNode.checked).toBe(true);
    expect(newNode.checkbox).toBe(true);
  });

  test("auto-checkbox round-trip: node has both checked and checkbox true", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Round trip check",
      checked: true,
    });

    // Read back via read_document and verify both fields.
    const readResult = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const rootNode = readResult.node as Record<string, unknown>;

    // Find the node in the tree recursively.
    function findNode(node: Record<string, unknown>, content: string): Record<string, unknown> | null {
      if (node.content === content) return node;
      const children = node.children as Array<Record<string, unknown>> | undefined;
      if (children) {
        for (const child of children) {
          const found = findNode(child, content);
          if (found) return found;
        }
      }
      return null;
    }

    const node = findNode(rootNode, "Round trip check");
    expect(node).not.toBeNull();
    expect(node!.checked).toBe(true);
    expect(node!.checkbox).toBe(true);
  });

  // ─── 11c: optional fields ──────────────────────────────────────────

  test("color > 0 is included on the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Colored node",
      color: 3,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Colored node")!;
    expect(newNode.color).toBe(3);
  });

  test("color 0 is omitted from the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "No color node",
      color: 0,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No color node")!;
    expect(newNode.color).toBeUndefined();
  });

  test("heading > 0 is included on the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Heading node",
      heading: 2,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Heading node")!;
    expect(newNode.heading).toBe(2);
  });

  test("heading 0 is omitted from the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "No heading node",
      heading: 0,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No heading node")!;
    expect(newNode.heading).toBeUndefined();
  });

  // ─── 11d: response shape ───────────────────────────────────────────

  test("response includes file_id, node_id, parent_id, and url", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "doc1",
      parent_id: "root",
      content: "Shape test node",
    });

    expect(result.file_id).toBe("doc1");
    expect(typeof result.node_id).toBe("string");
    expect(result.parent_id).toBe("root");
    expect(typeof result.url).toBe("string");
    expect(result.url).toContain("doc1");
  });
});

// ─── insert_nodes ────────────────────────────────────────────────────

describe("insert_nodes", () => {
  test("inserts flat list", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- item1\n- item2\n- item3",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.total_created).toBe(3);
    expect(result.root_node_ids).toBeDefined();
    expect((result.root_node_ids as string[]).length).toBe(3);
  });

  test("inserts nested hierarchy", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "- parent\n    - child\n        - grandchild",
    });
    expect(result.total_created).toBe(3);

    // Verify the tree structure in the dummy server.
    const doc = ctx.server.documents.get("doc1")!;
    const parentNode = doc.nodes.find((n) => n.content === "parent")!;
    expect(parentNode.children.length).toBe(1);
    const childNode = doc.nodes.find((n) => n.id === parentNode.children[0])!;
    expect(childNode.content).toBe("child");
    expect(childNode.children.length).toBe(1);
  });

  test("as_first_child position", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- top item",
      position: "as_first_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const firstChild = doc.nodes.find((n) => n.id === root.children[0])!;
    expect(firstChild.content).toBe("top item");
  });

  test("omitting node_id inserts at document root", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      content: "- root-level item",
    });
    expect(result.total_created).toBe(1);
  });

  test("empty content returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      content: "",
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── 12b: hierarchy fidelity ───────────────────────────────────────

  test("3-level hierarchy: parent > child > grandchild", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- level1\n  - level2\n    - level3",
    });
    expect(result.total_created).toBe(3);

    const doc = ctx.server.documents.get("doc1")!;
    const l1 = doc.nodes.find((n) => n.content === "level1")!;
    expect(l1.children.length).toBe(1);
    const l2 = doc.nodes.find((n) => n.id === l1.children[0])!;
    expect(l2.content).toBe("level2");
    expect(l2.children.length).toBe(1);
    const l3 = doc.nodes.find((n) => n.id === l2.children[0])!;
    expect(l3.content).toBe("level3");
  });

  test("4-level hierarchy with multiple branches preserves ordering", async () => {
    const content = [
      "- A",
      "  - A1",
      "    - A1a",
      "      - A1a-deep",
      "  - A2",
      "- B",
      "  - B1",
    ].join("\n");

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
    });
    expect(result.total_created).toBe(7);

    const doc = ctx.server.documents.get("doc1")!;
    const nodeA = doc.nodes.find((n) => n.content === "A")!;
    expect(nodeA.children.length).toBe(2);

    const nodeA1 = doc.nodes.find((n) => n.id === nodeA.children[0])!;
    expect(nodeA1.content).toBe("A1");
    const nodeA2 = doc.nodes.find((n) => n.id === nodeA.children[1])!;
    expect(nodeA2.content).toBe("A2");

    const nodeA1a = doc.nodes.find((n) => n.id === nodeA1.children[0])!;
    expect(nodeA1a.content).toBe("A1a");
    expect(nodeA1a.children.length).toBe(1);

    const nodeB = doc.nodes.find((n) => n.content === "B")!;
    expect(nodeB.children.length).toBe(1);
    const nodeB1 = doc.nodes.find((n) => n.id === nodeB.children[0])!;
    expect(nodeB1.content).toBe("B1");
  });

  test("multiple top-level items each with children", async () => {
    const content = "- Parent1\n  - Child1a\n  - Child1b\n- Parent2\n  - Child2a";
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
    });
    expect(result.total_created).toBe(5);
    expect((result.root_node_ids as string[]).length).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    const p1 = doc.nodes.find((n) => n.content === "Parent1")!;
    expect(p1.children.length).toBe(2);
    const p2 = doc.nodes.find((n) => n.content === "Parent2")!;
    expect(p2.children.length).toBe(1);
  });

  test("mixed depths: some branches deeper than others", async () => {
    const content = "- Shallow\n- Deep\n  - D1\n    - D2\n      - D3";
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
    });
    expect(result.total_created).toBe(5);

    const doc = ctx.server.documents.get("doc1")!;
    const shallow = doc.nodes.find((n) => n.content === "Shallow")!;
    expect(shallow.children.length).toBe(0);
    const deep = doc.nodes.find((n) => n.content === "Deep")!;
    expect(deep.children.length).toBe(1);
  });

  // ─── 12c: position behavior ────────────────────────────────────────

  test("as_last_child (default) appends to end of parent children", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalLastChildId = root.children[root.children.length - 1];

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- appended item",
    });

    // The new node should be after the original last child.
    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    const newLastChildId = rootAfter.children[rootAfter.children.length - 1];
    const newLastChild = doc.nodes.find((n) => n.id === newLastChildId)!;
    expect(newLastChild.content).toBe("appended item");
    expect(newLastChildId).not.toBe(originalLastChildId);
  });

  test("as_first_child prepends to start of parent children", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalFirstChildId = root.children[0];

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- prepended item",
      position: "as_first_child",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    const newFirstChildId = rootAfter.children[0];
    const newFirstChild = doc.nodes.find((n) => n.id === newFirstChildId)!;
    expect(newFirstChild.content).toBe("prepended item");

    // Original first child should still be present.
    expect(rootAfter.children).toContain(originalFirstChildId);
  });

  test("existing children preserved after insert", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalChildren = [...root.children];

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- new item",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    for (const childId of originalChildren) {
      expect(rootAfter.children).toContain(childId);
    }
  });

  // ─── 12d: markdown parsing integration ─────────────────────────────

  test("dash bullets (- item)", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- dash one\n- dash two",
    });
    expect(result.total_created).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.content === "dash one")).toBeDefined();
    expect(doc.nodes.find((n) => n.content === "dash two")).toBeDefined();
  });

  test("asterisk bullets (* item)", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "* star one\n* star two",
    });
    expect(result.total_created).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.content === "star one")).toBeDefined();
    expect(doc.nodes.find((n) => n.content === "star two")).toBeDefined();
  });

  test("numbered bullets (1. item)", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "1. first\n2. second\n3. third",
    });
    expect(result.total_created).toBe(3);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.content === "first")).toBeDefined();
    expect(doc.nodes.find((n) => n.content === "second")).toBeDefined();
    expect(doc.nodes.find((n) => n.content === "third")).toBeDefined();
  });

  test("plain indented text without bullet markers", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "plain top\n    plain child",
    });
    expect(result.total_created).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    const top = doc.nodes.find((n) => n.content === "plain top")!;
    expect(top.children.length).toBe(1);
    const child = doc.nodes.find((n) => n.id === top.children[0])!;
    expect(child.content).toBe("plain child");
  });

  test("mixed indent levels (2-space and 4-space)", async () => {
    const content = "- top\n  - two-space child\n    - four-space grandchild";
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
    });
    expect(result.total_created).toBe(3);

    const doc = ctx.server.documents.get("doc1")!;
    const top = doc.nodes.find((n) => n.content === "top")!;
    expect(top.children.length).toBe(1);
    const child = doc.nodes.find((n) => n.id === top.children[0])!;
    expect(child.content).toBe("two-space child");
    expect(child.children.length).toBe(1);
  });

  test("tab indentation converted correctly", async () => {
    // Tab is converted to 4 spaces by the parser.
    const content = "- top\n\t- tab child";
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
    });
    expect(result.total_created).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    const top = doc.nodes.find((n) => n.content === "top")!;
    expect(top.children.length).toBe(1);
  });

  test("empty lines are skipped", async () => {
    const content = "- first\n\n- second\n\n\n- third";
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
    });
    expect(result.total_created).toBe(3);
  });

  // ─── 12e: partial failure ──────────────────────────────────────────

  test("partial failure returns PartialInsert error with context", async () => {
    // Insert a 4-level deep hierarchy. Fail after 2 successful editDocument
    // calls, so levels 0 and 1 succeed but level 2 fails.
    const content = "- A\n  - B\n    - C\n      - D";

    ctx.server.failEditAfterNCalls(2);

    const result = await callTool(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.error).toBe("PartialInsert");
    expect(structured.inserted_count).toBe(2);
    expect(structured.total_count).toBe(4);
    expect(structured.first_node_id).toBeDefined();
    expect(typeof structured.url).toBe("string");

    // Verify failed_at_depth is included in the structured response.
    expect(structured.failed_at_depth).toBeDefined();
  });

  test("partial failure persists nodes inserted before the fault", async () => {
    // Same 4-level hierarchy, fail after 2 levels.
    const content = "- PersistA\n  - PersistB\n    - PersistC\n      - PersistD";

    ctx.server.failEditAfterNCalls(2);

    await callTool(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content,
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
    expect(nodeA!.children.length).toBe(1);
    expect(nodeA!.children[0]).toBe(nodeB!.id);
  });

  // ─── 12f: response shape ───────────────────────────────────────────

  test("response includes file_id, total_created, root_node_ids, and url", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      content: "- shape test a\n- shape test b",
    });

    expect(result.file_id).toBe("doc1");
    expect(result.total_created).toBe(2);
    expect(Array.isArray(result.root_node_ids)).toBe(true);
    expect((result.root_node_ids as string[]).length).toBe(2);
    expect(typeof result.url).toBe("string");
    expect(result.url).toContain("doc1");
  });
});

// ─── send_to_inbox ───────────────────────────────────────────────────

describe("send_to_inbox", () => {
  test("sends single item to inbox", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Inbox item",
    });
    expect(result.file_id).toBe("inbox_doc");
    expect(result.first_node_id).toBeDefined();
    expect(result.url).toContain("inbox_doc");
    expect(result.total_created).toBe(1);
  });

  test("sends multi-line markdown to inbox", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "- parent\n    - child1\n    - child2",
    });
    expect(result.total_created).toBe(3);
  });

  test("empty content returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("sends with note on first item", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Item with note",
      note: "This is a note",
    });
    expect(result.total_created).toBe(1);

    // Verify note was set on the inbox item.
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Item with note")!;
    expect(node.note).toBe("This is a note");
  });

  // ─── 13b: checkbox behavior ────────────────────────────────────────

  const INBOX_CONFIG_PATH = join(tmpdir(), `dynalist-mcp-inbox-test-config-${process.pid}.json`);
  let fakeMtime = Date.now();

  function writeInboxConfig(data: unknown) {
    writeFileSync(INBOX_CONFIG_PATH, JSON.stringify(data));
    fakeMtime += 2000;
    const secs = fakeMtime / 1000;
    utimesSync(INBOX_CONFIG_PATH, secs, secs);
  }

  function cleanupInboxConfig() {
    if (existsSync(INBOX_CONFIG_PATH)) {
      unlinkSync(INBOX_CONFIG_PATH);
    }
    try {
      getConfig();
    } catch {
      // Ignore errors from stale config state.
    }
  }

  test("default config (defaultCheckbox: false) sends with checkbox false", async () => {
    // Default config has inbox.defaultCheckbox = false. The handler
    // always passes the effective checkbox value to the API.
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "No checkbox item",
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "No checkbox item")!;
    expect(node.checkbox).toBe(false);
  });

  test("config inbox.defaultCheckbox: true adds checkbox by default", async () => {
    await ctx.cleanup();

    process.env.DYNALIST_MCP_CONFIG = INBOX_CONFIG_PATH;
    writeInboxConfig({ inbox: { defaultCheckbox: true } });

    ctx = await createTestContext(standardSetup);
    try {
      await callToolOk(ctx.mcpClient, "send_to_inbox", {
        content: "Checkbox default item",
      });

      const doc = ctx.server.documents.get("inbox_doc")!;
      const node = doc.nodes.find((n) => n.content === "Checkbox default item")!;
      expect(node.checkbox).toBe(true);
    } finally {
      cleanupInboxConfig();
      delete process.env.DYNALIST_MCP_CONFIG;
    }
  });

  test("explicit checkbox: true overrides config default of false", async () => {
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Explicit checkbox",
      checkbox: true,
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Explicit checkbox")!;
    expect(node.checkbox).toBe(true);
  });

  test("explicit checkbox: false overrides config default of true", async () => {
    await ctx.cleanup();

    process.env.DYNALIST_MCP_CONFIG = INBOX_CONFIG_PATH;
    writeInboxConfig({ inbox: { defaultCheckbox: true } });

    ctx = await createTestContext(standardSetup);
    try {
      await callToolOk(ctx.mcpClient, "send_to_inbox", {
        content: "No checkbox override",
        checkbox: false,
      });

      const doc = ctx.server.documents.get("inbox_doc")!;
      const node = doc.nodes.find((n) => n.content === "No checkbox override")!;
      // When checkbox is explicitly false, it is passed through to the API.
      expect(node.checkbox).toBe(false);
    } finally {
      cleanupInboxConfig();
      delete process.env.DYNALIST_MCP_CONFIG;
    }
  });

  // ─── 13c: hierarchy preservation ───────────────────────────────────

  test("indented markdown with nested items preserves parent-child relationships", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "- root item\n  - child item\n    - grandchild item",
    });
    expect(result.total_created).toBe(3);

    const doc = ctx.server.documents.get("inbox_doc")!;
    const rootItem = doc.nodes.find((n) => n.content === "root item")!;
    expect(rootItem.children.length).toBe(1);

    const childItem = doc.nodes.find((n) => n.id === rootItem.children[0])!;
    expect(childItem.content).toBe("child item");
    expect(childItem.children.length).toBe(1);

    const grandchild = doc.nodes.find((n) => n.id === childItem.children[0])!;
    expect(grandchild.content).toBe("grandchild item");
  });

  test("multiple top-level items with children under each", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "- top A\n  - child A1\n- top B\n  - child B1",
    });
    expect(result.total_created).toBe(4);

    const doc = ctx.server.documents.get("inbox_doc")!;
    const topA = doc.nodes.find((n) => n.content === "top A")!;
    expect(topA.children.length).toBe(1);
    const childA1 = doc.nodes.find((n) => n.id === topA.children[0])!;
    expect(childA1.content).toBe("child A1");

    const topB = doc.nodes.find((n) => n.content === "top B")!;
    expect(topB.children.length).toBe(1);
    const childB1 = doc.nodes.find((n) => n.id === topB.children[0])!;
    expect(childB1.content).toBe("child B1");
  });

  // ─── 13d: partial failure ──────────────────────────────────────────

  test("partial failure returns PartialInsert error with context", async () => {
    // Send a hierarchy to inbox. The first item is added via sendToInbox,
    // then children are inserted via editDocument. Fail the first
    // editDocument call so only the root inbox item persists.
    const content = "- Inbox parent\n  - Inbox child\n    - Inbox grandchild";

    // The handler calls sendToInbox for the first item (not affected by
    // this fault), then calls insertTreeUnderParent for children which
    // uses editDocument. Fail after 1 successful editDocument call so
    // "Inbox child" is inserted but "Inbox grandchild" fails.
    ctx.server.failEditAfterNCalls(1);

    const result = await callTool(ctx.mcpClient, "send_to_inbox", {
      content,
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.error).toBe("PartialInsert");
    expect(structured.inserted_count).toBeDefined();
    expect(structured.total_count).toBeDefined();
    expect(typeof structured.url).toBe("string");
  });

  test("partial failure persists nodes inserted before the fault", async () => {
    // Same hierarchy. Fail after 1 editDocument call.
    const content = "- Persist inbox parent\n  - Persist inbox child\n    - Persist inbox grandchild";

    ctx.server.failEditAfterNCalls(1);

    await callTool(ctx.mcpClient, "send_to_inbox", { content });

    // The first item was created via sendToInbox (unaffected by fault).
    // The first editDocument call (level 0 children) succeeded.
    // The second editDocument call (level 1 children) failed.
    const doc = ctx.server.documents.get("inbox_doc")!;
    const parent = doc.nodes.find((n) => n.content === "Persist inbox parent");
    const child = doc.nodes.find((n) => n.content === "Persist inbox child");
    const grandchild = doc.nodes.find((n) => n.content === "Persist inbox grandchild");

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(grandchild).toBeUndefined();
  });

  // ─── 13e: response shape ───────────────────────────────────────────

  test("response includes file_id, first_node_id, url, and total_created", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "- shape item 1\n- shape item 2",
    });

    expect(result.file_id).toBe("inbox_doc");
    expect(typeof result.first_node_id).toBe("string");
    expect(typeof result.url).toBe("string");
    expect(result.url).toContain("inbox_doc");
    expect(result.total_created).toBe(2);
  });
});
