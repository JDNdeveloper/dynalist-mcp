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
});
