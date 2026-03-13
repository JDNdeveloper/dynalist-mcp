import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

// ─── edit_nodes ───────────────────────────────────────────────────────

describe("edit_nodes", () => {
  test("updates content", async () => {
    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
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
    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "New content",
    });

    expect(node.content).toBe("New content");
    expect(node.note).toBe("original note");
  });

  test("empty content is allowed", async () => {
    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      note: "",
    });
    expect(node.note).toBe("");
  });

  test("sets heading and color", async () => {
    await callToolOk(ctx.mcpClient, "edit_nodes", {
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
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "nonexistent",
      node_id: "n1",
      content: "test",
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent node returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "nonexistent",
      content: "test",
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("note content fidelity: multi-line with code blocks round-trips", async () => {
    const complexNote = "Line 1\n\n```python\ndef foo():\n    return 42\n```\n\nLine after code";
    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      heading: 0,
    });

    expect(node.heading).toBeUndefined();
  });

  test("heading: 1, 2, 3 all set correctly", async () => {
    for (const h of [1, 2, 3]) {
      await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      color: 0,
    });

    expect(node.color).toBeUndefined();
  });

  test("color: 1 through 6 all set correctly", async () => {
    for (const c of [1, 2, 3, 4, 5, 6]) {
      await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      checkbox: false,
    });

    expect(node.checkbox).toBe(false);
  });

  test("checked: true with checkbox: true marks node as checked", async () => {
    await callToolOk(ctx.mcpClient, "edit_nodes", {
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

    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      checked: false,
    });

    expect(node.checked).toBe(false);
  });

  // ─── 10d: response shape ────────────────────────────────────────────

  test("response includes file_id, node_id, and url", async () => {
    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
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
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "no_such_doc",
      node_id: "n1",
      content: "test",
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent node returns NodeNotFound error code", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "no_such_node",
      content: "test",
    });
    expect(err.error).toBe("NodeNotFound");
  });
});

// ─── insert_nodes ────────────────────────────────────────────────────

describe("insert_nodes", () => {
  test("inserts flat list", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "item1" }, { content: "item2" }, { content: "item3" }],
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
      nodes: [{
        content: "parent",
        children: [{
          content: "child",
          children: [{ content: "grandchild" }],
        }],
      }],
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
      nodes: [{ content: "top item" }],
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
      nodes: [{ content: "root-level item" }],
    });
    expect(result.total_created).toBe(1);
  });

  test("empty nodes array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [],
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── hierarchy fidelity ────────────────────────────────────────────

  test("3-level hierarchy: parent > child > grandchild", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{
        content: "level1",
        children: [{
          content: "level2",
          children: [{ content: "level3" }],
        }],
      }],
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
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [
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
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [
        { content: "Parent1", children: [{ content: "Child1a" }, { content: "Child1b" }] },
        { content: "Parent2", children: [{ content: "Child2a" }] },
      ],
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
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [
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
    expect(result.total_created).toBe(5);

    const doc = ctx.server.documents.get("doc1")!;
    const shallow = doc.nodes.find((n) => n.content === "Shallow")!;
    expect(shallow.children.length).toBe(0);
    const deep = doc.nodes.find((n) => n.content === "Deep")!;
    expect(deep.children.length).toBe(1);
  });

  // ─── position behavior ────────────────────────────────────────────

  test("as_last_child (default) appends to end of parent children", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalLastChildId = root.children[root.children.length - 1];

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "appended item" }],
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
      nodes: [{ content: "prepended item" }],
      position: "as_first_child",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    const newFirstChildId = rootAfter.children[0];
    const newFirstChild = doc.nodes.find((n) => n.id === newFirstChildId)!;
    expect(newFirstChild.content).toBe("prepended item");

    // Original first child should still be present.
    expect(rootAfter.children).toContain(originalFirstChildId);
  });

  test("as_last_child with multiple items preserves input order", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalChildCount = root.children.length;

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Order A" }, { content: "Order B" }, { content: "Order C" }],
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    expect(rootAfter.children.length).toBe(originalChildCount + 3);

    // Items should appear in input order at the end.
    const newChildren = rootAfter.children.slice(originalChildCount);
    const contents = newChildren.map(id => doc.nodes.find((n) => n.id === id)!.content);
    expect(contents).toEqual(["Order A", "Order B", "Order C"]);
  });

  test("as_first_child with multiple items preserves input order", async () => {
    const doc = ctx.server.documents.get("doc1")!;

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "First A" }, { content: "First B" }, { content: "First C" }],
      position: "as_first_child",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;

    // Items should appear in input order at the start.
    const firstThree = rootAfter.children.slice(0, 3);
    const contents = firstThree.map(id => doc.nodes.find((n) => n.id === id)!.content);
    expect(contents).toEqual(["First A", "First B", "First C"]);
  });

  test("existing children preserved after insert", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const originalChildren = [...root.children];

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "new item" }],
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    for (const childId of originalChildren) {
      expect(rootAfter.children).toContain(childId);
    }
  });

  test("index parameter overrides position", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "At index 0" }],
      index: 0,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const firstChildId = root.children[0];
    const firstChild = doc.nodes.find((n) => n.id === firstChildId)!;
    expect(firstChild.content).toBe("At index 0");
  });

  test("index: -1 appends at end", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Appended via index" }],
      index: -1,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const lastChildId = root.children[root.children.length - 1];
    const lastChild = doc.nodes.find((n) => n.id === lastChildId)!;
    expect(lastChild.content).toBe("Appended via index");
  });

  // ─── per-node fields ──────────────────────────────────────────────

  test("node with note", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Noted item", note: "This is a note" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Noted item")!;
    expect(newNode.note).toBe("This is a note");
  });

  test("node with checkbox and checked", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Todo", checkbox: true, checked: false }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Todo")!;
    expect(newNode.checkbox).toBe(true);
    expect(newNode.checked).toBe(false);
  });

  test("checked: true without checkbox does not add a checkbox", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Checked no checkbox", checked: true }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Checked no checkbox")!;
    expect(newNode.checked).toBe(true);
    expect(newNode.checkbox).toBeUndefined();
  });

  test("heading > 0 is included on the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Heading node", heading: 2 }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Heading node")!;
    expect(newNode.heading).toBe(2);
  });

  test("heading 0 is omitted from the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "No heading node", heading: 0 }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No heading node")!;
    expect(newNode.heading).toBeUndefined();
  });

  test("color > 0 is included on the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Colored node", color: 3 }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Colored node")!;
    expect(newNode.color).toBe(3);
  });

  test("color 0 is omitted from the inserted node", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "No color node", color: 0 }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "No color node")!;
    expect(newNode.color).toBeUndefined();
  });

  test("multiline content round-trips", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Line 1\nLine 2\nLine 3" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Line 1\nLine 2\nLine 3")!;
    expect(newNode).toBeDefined();
  });

  test("multiline note round-trips", async () => {
    const noteContent = "First line\n\n```python\ndef foo():\n    return 42\n```";
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "Code item", note: noteContent }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const newNode = doc.nodes.find((n) => n.content === "Code item")!;
    expect(newNode.note).toBe(noteContent);
  });

  test("per-node fields on children in hierarchy", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{
        content: "Parent",
        heading: 1,
        children: [{
          content: "Child",
          note: "child note",
          color: 5,
          checkbox: true,
          checked: true,
        }],
      }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const parent = doc.nodes.find((n) => n.content === "Parent")!;
    expect(parent.heading).toBe(1);
    const child = doc.nodes.find((n) => n.id === parent.children[0])!;
    expect(child.content).toBe("Child");
    expect(child.note).toBe("child note");
    expect(child.color).toBe(5);
    expect(child.checkbox).toBe(true);
    expect(child.checked).toBe(true);
  });

  // ─── partial failure ──────────────────────────────────────────────

  test("partial failure returns PartialInsert error with context", async () => {
    // Insert a 4-level deep hierarchy. Fail after 2 successful editDocument
    // calls, so levels 0 and 1 succeed but level 2 fails.
    ctx.server.failEditAfterNCalls(2);

    const result = await callTool(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{
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
    ctx.server.failEditAfterNCalls(2);

    await callTool(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{
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
    expect(nodeA!.children.length).toBe(1);
    expect(nodeA!.children[0]).toBe(nodeB!.id);
  });

  // ─── response shape ───────────────────────────────────────────────

  test("response includes file_id, total_created, root_node_ids, and url", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "root",
      nodes: [{ content: "shape test a" }, { content: "shape test b" }],
    });

    expect(result.file_id).toBe("doc1");
    expect(result.total_created).toBe(2);
    expect(Array.isArray(result.root_node_ids)).toBe(true);
    expect((result.root_node_ids as string[]).length).toBe(2);
    expect(typeof result.url).toBe("string");
    expect(result.url).toContain("doc1");
  });

  // ─── sibling-relative positioning (after/before) ─────────────────

  test("insert after a sibling", async () => {
    // root has children: n1, n2, n3. Insert after n1.
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "After n1" }],
      position: "after",
      reference_node_id: "n1",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children.indexOf("n1");
    const insertedId = root.children[n1Index + 1];
    const inserted = doc.nodes.find((n) => n.id === insertedId)!;
    expect(inserted.content).toBe("After n1");
  });

  test("insert before a sibling", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "Before n2" }],
      position: "before",
      reference_node_id: "n2",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n2Index = root.children.indexOf("n2");
    const insertedId = root.children[n2Index - 1];
    const inserted = doc.nodes.find((n) => n.id === insertedId)!;
    expect(inserted.content).toBe("Before n2");
  });

  test("insert after the last sibling appends at end", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const rootBefore = doc.nodes.find((n) => n.id === "root")!;
    const childCountBefore = rootBefore.children.length;

    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "After last" }],
      position: "after",
      reference_node_id: "n3",
    });

    const rootAfter = doc.nodes.find((n) => n.id === "root")!;
    expect(rootAfter.children.length).toBe(childCountBefore + 1);
    const lastChildId = rootAfter.children[rootAfter.children.length - 1];
    const lastChild = doc.nodes.find((n) => n.id === lastChildId)!;
    expect(lastChild.content).toBe("After last");
  });

  test("insert before the first sibling places at index 0", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "Before first" }],
      position: "before",
      reference_node_id: "n1",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const firstChildId = root.children[0];
    const firstChild = doc.nodes.find((n) => n.id === firstChildId)!;
    expect(firstChild.content).toBe("Before first");
  });

  test("insert multiple top-level nodes after a sibling preserves order", async () => {
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "Multi A" }, { content: "Multi B" }, { content: "Multi C" }],
      position: "after",
      reference_node_id: "n1",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children.indexOf("n1");
    const insertedA = doc.nodes.find((n) => n.id === root.children[n1Index + 1])!;
    const insertedB = doc.nodes.find((n) => n.id === root.children[n1Index + 2])!;
    const insertedC = doc.nodes.find((n) => n.id === root.children[n1Index + 3])!;
    expect(insertedA.content).toBe("Multi A");
    expect(insertedB.content).toBe("Multi B");
    expect(insertedC.content).toBe("Multi C");
  });

  test("insert hierarchy after a sibling preserves tree structure", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{
        content: "Hier parent",
        children: [{ content: "Hier child" }],
      }],
      position: "after",
      reference_node_id: "n2",
    });

    expect(result.total_created).toBe(2);

    const doc = ctx.server.documents.get("doc1")!;
    const parent = doc.nodes.find((n) => n.content === "Hier parent")!;
    expect(parent.children.length).toBe(1);
    const child = doc.nodes.find((n) => n.id === parent.children[0])!;
    expect(child.content).toBe("Hier child");
  });

  test("omit node_id, infer parent from reference node", async () => {
    // n1 has children n1a, n1b. Insert after n1a without specifying node_id.
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "After n1a" }],
      position: "after",
      reference_node_id: "n1a",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    const n1aIndex = n1.children.indexOf("n1a");
    const insertedId = n1.children[n1aIndex + 1];
    const inserted = doc.nodes.find((n) => n.id === insertedId)!;
    expect(inserted.content).toBe("After n1a");
  });

  test("provide node_id matching reference parent succeeds", async () => {
    // n1a's parent is n1. Providing node_id: "n1" should work.
    await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{ content: "Explicit parent" }],
      position: "before",
      reference_node_id: "n1b",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    const inserted = doc.nodes.find((n) => n.content === "Explicit parent")!;
    expect(n1.children).toContain(inserted.id);
  });

  // ─── sibling-relative positioning: validation errors ─────────────

  test("reference_node_id + index both provided returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "test" }],
      reference_node_id: "n1",
      index: 0,
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("after without reference_node_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "test" }],
      position: "after",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("before without reference_node_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "test" }],
      position: "before",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("reference_node_id with as_first_child returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "test" }],
      position: "as_first_child",
      reference_node_id: "n1",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("reference_node_id with as_last_child returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "test" }],
      position: "as_last_child",
      reference_node_id: "n1",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("node_id mismatching reference parent returns error without leaking parent id", async () => {
    // n1a's parent is n1, but we pass node_id: "n2".
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n2",
      nodes: [{ content: "test" }],
      position: "after",
      reference_node_id: "n1a",
    });
    expect(err.error).toBe("InvalidInput");
    // The error message must not reveal the actual parent node id (n1).
    expect(err.message).not.toContain("n1");
  });

  test("nonexistent reference_node_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "test" }],
      position: "after",
      reference_node_id: "nonexistent",
    });
    expect(err.error).toBe("NodeNotFound");
  });
});

// ─── send_to_inbox ───────────────────────────────────────────────────

describe("send_to_inbox", () => {
  test("sends single item to inbox", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Inbox item",
    });
    expect(result.file_id).toBe("inbox_doc");
    expect(result.node_id).toBeDefined();
    expect(result.url).toContain("inbox_doc");
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
    // Verify note was set on the inbox item.
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Item with note")!;
    expect(node.note).toBe("This is a note");
  });

  // ─── 13b: checkbox behavior ────────────────────────────────────────

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
    ctx = await createTestContext(standardSetup, { inbox: { defaultCheckbox: true } });
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Checkbox default item",
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "Checkbox default item")!;
    expect(node.checkbox).toBe(true);
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
    ctx = await createTestContext(standardSetup, { inbox: { defaultCheckbox: true } });
    await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "No checkbox override",
      checkbox: false,
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.content === "No checkbox override")!;
    // When checkbox is explicitly false, it is passed through to the API.
    expect(node.checkbox).toBe(false);
  });

  // ─── 13c: response shape ───────────────────────────────────────────

  test("response includes file_id, node_id, and url", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "shape item",
    });

    expect(result.file_id).toBe("inbox_doc");
    expect(typeof result.node_id).toBe("string");
    expect(typeof result.url).toBe("string");
    expect(result.url).toContain("inbox_doc");
  });
});
