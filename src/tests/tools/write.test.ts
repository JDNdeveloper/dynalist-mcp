import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
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
    expect(result.first_node_id).toBeDefined();
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
});
