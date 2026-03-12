import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  callTool,
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

// ─── list_documents ──────────────────────────────────────────────────

describe("list_documents", () => {
  test("returns all documents and folders", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    expect(result.count).toBe(3); // doc1, doc2, inbox_doc
    expect(result.documents).toBeInstanceOf(Array);
    expect(result.folders).toBeInstanceOf(Array);
    expect(result.root_file_id).toBe("root_folder");
  });

  test("documents have id, title, url, permission", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const docs = result.documents as Record<string, unknown>[];
    const doc1 = docs.find((d) => d.file_id === "doc1");
    expect(doc1).toBeDefined();
    expect(doc1!.title).toBe("Test Document");
    expect(doc1!.url).toContain("dynalist.io/d/doc1");
    expect(doc1!.permission).toBe("owner");
  });

  test("folders have id, title, children", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folders = result.folders as Record<string, unknown>[];
    const folderA = folders.find((f) => f.file_id === "folder_a");
    expect(folderA).toBeDefined();
    expect(folderA!.title).toBe("Folder A");
    expect(folderA!.children).toContain("doc1");
  });

  test("count reflects document count, not folder count", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    expect(result.count).toBe(3);
  });

  // ─── Section 7a: additional list_documents tests ──────────────────

  test("response includes root_file_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    expect(result.root_file_id).toBe("root_folder");
    expect(typeof result.root_file_id).toBe("string");
  });

  test("folder children arrays contain file IDs as strings", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folders = result.folders as Record<string, unknown>[];
    for (const folder of folders) {
      const children = folder.children as unknown[];
      for (const child of children) {
        expect(typeof child).toBe("string");
      }
    }
  });

  // ─── Section 7b: edge cases ────────────────────────────────────────

  test("nested folders are all returned", async () => {
    // Add a nested folder inside folder_a.
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");

    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folders = result.folders as Record<string, unknown>[];
    const nested = folders.find((f) => f.file_id === "folder_nested");
    expect(nested).toBeDefined();
    expect(nested!.title).toBe("Nested Folder");
  });

  test("documents in root folder (not inside any subfolder)", async () => {
    // inbox_doc is directly in root_folder per standardSetup.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folders = result.folders as Record<string, unknown>[];
    const root = folders.find((f) => f.file_id === "root_folder");
    expect(root).toBeDefined();
    const rootChildren = root!.children as string[];
    expect(rootChildren).toContain("inbox_doc");
  });
});

// ─── search_documents ────────────────────────────────────────────────

describe("search_documents", () => {
  test("finds documents by name (case-insensitive)", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "test" });
    expect(result.count).toBe(1);
    const matches = result.matches as Record<string, unknown>[];
    expect(matches[0].title).toBe("Test Document");
  });

  test("filter by type: document", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "folder", type: "folder" });
    const matches = result.matches as Record<string, unknown>[];
    for (const m of matches) {
      expect(m.type).toBe("folder");
    }
  });

  test("no matches returns empty array", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "nonexistent" });
    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
  });

  test("query field is echoed back", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "test" });
    expect(result.query).toBe("test");
  });

  // ─── Section 8a: additional search_documents tests ─────────────────

  test("type: all returns both documents and folders", async () => {
    // "folder" appears in folder names, so type: all should return folders and
    // any docs whose name includes "folder".
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "Folder", type: "all" });
    const matches = result.matches as Record<string, unknown>[];
    const types = matches.map((m) => m.type);
    expect(types).toContain("folder");
  });

  test("multiple matches returned", async () => {
    // Both "Folder A" and "Folder B" match.
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "Folder" });
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  test("partial name match (not just exact)", async () => {
    // "Test" is a partial match for "Test Document".
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "Docu" });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.title === "Test Document")).toBe(true);
  });
});

// ─── read_document ───────────────────────────────────────────────────

describe("read_document", () => {
  test("returns structured tree with required fields", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(result.file_id).toBe("doc1");
    expect(result.title).toBe("Test Document");
    expect(result.url).toContain("dynalist.io/d/doc1");
    expect(result.node).toBeDefined();
  });

  test("node tree has correct structure", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    expect(node.node_id).toBe("root");
    expect(node.content).toBe("Test Document");
    expect(node.children_count).toBe(3);
    const children = node.children as Record<string, unknown>[];
    expect(children).toHaveLength(3);
  });

  test("starting from specific node_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      node_id: "n1",
      max_depth: 10,
    });
    const node = result.node as Record<string, unknown>;
    expect(node.node_id).toBe("n1");
    expect(node.content).toBe("First item");
    expect((node.children as unknown[]).length).toBe(2);
  });

  test("invalid node_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      node_id: "nonexistent",
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("invalid file_id returns API error", async () => {
    const err = await callToolError(ctx.mcpClient, "read_document", {
      file_id: "nonexistent",
    });
    expect(err.error).toBe("NotFound");
  });

  // ─── Section 4a: response shape and optional fields ────────────────

  test("response includes file_id, title, url at top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(typeof result.url).toBe("string");
  });

  test("every node includes node_id, content, collapsed, children_count, children", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });

    function checkNodeFields(node: Record<string, unknown>) {
      expect(typeof node.node_id).toBe("string");
      expect(typeof node.content).toBe("string");
      expect(typeof node.collapsed).toBe("boolean");
      expect(typeof node.children_count).toBe("number");
      expect(Array.isArray(node.children)).toBe(true);
      for (const child of node.children as Record<string, unknown>[]) {
        checkNodeFields(child);
      }
    }
    checkNodeFields(result.node as Record<string, unknown>);
  });

  test("optional fields omitted when default values", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    // n1a has no note, no checkbox, no heading, no color.
    const n1a = rootChildren
      .flatMap((c) => (c.children as Record<string, unknown>[]) || [])
      .find((c) => c.node_id === "n1a")!;
    expect(n1a).toBeDefined();
    // note should be omitted (empty string in source).
    expect(n1a.note).toBeUndefined();
    // heading and color should be omitted when 0.
    expect(n1a.heading).toBeUndefined();
    expect(n1a.color).toBeUndefined();
  });

  test("note present only when non-empty string", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_notes: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    const n1Children = n1.children as Record<string, unknown>[];
    // n1b has a note.
    const n1b = n1Children.find((c) => c.node_id === "n1b")!;
    expect(n1b.note).toBe("A note on child B");
    // n1a has no note.
    const n1a = n1Children.find((c) => c.node_id === "n1a")!;
    expect(n1a.note).toBeUndefined();
  });

  test("checkbox present only when true", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    // n3 has checkbox: true.
    const n3 = rootChildren.find((c) => c.node_id === "n3")!;
    expect(n3.checkbox).toBe(true);
    // n1 does not have checkbox.
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1.checkbox).toBeUndefined();
  });

  test("checked present only when true", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    // n3 has checked: true.
    const n3 = rootChildren.find((c) => c.node_id === "n3")!;
    expect(n3.checked).toBe(true);
  });

  test("heading present only when 1-3, omitted when 0", async () => {
    // Set a heading on n1.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.heading = 2;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.heading).toBe(2);
    // n2 has no heading set.
    const n2Result = rootChildren.find((c) => c.node_id === "n2")!;
    expect(n2Result.heading).toBeUndefined();
  });

  test("color present only when 1-6, omitted when 0", async () => {
    // Set a color on n2.
    const doc = ctx.server.documents.get("doc1")!;
    const n2 = doc.nodes.find((n) => n.id === "n2")!;
    n2.color = 3;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n2Result = rootChildren.find((c) => c.node_id === "n2")!;
    expect(n2Result.color).toBe(3);
    // n1 has no color.
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.color).toBeUndefined();
  });

  test("root node has content equal to document title", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 0,
    });
    const node = result.node as Record<string, unknown>;
    expect(node.content).toBe("Test Document");
  });

  test("URL includes node_id when node_id parameter is specified", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      node_id: "n1",
      max_depth: 0,
    });
    expect(result.url).toContain("n1");
  });

  // ─── max_depth behavior ──────────────────────────────────────────

  test("max_depth: 0 returns only target node", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 0,
    });
    const node = result.node as Record<string, unknown>;
    expect(node.node_id).toBe("root");
    expect(node.children).toEqual([]);
    expect(node.children_count).toBe(3);
    expect(node.depth_limited).toBe(true);
  });

  test("max_depth: 1 returns target + immediate children", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    expect(children).toHaveLength(3);

    // n1 has children but they should be omitted at depth 1.
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect(n1.children).toEqual([]);
    expect(n1.children_count).toBe(2);
    expect(n1.depth_limited).toBe(true);

    // n3 is a leaf at depth 1: no depth_limited.
    const n3 = children.find((c) => c.node_id === "n3")!;
    expect(n3.children).toEqual([]);
    expect(n3.children_count).toBe(0);
    expect(n3.depth_limited).toBeUndefined();
  });

  test("large max_depth returns full tree", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 100,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect((n1.children as unknown[]).length).toBe(2);
  });

  test("max_depth: null (unlimited) returns full tree", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: null,
    });
    const node = result.node as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.node_id === "n1")!;
    expect((n1.children as unknown[]).length).toBe(2);
    // No depth_limited anywhere since depth is unlimited.
    expect(n1.depth_limited).toBeUndefined();
  });

  // ─── Section 4b: additional max_depth tests ──────────────────────

  test("max_depth: 2 shows grandchildren but not deeper", async () => {
    // Add a great-grandchild to n1a.
    const doc = ctx.server.documents.get("doc1")!;
    const n1a = doc.nodes.find((n) => n.id === "n1a")!;
    n1a.children = ["n1a1"];
    doc.nodes.push(ctx.server.makeNode("n1a1", "Great grandchild", []));

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 2,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    const n1Children = n1.children as Record<string, unknown>[];
    // Children are at depth 2, so they should be present.
    expect(n1Children.length).toBe(2);
    // But grandchildren of n1 (great-grandchild at depth 3) should not be.
    const n1aResult = n1Children.find((c) => c.node_id === "n1a")!;
    expect(n1aResult.children).toEqual([]);
    expect(n1aResult.children_count).toBe(1);
    expect(n1aResult.depth_limited).toBe(true);
  });

  test("non-collapsed node at max_depth with children: depth_limited true, children empty", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1.depth_limited).toBe(true);
    expect(n1.children_count).toBe(2);
    expect(n1.children).toEqual([]);
  });

  test("non-collapsed leaf node at max_depth: no depth_limited flag", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n3 = rootChildren.find((c) => c.node_id === "n3")!;
    expect(n3.children).toEqual([]);
    expect(n3.children_count).toBe(0);
    expect(n3.depth_limited).toBeUndefined();
  });

  // ─── collapsed children filtering ────────────────────────────────

  test("collapsed node hides children by default", async () => {
    // Make n1 collapsed.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toEqual([]);
    expect(n1Result.children_count).toBe(2);
    // No depth_limited because collapsed is the cause.
    expect(n1Result.depth_limited).toBeUndefined();
  });

  test("collapsed node shows children with include_collapsed_children: true", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_collapsed_children: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect((n1Result.children as unknown[]).length).toBe(2);
    expect(n1Result.children_count).toBe(2);
  });

  test("collapsed node at max_depth: collapsed takes precedence (no depth_limited)", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    // max_depth: 1 means n1 is at the depth limit.
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toEqual([]);
    // Collapsed takes precedence over depth_limited.
    expect(n1Result.depth_limited).toBeUndefined();
  });

  test("non-collapsed node at max_depth with children shows depth_limited", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1.collapsed).toBe(false);
    expect(n1.depth_limited).toBe(true);
    expect(n1.children).toEqual([]);
    expect(n1.children_count).toBe(2);
  });

  test("non-collapsed leaf at max_depth: no depth_limited", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n3 = rootChildren.find((c) => c.node_id === "n3")!;
    expect(n3.children).toEqual([]);
    expect(n3.children_count).toBe(0);
    expect(n3.depth_limited).toBeUndefined();
  });

  test("children_count always matches actual children regardless of visibility", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    // n1 has 2 children, even though they are hidden.
    expect(n1Result.children_count).toBe(2);
    expect(n1Result.children).toEqual([]);
  });

  // ─── Section 4c: additional collapsed tests ────────────────────────

  test("nested collapsed nodes: outer collapsed hides inner when include_collapsed_children false", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;
    // Also collapse n1a.
    const n1a = doc.nodes.find((n) => n.id === "n1a")!;
    n1a.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_collapsed_children: false,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    // Outer collapsed node hides children, so inner is not visible.
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toEqual([]);
    expect(n1Result.children_count).toBe(2);
  });

  test("nested collapsed with include_collapsed_children true: both visible with children", async () => {
    // Give n1a a child so we can see it.
    const doc = ctx.server.documents.get("doc1")!;
    const n1a = doc.nodes.find((n) => n.id === "n1a")!;
    n1a.children = ["n1a1"];
    n1a.collapsed = true;
    doc.nodes.push(ctx.server.makeNode("n1a1", "Deeply nested child", []));

    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_collapsed_children: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect((n1Result.children as unknown[]).length).toBe(2);
    const n1aResult = (n1Result.children as Record<string, unknown>[]).find((c) => c.node_id === "n1a")!;
    expect(n1aResult.collapsed).toBe(true);
    expect((n1aResult.children as unknown[]).length).toBe(1);
  });

  test("collapsed node NOT at depth limit: collapsed true, no depth_limited", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    // max_depth: 5 means n1 at depth 1 is well within the limit.
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 5,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toEqual([]);
    expect(n1Result.depth_limited).toBeUndefined();
  });

  // ─── Independence of max_depth and include_collapsed_children ────

  test("deep max_depth + collapsed hides children (no depth_limited)", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_collapsed_children: false,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toEqual([]);
    expect(n1Result.depth_limited).toBeUndefined();
  });

  test("shallow max_depth + include_collapsed_children: depth still applies", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    // max_depth: 1 means n1 (at depth 1) is at the limit.
    // include_collapsed_children: true makes collapsed transparent.
    // But depth still cuts off the children.
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
      include_collapsed_children: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toEqual([]);
    expect(n1Result.children_count).toBe(2);
    // Since include_collapsed_children makes collapsed transparent, depth_limited is the cause.
    expect(n1Result.depth_limited).toBe(true);
  });

  test("max_depth: 2 + include_collapsed_children: collapsed node at depth 1 shows children at depth 2", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 2,
      include_collapsed_children: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    // Children at depth 2 ARE shown.
    expect((n1Result.children as unknown[]).length).toBe(2);
  });

  // ─── Section 4d: additional depth + collapsed interaction ──────────

  test("max_depth 10, include_collapsed false: collapsed node has collapsed true, no depth_limited", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_collapsed_children: false,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children_count).toBe(2);
    expect(n1Result.children).toEqual([]);
    expect(n1Result.depth_limited).toBeUndefined();
  });

  test("max_depth 1, include_collapsed true: collapsed at depth 1 shows depth_limited, children NOT shown", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
      include_collapsed_children: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toEqual([]);
    expect(n1Result.depth_limited).toBe(true);
  });

  test("max_depth 2, include_collapsed true: children at depth 2 with own children show depth_limited", async () => {
    // Give n1a children so it has something to hide at depth 2.
    const doc = ctx.server.documents.get("doc1")!;
    const n1a = doc.nodes.find((n) => n.id === "n1a")!;
    n1a.children = ["n1a1"];
    doc.nodes.push(ctx.server.makeNode("n1a1", "Deeply nested", []));

    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 2,
      include_collapsed_children: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    const n1aResult = (n1Result.children as Record<string, unknown>[]).find((c) => c.node_id === "n1a")!;
    // n1a is at depth 2, which is the limit, and it has children.
    expect(n1aResult.depth_limited).toBe(true);
    expect(n1aResult.children).toEqual([]);
    expect(n1aResult.children_count).toBe(1);
  });

  // ─── Notes and checked filtering ─────────────────────────────────

  test("include_notes: false omits notes", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_notes: false,
    });

    // Walk tree to verify no node has a note field.
    function checkNoNotes(node: Record<string, unknown>) {
      expect(node.note).toBeUndefined();
      for (const child of node.children as Record<string, unknown>[]) {
        checkNoNotes(child);
      }
    }
    checkNoNotes(result.node as Record<string, unknown>);
  });

  test("include_checked: false filters out checked nodes", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_checked: false,
    });
    const rootNode = result.node as Record<string, unknown>;
    const children = rootNode.children as Record<string, unknown>[];
    // n3 is checked and should be filtered out.
    const n3 = children.find((c) => c.node_id === "n3");
    expect(n3).toBeUndefined();
  });

  // ─── Section 4e: additional notes tests ────────────────────────────

  test("include_notes: true (default) shows notes on nodes that have them", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_notes: true,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    const n1b = (n1.children as Record<string, unknown>[]).find((c) => c.node_id === "n1b")!;
    expect(n1b.note).toBe("A note on child B");
  });

  test("include_notes: false removes note field entirely", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_notes: false,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    const n1b = (n1.children as Record<string, unknown>[]).find((c) => c.node_id === "n1b")!;
    // Should have no note field at all, not just empty string.
    expect(n1b.note).toBeUndefined();
  });

  // ─── Section 4f: additional checked tests ──────────────────────────

  test("include_checked false: checked node entire subtree excluded", async () => {
    // Give n3 (checked node) a child.
    const doc = ctx.server.documents.get("doc1")!;
    const n3 = doc.nodes.find((n) => n.id === "n3")!;
    n3.children = ["n3a"];
    doc.nodes.push(ctx.server.makeNode("n3a", "Child of checked", []));

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_checked: false,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    // n3 should be filtered out.
    expect(rootChildren.find((c) => c.node_id === "n3")).toBeUndefined();
    // n3a should also not appear anywhere.
    function findNode(node: Record<string, unknown>, id: string): boolean {
      if (node.node_id === id) return true;
      for (const child of (node.children as Record<string, unknown>[]) || []) {
        if (findNode(child, id)) return true;
      }
      return false;
    }
    expect(findNode(result.node as Record<string, unknown>, "n3a")).toBe(false);
  });

  // ─── Section 4g: size warnings ─────────────────────────────────────

  test("document exceeding warning threshold returns warning with suggestions", async () => {
    const nodes = [ctx.server.makeNode("root", "Big Doc", [] as string[])];
    const childIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `big_${i}`;
      childIds.push(id);
      nodes.push(ctx.server.makeNode(id, "x".repeat(200), []));
    }
    nodes[0].children = childIds;
    ctx.server.addDocument("big_doc", "Big Doc", "folder_a", nodes);

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "big_doc",
      max_depth: 10,
    });
    expect(result.warning).toBeDefined();
    const warning = result.warning as string;
    expect(warning).toContain("max_depth");
    expect(warning).toContain("node_id");
  });

  test("document under warning threshold: no warning", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    expect(result.warning).toBeUndefined();
    expect(result.node).toBeDefined();
  });

  test("bypass_warning true on result between warning and max threshold: succeeds", async () => {
    const nodes = [ctx.server.makeNode("root", "Medium Doc", [] as string[])];
    const childIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `med_${i}`;
      childIds.push(id);
      nodes.push(ctx.server.makeNode(id, "x".repeat(200), []));
    }
    nodes[0].children = childIds;
    ctx.server.addDocument("med_doc", "Medium Doc", "folder_a", nodes);

    const first = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "med_doc",
      max_depth: 10,
    });
    expect(first.warning).toBeDefined();

    const second = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "med_doc",
      max_depth: 10,
      bypass_warning: true,
    });
    expect(second.node).toBeDefined();
    expect(second.warning).toBeUndefined();
  });

  test("bypass_warning true on small document: rejected with preemptive usage message", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      bypass_warning: true,
    });
    expect(result.warning).toBeDefined();
    const warning = result.warning as string;
    expect(warning).toContain("preemptively");
  });

  test("document over max threshold: cannot bypass, hard error", async () => {
    const nodes = [ctx.server.makeNode("root", "Huge Doc", [] as string[])];
    const childIds: string[] = [];
    for (let i = 0; i < 600; i++) {
      const id = `huge_${i}`;
      childIds.push(id);
      nodes.push(ctx.server.makeNode(id, "x".repeat(300), []));
    }
    nodes[0].children = childIds;
    ctx.server.addDocument("huge_doc", "Huge Doc", "folder_a", nodes);

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "huge_doc",
      max_depth: 10,
      bypass_warning: true,
    });
    expect(result.warning).toBeDefined();
    const warning = result.warning as string;
    expect(warning).toContain("too large");
  });

  // ─── Section 4h: children_count invariant ──────────────────────────

  test("children_count correct when children hidden by collapsed state", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.node_id === "n1")!;
    expect(n1Result.children_count).toBe(2);
    expect(n1Result.children).toEqual([]);
  });

  test("children_count correct when children hidden by depth limit", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 0,
    });
    const root = result.node as Record<string, unknown>;
    expect(root.children_count).toBe(3);
    expect(root.children).toEqual([]);
  });

  test("children_count correct when children hidden by include_checked false", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_checked: false,
    });
    const root = result.node as Record<string, unknown>;
    // children_count reflects the actual count in the source (3), not the
    // filtered count. The buildNodeTree implementation uses childIds.length
    // which is 3 regardless of checked filtering.
    expect(root.children_count).toBe(3);
    // But only 2 children are rendered (n3 is checked and excluded).
    expect((root.children as unknown[]).length).toBe(2);
  });

  test("children_count 0 on leaf nodes", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.node as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.node_id === "n1")!;
    const n1a = (n1.children as Record<string, unknown>[]).find((c) => c.node_id === "n1a")!;
    expect(n1a.children_count).toBe(0);
    expect(n1a.children).toEqual([]);
  });
});

// ─── search_in_document ──────────────────────────────────────────────

describe("search_in_document", () => {
  test("finds nodes by content", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "child",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.count).toBeGreaterThan(0);
    const matches = result.matches as Record<string, unknown>[];
    for (const m of matches) {
      expect(m.node_id).toBeDefined();
      expect(m.content).toBeDefined();
      expect(m.url).toBeDefined();
    }
  });

  test("searches notes when search_notes is true", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "note on child",
      search_notes: true,
    });
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  test("parent context is included", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: 1,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1a")!;
    expect(match.parents).toBeDefined();
    const parents = match.parents as Record<string, unknown>[];
    expect(parents[0].node_id).toBe("n1");
  });

  test("include_children returns direct children", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First item",
      include_children: true,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1")!;
    expect(match.children).toBeDefined();
    const children = match.children as Record<string, unknown>[];
    expect(children.length).toBe(2);
  });

  test("query echoed back", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "hello",
    });
    expect(result.query).toBe("hello");
  });

  // ─── Section 5a: additional basic behavior tests ───────────────────

  test("case-insensitive matching", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "FIRST ITEM",
    });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "n1")).toBe(true);
  });

  test("no matches: returns count 0 and empty matches array", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "zzzznonexistentzzzz",
    });
    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
  });

  test("match in note only: found when search_notes true", async () => {
    // n1b has note "A note on child B" but content "Child B".
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "note on child",
      search_notes: true,
    });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.node_id === "n1b")).toBe(true);
  });

  test("match in note only: NOT found when search_notes false", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "note on child",
      search_notes: false,
    });
    const matches = result.matches as Record<string, unknown>[];
    // "note on child" only appears in the note of n1b, not in any content.
    expect(matches.some((m) => m.node_id === "n1b")).toBe(false);
  });

  test("multiple matches in same document", async () => {
    // "Child" appears in n1a ("Child A"), n1b ("Child B"), n2a ("Nested child").
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "child",
    });
    expect(result.count).toBeGreaterThanOrEqual(3);
  });

  // ─── Section 5b: parent context ────────────────────────────────────

  test("parent_levels 0: no parents field", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: 0,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1a")!;
    expect(match.parents).toBeUndefined();
  });

  test("parent_levels 1: one parent returned", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: 1,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1a")!;
    const parents = match.parents as Record<string, unknown>[];
    expect(parents).toHaveLength(1);
    expect(parents[0].node_id).toBe("n1");
  });

  test("parent_levels 2: two parents returned", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: 2,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1a")!;
    const parents = match.parents as Record<string, unknown>[];
    // n1a -> n1 -> root, so 2 parents.
    expect(parents).toHaveLength(2);
    // Nearest parent first.
    expect(parents[0].node_id).toBe("n1");
    expect(parents[1].node_id).toBe("root");
  });

  test("parent array ordered with nearest parent first", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: 5,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1a")!;
    const parents = match.parents as Record<string, unknown>[];
    expect(parents[0].node_id).toBe("n1");
  });

  test("match on root node: no parents regardless of parent_levels", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Test Document",
      parent_levels: 5,
    });
    const matches = result.matches as Record<string, unknown>[];
    const rootMatch = matches.find((m) => m.node_id === "root");
    expect(rootMatch).toBeDefined();
    // Root has no parent, so parents should be undefined (no parents found).
    expect(rootMatch!.parents).toBeUndefined();
  });

  // ─── Section 5c: children inclusion ────────────────────────────────

  test("include_children false (default): no children in match", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First item",
      include_children: false,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1")!;
    expect(match.children).toBeUndefined();
  });

  test("include_children true on leaf node: no children field", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      include_children: true,
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.node_id === "n1a")!;
    // n1a has no children, so the children field is not set.
    expect(match.children).toBeUndefined();
  });

  test("children are NOT recursive (only direct children)", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Test Document",
      include_children: true,
    });
    const matches = result.matches as Record<string, unknown>[];
    const rootMatch = matches.find((m) => m.node_id === "root")!;
    const children = rootMatch.children as Record<string, unknown>[];
    // Root's direct children are n1, n2, n3. No grandchildren should appear.
    for (const child of children) {
      expect(child.children).toBeUndefined();
    }
  });

  // ─── Section 5d: size warnings ────────────────────────────────────

  test("bypass_warning true on small result: rejected with preemptive usage message", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First",
      bypass_warning: true,
    });
    expect(result.warning).toBeDefined();
    const warning = result.warning as string;
    expect(warning).toContain("preemptively");
  });

  // ─── Section 5e: response shape ──────────────────────────────────

  test("response includes file_id, title, url, count, query, matches", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(typeof result.url).toBe("string");
    expect(typeof result.count).toBe("number");
    expect(typeof result.query).toBe("string");
    expect(Array.isArray(result.matches)).toBe(true);
  });

  test("each match includes node_id, content, url", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(typeof match.node_id).toBe("string");
      expect(typeof match.content).toBe("string");
      expect(typeof match.url).toBe("string");
    }
  });

  test("match includes note only when non-empty", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child",
      search_notes: true,
    });
    const matches = result.matches as Record<string, unknown>[];
    // n1b has a note, n1a does not.
    const n1b = matches.find((m) => m.node_id === "n1b");
    const n1a = matches.find((m) => m.node_id === "n1a");
    if (n1b) {
      expect(n1b.note).toBe("A note on child B");
    }
    if (n1a) {
      expect(n1a.note).toBeUndefined();
    }
  });
});

// ─── get_recent_changes ──────────────────────────────────────────────

describe("get_recent_changes", () => {
  test("finds nodes within time range (default type: both)", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
    });
    expect(result.file_id).toBe("doc1");
    // Default type is "both", so freshly created nodes are included.
    expect(result.count).toBeGreaterThan(0);
  });

  test("type: modified excludes freshly created nodes", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      type: "modified",
    });
    // All nodes in the dummy server have created === modified, so
    // the "modified" filter (which excludes nodes created in range)
    // should return 0.
    expect(result.count).toBe(0);
  });

  test("future since returns no matches", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: Date.now() + 100000,
    });
    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
  });

  test("invalid file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "get_recent_changes", {
      file_id: "nonexistent",
      since: 0,
    });
    expect(err.error).toBe("NotFound");
  });

  // ─── Section 6a: additional basic behavior tests ───────────────────

  test("type: created excludes modified-only nodes", async () => {
    // Edit a node so its modified time differs from created.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    // Set created to a time in the past.
    const pastTime = Date.now() - 100000;
    n1.created = pastTime;
    // But modified is recent.
    n1.modified = Date.now();

    // Query with type: created, since the recent time.
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: Date.now() - 1000,
      type: "created",
    });
    const matches = result.matches as Record<string, unknown>[];
    // n1 was created in the past, so it should not appear for type: created
    // in the recent time range.
    expect(matches.some((m) => m.node_id === "n1")).toBe(false);
  });

  test("type: both returns both created and modified", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      type: "both",
    });
    // All nodes were created recently, so they should all appear.
    expect(result.count).toBeGreaterThan(0);
  });

  test("each match includes change_type field", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(["created", "modified"]).toContain(match.change_type as string);
    }
  });

  // ─── Section 6b: date parsing ──────────────────────────────────────

  test("since as millisecond timestamp: exact match", async () => {
    const now = Date.now();
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: now + 100000,
    });
    // Future timestamp, nothing should match.
    expect(result.count).toBe(0);
  });

  test("invalid date format: returns InvalidInput error", async () => {
    const err = await callToolError(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "not-a-date",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("since after until: returns empty matches", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: Date.now() + 100000,
      until: Date.now() - 100000,
    });
    expect(result.count).toBe(0);
  });

  // ─── Section 6c: sorting ──────────────────────────────────────────

  test("sort newest_first: descending by timestamp", async () => {
    // Create nodes with different timestamps.
    const doc = ctx.server.documents.get("doc1")!;
    const nodes = doc.nodes;
    const baseTime = Date.now() - 10000;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].created = baseTime + i * 1000;
      nodes[i].modified = baseTime + i * 1000;
    }

    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      sort: "newest_first",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (let i = 1; i < matches.length; i++) {
      const prevTime = (matches[i - 1].created as number);
      const currTime = (matches[i].created as number);
      expect(prevTime).toBeGreaterThanOrEqual(currTime);
    }
  });

  test("sort oldest_first: ascending by timestamp", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const nodes = doc.nodes;
    const baseTime = Date.now() - 10000;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].created = baseTime + i * 1000;
      nodes[i].modified = baseTime + i * 1000;
    }

    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      sort: "oldest_first",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (let i = 1; i < matches.length; i++) {
      const prevTime = (matches[i - 1].created as number);
      const currTime = (matches[i].created as number);
      expect(prevTime).toBeLessThanOrEqual(currTime);
    }
  });

  // ─── Section 6d: parent context ───────────────────────────────────

  test("parent_levels 0: no parent context", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      parent_levels: 0,
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(match.parents).toBeUndefined();
    }
  });

  test("parent_levels 1 (default): one parent", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      parent_levels: 1,
    });
    const matches = result.matches as Record<string, unknown>[];
    // n1a should have parent n1.
    const n1a = matches.find((m) => m.node_id === "n1a");
    if (n1a && n1a.parents) {
      const parents = n1a.parents as Record<string, unknown>[];
      expect(parents).toHaveLength(1);
      expect(parents[0].node_id).toBe("n1");
    }
  });

  test("parent_levels 2: two parents", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      parent_levels: 2,
    });
    const matches = result.matches as Record<string, unknown>[];
    const n1a = matches.find((m) => m.node_id === "n1a");
    if (n1a && n1a.parents) {
      const parents = n1a.parents as Record<string, unknown>[];
      expect(parents).toHaveLength(2);
      expect(parents[0].node_id).toBe("n1");
      expect(parents[1].node_id).toBe("root");
    }
  });

  // ─── Section 6e: size warnings ────────────────────────────────────

  test("bypass_warning true on small result: rejected as preemptive", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
      bypass_warning: true,
    });
    expect(result.warning).toBeDefined();
    const warning = result.warning as string;
    expect(warning).toContain("preemptively");
  });

  // ─── Section 6f: response shape ───────────────────────────────────

  test("response includes file_id, title, url, count, matches", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(typeof result.url).toBe("string");
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.matches)).toBe(true);
  });

  test("each match includes node_id, content, created, modified, change_type, url", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(typeof match.node_id).toBe("string");
      expect(typeof match.content).toBe("string");
      expect(typeof match.created).toBe("number");
      expect(typeof match.modified).toBe("number");
      expect(typeof match.change_type).toBe("string");
      expect(typeof match.url).toBe("string");
    }
  });

  test("note included only when non-empty", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
    });
    const matches = result.matches as Record<string, unknown>[];
    // n1b has a note. Other nodes do not.
    const n1b = matches.find((m) => m.node_id === "n1b");
    if (n1b) {
      expect(n1b.note).toBe("A note on child B");
    }
    const n1a = matches.find((m) => m.node_id === "n1a");
    if (n1a) {
      expect(n1a.note).toBeUndefined();
    }
  });
});

// ─── check_document_versions ─────────────────────────────────────────

describe("check_document_versions", () => {
  test("returns versions for valid documents", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1", "doc2"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.doc1).toBeGreaterThan(0);
    expect(versions.doc2).toBeGreaterThan(0);
  });

  test("non-existent document gets -1 version", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["nonexistent"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.nonexistent).toBe(-1);
  });

  test("version increments after edits", async () => {
    const before = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1"],
    });
    const v1 = (before.versions as Record<string, number>).doc1;

    // Edit the document.
    await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated",
    });

    const after = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1"],
    });
    const v2 = (after.versions as Record<string, number>).doc1;
    expect(v2).toBeGreaterThan(v1);
  });

  test("empty file_ids returns empty versions", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: [],
    });
    expect(result.versions).toEqual({});
  });

  // ─── Section 9a: additional tests ─────────────────────────────────

  test("multiple documents in single call: all versions returned", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1", "doc2", "inbox_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(typeof versions.doc1).toBe("number");
    expect(typeof versions.doc2).toBe("number");
    expect(typeof versions.inbox_doc).toBe("number");
  });

  test("response shape: versions is a record of string to number", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1"],
    });
    expect(result.versions).toBeDefined();
    const versions = result.versions as Record<string, number>;
    for (const [key, value] of Object.entries(versions)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("number");
    }
  });
});
