import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  getSyncToken,
  standardSetup,
  type TestContext,
} from "./test-helpers";
import { DummyDynalistServer } from "../dummy-server";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ─── list_documents ──────────────────────────────────────────────────

/**
 * Helper to find a file entry by file_id within a recursive files tree.
 */
function findFile(files: Record<string, unknown>[], fileId: string): Record<string, unknown> | undefined {
  for (const f of files) {
    if (f.file_id === fileId) return f;
    if (Array.isArray(f.children)) {
      const found = findFile(f.children as Record<string, unknown>[], fileId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Collect all entries from a recursive files tree into a flat array.
 */
function flattenFiles(files: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const f of files) {
    result.push(f);
    if (Array.isArray(f.children)) {
      result.push(...flattenFiles(f.children as Record<string, unknown>[]));
    }
  }
  return result;
}

describe("list_documents", () => {
  // ─── Basic listing from root ──────────────────────────────────────

  test("returns recursive file tree with correct document count", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    // Three documents: doc1, doc2, inbox_doc.
    expect(result.count).toBe(3);
    expect(Array.isArray(result.files)).toBe(true);
    // Root folder is not included in the output.
    const files = result.files as Record<string, unknown>[];
    expect(findFile(files, "root_folder")).toBeUndefined();
  });

  test("documents have file_id, title, type, permission", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const doc1 = findFile(result.files as Record<string, unknown>[], "doc1");
    expect(doc1).toBeDefined();
    expect(doc1!.title).toBe("Test Document");
    expect(doc1!.type).toBe("document");
    expect(doc1!.permission).toBe("owner");
  });

  test("folders have file_id, title, type, child_count, children array", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folderA = findFile(result.files as Record<string, unknown>[], "folder_a");
    expect(folderA).toBeDefined();
    expect(folderA!.title).toBe("Folder A");
    expect(folderA!.type).toBe("folder");
    expect(folderA!.child_count).toBe(1);
    expect(Array.isArray(folderA!.children)).toBe(true);
    // doc1 should be inside folder_a's children.
    const children = folderA!.children as Record<string, unknown>[];
    expect(children).toHaveLength(1);
    const doc1 = children.find((c) => c.file_id === "doc1");
    expect(doc1).toBeDefined();
  });

  test("count reflects document count, not folder count", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    expect(result.count).toBe(3);
  });

  // ─── folder_id parameter ──────────────────────────────────────────

  test("folder_id scopes listing to that folder's children", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      folder_id: "folder_a",
    });
    const files = result.files as Record<string, unknown>[];
    // folder_a contains doc1. The folder itself is not in the output.
    expect(findFile(files, "folder_a")).toBeUndefined();
    expect(files.some((f) => f.file_id === "doc1")).toBe(true);
    expect(result.count).toBe(1);
  });

  test("folder_id pointing to a document returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "list_documents", {
      folder_id: "doc1",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("invalid folder_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "list_documents", {
      folder_id: "nonexistent",
    });
    expect(err.error).toBe("NotFound");
  });

  // ─── max_depth behavior ───────────────────────────────────────────

  test("max_depth: null (default) returns full recursive tree", async () => {
    // Add a nested folder with a document inside folder_a.
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");
    ctx.server.addDocument("nested_doc", "Nested Doc", "folder_nested", [
      ctx.server.makeNode("root", "Nested Doc", []),
    ]);

    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const nestedDoc = findFile(result.files as Record<string, unknown>[], "nested_doc");
    expect(nestedDoc).toBeDefined();
    expect(nestedDoc!.title).toBe("Nested Doc");
    // No depth_limited markers anywhere.
    const all = flattenFiles(result.files as Record<string, unknown>[]);
    for (const f of all) {
      expect(f.depth_limited).toBeUndefined();
    }
  });

  test("max_depth: 0 returns empty files array", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 0,
    });
    const files = result.files as Record<string, unknown>[];
    expect(files).toEqual([]);
    expect(result.count).toBe(0);
  });

  test("max_depth: 1 returns direct children, sub-folders depth-limited", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 1,
    });
    const files = result.files as Record<string, unknown>[];

    // folder_a should be present but depth-limited.
    const folderA = files.find((f) => f.file_id === "folder_a");
    expect(folderA).toBeDefined();
    expect(folderA!.depth_limited).toBe(true);
    expect(folderA!.child_count).toBe(1);
    expect(folderA!.children).toBeUndefined();

    // inbox_doc should be present as a top-level document.
    const inbox = files.find((f) => f.file_id === "inbox_doc");
    expect(inbox).toBeDefined();
    expect(inbox!.type).toBe("document");

    // Documents at depth 1 are counted, but nested docs are not.
    expect(result.count).toBe(1);
  });

  test("max_depth: 2 returns two levels deep", async () => {
    // Add a nested folder with a document inside folder_a.
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");
    ctx.server.addDocument("nested_doc", "Nested Doc", "folder_nested", [
      ctx.server.makeNode("root", "Nested Doc", []),
    ]);

    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 2,
    });
    const files = result.files as Record<string, unknown>[];
    const folderA = files.find((f) => f.file_id === "folder_a");
    expect(folderA).toBeDefined();
    expect(folderA!.depth_limited).toBeUndefined();

    // folder_a's children should be visible.
    const folderAChildren = folderA!.children as Record<string, unknown>[];
    const doc1 = folderAChildren.find((c) => c.file_id === "doc1");
    expect(doc1).toBeDefined();

    // folder_nested should be depth-limited at depth 2.
    const nested = folderAChildren.find((c) => c.file_id === "folder_nested");
    expect(nested).toBeDefined();
    expect(nested!.depth_limited).toBe(true);
    expect(nested!.child_count).toBe(1);
    expect(nested!.children).toBeUndefined();
  });

  // ─── Nested folder structures ─────────────────────────────────────

  test("nested folders appear inside parent folder's children", async () => {
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");

    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folderA = findFile(result.files as Record<string, unknown>[], "folder_a");
    expect(folderA).toBeDefined();
    const children = folderA!.children as Record<string, unknown>[];
    const nested = children.find((c) => c.file_id === "folder_nested");
    expect(nested).toBeDefined();
    expect(nested!.type).toBe("folder");
  });

  test("empty folders have empty children array", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folderB = findFile(result.files as Record<string, unknown>[], "folder_b");
    expect(folderB).toBeDefined();
    // folder_b only contains doc2.
    const children = folderB!.children as Record<string, unknown>[];
    expect(children.length).toBe(1);

    // Add a truly empty folder.
    ctx.server.addFolder("empty_folder", "Empty Folder", "root_folder");
    const result2 = await callToolOk(ctx.mcpClient, "list_documents");
    const empty = findFile(result2.files as Record<string, unknown>[], "empty_folder");
    expect(empty).toBeDefined();
    expect(empty!.child_count).toBe(0);
    expect(empty!.children).toBeUndefined();
  });

  // ─── Order preservation ───────────────────────────────────────────

  test("files appear in parent folder's children order", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    // Root's children order from standardSetup: folder_a, folder_b, inbox_doc.
    const fileIds = files.map((f) => f.file_id);
    const folderAIdx = fileIds.indexOf("folder_a");
    const folderBIdx = fileIds.indexOf("folder_b");
    const inboxIdx = fileIds.indexOf("inbox_doc");
    expect(folderAIdx).toBeLessThan(folderBIdx);
    expect(folderBIdx).toBeLessThan(inboxIdx);
  });

  // ─── Count accuracy ──────────────────────────────────────────────

  test("count only counts documents, not folders", async () => {
    ctx.server.addFolder("extra_folder", "Extra Folder", "root_folder");
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    // Still 3 documents (doc1, doc2, inbox_doc). Extra folder does not count.
    expect(result.count).toBe(3);
  });

  test("count includes documents in nested folders", async () => {
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");
    ctx.server.addDocument("nested_doc", "Nested Doc", "folder_nested", [
      ctx.server.makeNode("root", "Nested Doc", []),
    ]);
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    // 3 original + 1 nested = 4.
    expect(result.count).toBe(4);
  });

  // ─── depth_limited signaling ──────────────────────────────────────

  test("depth_limited omitted on expanded folders; child_count always present on folders", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    // Documents should not have depth_limited or child_count.
    const inbox = findFile(files, "inbox_doc");
    expect(inbox).toBeDefined();
    expect(inbox!.depth_limited).toBeUndefined();
    expect(inbox!.child_count).toBeUndefined();

    // Expanded folders: child_count present, depth_limited absent.
    const folderA = findFile(files, "folder_a");
    expect(folderA).toBeDefined();
    expect(folderA!.depth_limited).toBeUndefined();
    expect(folderA!.child_count).toBe(1);
  });

  // ─── folder_id + max_depth combined ─────────────────────────────────

  test("folder_id with max_depth: 1 shows only direct children of target folder", async () => {
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");
    ctx.server.addDocument("nested_doc", "Nested Doc", "folder_nested", [
      ctx.server.makeNode("root", "Nested Doc", []),
    ]);

    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      folder_id: "folder_a",
      max_depth: 1,
    });
    const files = result.files as Record<string, unknown>[];

    // doc1 is a direct child of folder_a and should be visible.
    const doc1 = files.find((f) => f.file_id === "doc1");
    expect(doc1).toBeDefined();
    expect(doc1!.type).toBe("document");

    // folder_nested is a direct child but should be depth-limited.
    const nested = files.find((f) => f.file_id === "folder_nested");
    expect(nested).toBeDefined();
    expect(nested!.depth_limited).toBe(true);
    expect(nested!.child_count).toBe(1);
    expect(nested!.children).toBeUndefined();

    // nested_doc should not appear anywhere.
    expect(findFile(files, "nested_doc")).toBeUndefined();
    expect(result.count).toBe(1);
  });

  test("folder_id with max_depth: 0 returns empty files", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      folder_id: "folder_a",
      max_depth: 0,
    });
    expect(result.files).toEqual([]);
    expect(result.count).toBe(0);
  });

  test("folder_id pointing to empty folder returns empty files", async () => {
    ctx.server.addFolder("empty_folder", "Empty", "root_folder");
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      folder_id: "empty_folder",
    });
    expect(result.files).toEqual([]);
    expect(result.count).toBe(0);
  });

  test("empty folder has child_count: 0 and no children array", async () => {
    ctx.server.addFolder("empty_folder", "Empty", "root_folder");
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const empty = findFile(result.files as Record<string, unknown>[], "empty_folder");
    expect(empty).toBeDefined();
    expect(empty!.child_count).toBe(0);
    expect(empty!.children).toBeUndefined();
  });

  // ─── Deep nesting (3+ levels) ──────────────────────────────────────

  test("max_depth: 3 with 4-level nesting truncates at the right level", async () => {
    // Build: root -> folder_a -> level2 -> level3 -> deep_doc.
    ctx.server.addFolder("level2", "Level 2", "folder_a");
    ctx.server.addFolder("level3", "Level 3", "level2");
    ctx.server.addDocument("deep_doc", "Deep Doc", "level3", [
      ctx.server.makeNode("root", "Deep Doc", []),
    ]);

    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 3,
    });
    const files = result.files as Record<string, unknown>[];

    // Depth 1: folder_a visible, not depth-limited.
    const folderA = files.find((f) => f.file_id === "folder_a");
    expect(folderA).toBeDefined();
    expect(folderA!.depth_limited).toBeUndefined();

    // Depth 2: level2 visible inside folder_a, not depth-limited.
    const folderAChildren = folderA!.children as Record<string, unknown>[];
    const level2 = folderAChildren.find((c) => c.file_id === "level2");
    expect(level2).toBeDefined();
    expect(level2!.depth_limited).toBeUndefined();

    // Depth 3: level3 visible inside level2, IS depth-limited.
    const level2Children = level2!.children as Record<string, unknown>[];
    const level3 = level2Children.find((c) => c.file_id === "level3");
    expect(level3).toBeDefined();
    expect(level3!.depth_limited).toBe(true);
    expect(level3!.child_count).toBe(1);
    expect(level3!.children).toBeUndefined();

    // deep_doc should not be reachable.
    expect(findFile(files, "deep_doc")).toBeUndefined();

    // Count: doc1 (depth 2) + inbox_doc (depth 1) + doc2 (depth 2) = 3.
    // deep_doc is hidden behind depth limit.
    expect(result.count).toBe(3);
  });

  // ─── Count with max_depth truncation ──────────────────────────────

  test("count excludes documents hidden by max_depth", async () => {
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");
    ctx.server.addDocument("nested_doc", "Nested Doc", "folder_nested", [
      ctx.server.makeNode("root", "Nested Doc", []),
    ]);

    // With unlimited depth, all 4 docs are counted.
    const full = await callToolOk(ctx.mcpClient, "list_documents");
    expect(full.count).toBe(4);

    // With max_depth: 1, only top-level documents are counted.
    const shallow = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 1,
    });
    expect(shallow.count).toBe(1);

    // With max_depth: 2, docs in folder_a and folder_b are visible.
    const medium = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 2,
    });
    // inbox_doc (depth 1) + doc1 (depth 2) + doc2 (depth 2) = 3.
    // nested_doc is at depth 3 (root -> folder_a -> folder_nested -> nested_doc).
    expect(medium.count).toBe(3);
  });

  // ─── folder_id + count with nested docs ────────────────────────────

  test("folder_id count includes all visible nested documents", async () => {
    ctx.server.addFolder("folder_nested", "Nested Folder", "folder_a");
    ctx.server.addDocument("nested_doc", "Nested Doc", "folder_nested", [
      ctx.server.makeNode("root", "Nested Doc", []),
    ]);

    // Unlimited depth from folder_a: doc1 + nested_doc = 2.
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      folder_id: "folder_a",
    });
    expect(result.count).toBe(2);

    // max_depth: 1 from folder_a: only doc1 visible.
    const shallow = await callToolOk(ctx.mcpClient, "list_documents", {
      folder_id: "folder_a",
      max_depth: 1,
    });
    expect(shallow.count).toBe(1);
  });
});

// ─── search_documents ────────────────────────────────────────────────

describe("search_documents", () => {
  test("finds documents by name using literal string pattern", async () => {
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

  test("query is not echoed back in response", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "test" });
    expect(result.query).toBeUndefined();
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

  test("empty query matches all files", async () => {
    // Empty regex matches every string.
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "" });
    // standardSetup creates 3 docs + 2 folders = 5 total files.
    expect(result.count).toBeGreaterThanOrEqual(5);
  });

  test("regex anchor matches only titles starting with pattern", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "^Test" });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.every((m) => (m.title as string).startsWith("Test"))).toBe(true);
  });

  test("regex alternation matches multiple patterns", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "Folder A|Folder B" });
    const titles = (result.matches as Record<string, unknown>[]).map((m) => m.title);
    expect(titles).toContain("Folder A");
    expect(titles).toContain("Folder B");
  });

  test("case_sensitive true: uppercase pattern does not match lowercase title", async () => {
    // "TEST" should not match "Test Document" with case_sensitive enabled.
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "TEST DOCUMENT", case_sensitive: true });
    expect(result.count).toBe(0);
  });

  test("case_sensitive false (default): uppercase pattern matches mixed-case title", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", { query: "TEST DOCUMENT", case_sensitive: false });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.title === "Test Document")).toBe(true);
  });

  test("invalid regex returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "search_documents", { query: "[invalid" });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toMatch(/Invalid regex pattern/);
  });
});

// ─── read_document ───────────────────────────────────────────────────

describe("read_document", () => {
  test("returns structured tree with required fields", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(result.file_id).toBe("doc1");
    expect(result.title).toBe("Test Document");
    expect(result.item).toBeDefined();
  });

  test("node tree has correct structure", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    expect(node.item_id).toBe("root");
    expect(node.content).toBe("Test Document");
    expect(node.child_count).toBe(3);
    const children = node.children as Record<string, unknown>[];
    expect(children).toHaveLength(3);
  });

  test("starting from specific item_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      item_id: "n1",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    expect(node.item_id).toBe("n1");
    expect(node.content).toBe("First item");
    expect((node.children as Record<string, unknown>[]).length).toBe(2);
  });

  test("invalid item_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      item_id: "nonexistent",
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

  test("response includes file_id, title at top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
  });

  test("every node includes item_id, content; child_count/children present on non-leaves only", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });

    function checkNodeFields(node: Record<string, unknown>) {
      expect(typeof node.item_id).toBe("string");
      expect(typeof node.content).toBe("string");
      const children = node.children as Record<string, unknown>[] | undefined;
      if (children && children.length > 0) {
        // Expanded non-leaf: child_count and children both present.
        expect(typeof node.child_count).toBe("number");
        expect(Array.isArray(node.children)).toBe(true);
      } else if (node.child_count !== undefined) {
        // Non-leaf with hidden children (depth-limited or collapsed): children omitted.
        expect(node.children).toBeUndefined();
      } else {
        // Leaf: both omitted.
        expect(node.child_count).toBeUndefined();
        expect(node.children).toBeUndefined();
      }
      // collapsed is omitted when false.
      if ("collapsed" in node) {
        expect(node.collapsed).toBe(true);
      }
      if (children) {
        for (const child of children) {
          checkNodeFields(child);
        }
      }
    }
    checkNodeFields(result.item as Record<string, unknown>);
  });

  test("optional fields omitted when default values", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    // n1a has no note, no checkbox, no heading, no color.
    const n1a = rootChildren
      .flatMap((c) => (c.children as Record<string, unknown>[]) || [])
      .find((c) => c.item_id === "n1a")!;
    expect(n1a).toBeDefined();
    // note should be omitted (empty string in source).
    expect(n1a.note).toBeUndefined();
    // collapsed should be omitted when false.
    expect(n1a.collapsed).toBeUndefined();
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    const n1Children = n1.children as Record<string, unknown>[];
    // n1b has a note.
    const n1b = n1Children.find((c) => c.item_id === "n1b")!;
    expect(n1b.note).toBe("A note on child B");
    // n1a has no note.
    const n1a = n1Children.find((c) => c.item_id === "n1a")!;
    expect(n1a.note).toBeUndefined();
  });

  test("show_checkbox present only when true", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    // n3 has show_checkbox: true in MCP output.
    const n3 = rootChildren.find((c) => c.item_id === "n3")!;
    expect(n3.show_checkbox).toBe(true);
    // n1 does not have show_checkbox.
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1.show_checkbox).toBeUndefined();
  });

  test("checked present only when true", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    // n3 has checked: true.
    const n3 = rootChildren.find((c) => c.item_id === "n3")!;
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.heading).toBe("h2");
    // n2 has no heading set.
    const n2Result = rootChildren.find((c) => c.item_id === "n2")!;
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n2Result = rootChildren.find((c) => c.item_id === "n2")!;
    expect(n2Result.color).toBe("yellow");
    // n1 has no color.
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.color).toBeUndefined();
  });

  test("root node has content equal to document title", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 0,
    });
    const node = result.item as Record<string, unknown>;
    expect(node.content).toBe("Test Document");
  });


  // ─── max_depth behavior ──────────────────────────────────────────

  test("max_depth: 0 returns only target node", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 0,
    });
    const node = result.item as Record<string, unknown>;
    expect(node.item_id).toBe("root");
    expect(node.children).toBeUndefined();
    expect(node.child_count).toBe(3);
    expect(node.depth_limited).toBe(true);
  });

  test("max_depth: 1 returns target + immediate children", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    expect(children).toHaveLength(3);

    // n1 has children but they should be omitted at depth 1.
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.children).toBeUndefined();
    expect(n1.child_count).toBe(2);
    expect(n1.depth_limited).toBe(true);

    // n3 is a leaf at depth 1: child_count/children omitted, no depth_limited.
    const n3 = children.find((c) => c.item_id === "n3")!;
    expect(n3.children).toBeUndefined();
    expect(n3.child_count).toBeUndefined();
    expect(n3.depth_limited).toBeUndefined();
  });

  test("large max_depth returns full tree", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 100,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect((n1.children as Record<string, unknown>[]).length).toBe(2);
  });

  test("max_depth: null (unlimited) returns full tree", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: null,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect((n1.children as Record<string, unknown>[]).length).toBe(2);
    // No depth_limited anywhere since depth is unlimited.
    expect(n1.depth_limited).toBeUndefined();
  });

  test("max_depth: null bypasses config default on deep trees", async () => {
    // Build a tree deeper than the config default (3) to verify that
    // null actually means unlimited rather than falling through to the default.
    const doc = ctx.server.documents.get("doc1")!;
    let parentId = "n1a";
    for (let i = 0; i < 8; i++) {
      const childId = `deep_${i}`;
      doc.nodes.push(ctx.server.makeNode(childId, `Deep level ${i}`, []));
      const parent = doc.nodes.find((n) => n.id === parentId)!;
      parent.children!.push(childId);
      parentId = childId;
    }

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: null,
    });

    // Walk down to the deepest node to confirm nothing was depth-limited.
    const current = result.item as Record<string, unknown>;
    function findChild(node: Record<string, unknown>, id: string): Record<string, unknown> | null {
      const children = node.children as Record<string, unknown>[];
      for (const child of children) {
        if (child.item_id === id) return child;
        const found = findChild(child, id);
        if (found) return found;
      }
      return null;
    }

    const deepest = findChild(current, "deep_7");
    expect(deepest).not.toBeNull();
    expect(deepest!.depth_limited).toBeUndefined();
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    const n1Children = n1.children as Record<string, unknown>[];
    // Children are at depth 2, so they should be present.
    expect(n1Children.length).toBe(2);
    // But grandchildren of n1 (great-grandchild at depth 3) should not be.
    const n1aResult = n1Children.find((c) => c.item_id === "n1a")!;
    expect(n1aResult.children).toBeUndefined();
    expect(n1aResult.child_count).toBe(1);
    expect(n1aResult.depth_limited).toBe(true);
  });

  test("non-collapsed node at max_depth with children: depth_limited true, children omitted", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1.depth_limited).toBe(true);
    expect(n1.child_count).toBe(2);
    expect(n1.children).toBeUndefined();
  });

  test("non-collapsed leaf node at max_depth: no depth_limited flag, child fields omitted", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n3 = rootChildren.find((c) => c.item_id === "n3")!;
    expect(n3.children).toBeUndefined();
    expect(n3.child_count).toBeUndefined();
    expect(n3.depth_limited).toBeUndefined();
  });

  // ─── collapsed children filtering ────────────────────────────────

  test("starting node always shows children even when collapsed", async () => {
    // Reading a collapsed node directly by item_id should always reveal its
    // children, matching the Dynalist UI zoom behavior.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      item_id: "n1",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    expect(node.collapsed).toBe(true);
    expect((node.children as Record<string, unknown>[]).length).toBe(2);
    expect(node.child_count).toBe(2);
  });

  test("collapsed node hides children by default", async () => {
    // Make n1 collapsed.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toBeUndefined();
    expect(n1Result.child_count).toBe(2);
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect((n1Result.children as Record<string, unknown>[]).length).toBe(2);
    expect(n1Result.child_count).toBe(2);
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toBeUndefined();
    // Collapsed takes precedence over depth_limited.
    expect(n1Result.depth_limited).toBeUndefined();
  });

  test("non-collapsed node at max_depth with children shows depth_limited", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1.collapsed).toBeUndefined();
    expect(n1.depth_limited).toBe(true);
    expect(n1.children).toBeUndefined();
    expect(n1.child_count).toBe(2);
  });

  test("non-collapsed leaf at max_depth: no depth_limited, child fields omitted", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n3 = rootChildren.find((c) => c.item_id === "n3")!;
    expect(n3.children).toBeUndefined();
    expect(n3.child_count).toBeUndefined();
    expect(n3.depth_limited).toBeUndefined();
  });

  test("child_count always matches actual children regardless of visibility", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    // n1 has 2 children, even though they are hidden.
    expect(n1Result.child_count).toBe(2);
    expect(n1Result.children).toBeUndefined();
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    // Outer collapsed node hides children, so inner is not visible.
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toBeUndefined();
    expect(n1Result.child_count).toBe(2);
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect((n1Result.children as Record<string, unknown>[]).length).toBe(2);
    const n1aResult = (n1Result.children as Record<string, unknown>[]).find((c) => c.item_id === "n1a")!;
    expect(n1aResult.collapsed).toBe(true);
    expect((n1aResult.children as Record<string, unknown>[]).length).toBe(1);
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toBeUndefined();
    expect(n1Result.depth_limited).toBeUndefined();
  });

  test("collapsed leaf node includes child_count: 0 so agents know there are no hidden children", async () => {
    // n3 is a leaf (no children). Make it collapsed.
    const doc = ctx.server.documents.get("doc1")!;
    const n3 = doc.nodes.find((n) => n.id === "n3")!;
    n3.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n3Result = rootChildren.find((c) => c.item_id === "n3")!;
    expect(n3Result.collapsed).toBe(true);
    // Even though n3 has no children, child_count is present to disambiguate
    // "collapsed with no children" from "collapsed with hidden children".
    expect(n3Result.child_count).toBe(0);
    expect(n3Result.children).toBeUndefined();
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toBeUndefined();
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toBeUndefined();
    expect(n1Result.child_count).toBe(2);
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    // Children at depth 2 ARE shown.
    expect((n1Result.children as Record<string, unknown>[]).length).toBe(2);
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.child_count).toBe(2);
    expect(n1Result.children).toBeUndefined();
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.collapsed).toBe(true);
    expect(n1Result.children).toBeUndefined();
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    const n1aResult = (n1Result.children as Record<string, unknown>[]).find((c) => c.item_id === "n1a")!;
    // n1a is at depth 2, which is the limit, and it has children.
    expect(n1aResult.depth_limited).toBe(true);
    expect(n1aResult.children).toBeUndefined();
    expect(n1aResult.child_count).toBe(1);
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
      for (const child of (node.children ?? []) as Record<string, unknown>[]) {
        checkNoNotes(child);
      }
    }
    checkNoNotes(result.item as Record<string, unknown>);
  });

  test("include_checked: false filters out checked nodes", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_checked: false,
    });
    const rootNode = result.item as Record<string, unknown>;
    const children = rootNode.children as Record<string, unknown>[];
    // n3 is checked and should be filtered out.
    const n3 = children.find((c) => c.item_id === "n3");
    expect(n3).toBeUndefined();
  });

  // ─── Section 4e: additional notes tests ────────────────────────────

  test("include_notes: true (default) shows notes on nodes that have them", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_notes: true,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    const n1b = (n1.children as Record<string, unknown>[]).find((c) => c.item_id === "n1b")!;
    expect(n1b.note).toBe("A note on child B");
  });

  test("include_notes: false removes note field entirely", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_notes: false,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    const n1b = (n1.children as Record<string, unknown>[]).find((c) => c.item_id === "n1b")!;
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
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    // n3 should be filtered out.
    expect(rootChildren.find((c) => c.item_id === "n3")).toBeUndefined();
    // n3a should also not appear anywhere.
    function findNode(node: Record<string, unknown>, id: string): boolean {
      if (node.item_id === id) return true;
      for (const child of (node.children as Record<string, unknown>[]) || []) {
        if (findNode(child, id)) return true;
      }
      return false;
    }
    expect(findNode(result.item as Record<string, unknown>, "n3a")).toBe(false);
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
    expect(warning).toContain("item_id");
  });

  test("document under warning threshold: no warning", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    expect(result.warning).toBeUndefined();
    expect(result.item).toBeDefined();
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
    expect(second.item).toBeDefined();
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

  // ─── Section 4h: child_count invariant ──────────────────────────

  test("child_count correct when children hidden by collapsed state", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    n1.collapsed = true;

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1Result = rootChildren.find((c) => c.item_id === "n1")!;
    expect(n1Result.child_count).toBe(2);
    expect(n1Result.children).toBeUndefined();
  });

  test("child_count correct when children hidden by depth limit", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 0,
    });
    const root = result.item as Record<string, unknown>;
    expect(root.child_count).toBe(3);
    expect(root.children).toBeUndefined();
  });

  test("child_count matches children array length when include_checked false", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_checked: false,
    });
    const root = result.item as Record<string, unknown>;
    // child_count matches the rendered children array length, not the
    // source count. n3 is checked and excluded, so both are 2.
    expect(root.child_count).toBe(2);
    expect((root.children as Record<string, unknown>[]).length).toBe(2);
  });

  test("parent with all children filtered appears as leaf", async () => {
    // Create a document where a parent's only children are all checked.
    const allCheckedCtx = await createTestContext((server) => {
      server.addFolder("folder_a", "Folder A", "root_folder");
      server.addDocument("doc_ac", "All Checked Doc", "folder_a", [
        server.makeNode("root", "Root", ["p1"]),
        server.makeNode("p1", "Parent", ["c1", "c2"]),
        server.makeNode("c1", "Checked A", [], { checked: true, checkbox: true }),
        server.makeNode("c2", "Checked B", [], { checked: true, checkbox: true }),
      ]);
    });
    try {
      const result = await callToolOk(allCheckedCtx.mcpClient, "read_document", {
        file_id: "doc_ac",
        max_depth: 10,
        include_checked: false,
      });
      const root = result.item as Record<string, unknown>;
      const children = root.children as Record<string, unknown>[];
      const p1 = children.find((c) => c.item_id === "p1")!;
      // All children filtered out, so p1 appears as a leaf.
      expect(p1.child_count).toBeUndefined();
      expect(p1.children).toBeUndefined();
    } finally {
      await allCheckedCtx.cleanup();
    }
  });

  test("depth-limited child_count uses filtered count with include_checked false", async () => {
    // Parent has 3 children (2 unchecked, 1 checked). Depth-limited at parent level.
    const mixedCtx = await createTestContext((server) => {
      server.addFolder("folder_a", "Folder A", "root_folder");
      server.addDocument("doc_mix", "Mixed Doc", "folder_a", [
        server.makeNode("root", "Root", ["p1"]),
        server.makeNode("p1", "Parent", ["c1", "c2", "c3"]),
        server.makeNode("c1", "Unchecked A", []),
        server.makeNode("c2", "Checked B", [], { checked: true, checkbox: true }),
        server.makeNode("c3", "Unchecked C", []),
      ]);
    });
    try {
      const result = await callToolOk(mixedCtx.mcpClient, "read_document", {
        file_id: "doc_mix",
        max_depth: 1,
        include_checked: false,
      });
      const root = result.item as Record<string, unknown>;
      const children = root.children as Record<string, unknown>[];
      const p1 = children.find((c) => c.item_id === "p1")!;
      // Depth-limited, so children are hidden. child_count is the filtered count (2),
      // not the source total (3).
      expect(p1.depth_limited).toBe(true);
      expect(p1.child_count).toBe(2);
      expect(p1.children).toBeUndefined();
    } finally {
      await mixedCtx.cleanup();
    }
  });

  test("depth-limited node with all children checked becomes leaf with include_checked false", async () => {
    const allCheckedCtx = await createTestContext((server) => {
      server.addFolder("folder_a", "Folder A", "root_folder");
      server.addDocument("doc_acd", "All Checked Depth", "folder_a", [
        server.makeNode("root", "Root", ["p1"]),
        server.makeNode("p1", "Parent", ["c1", "c2"]),
        server.makeNode("c1", "Checked A", [], { checked: true, checkbox: true }),
        server.makeNode("c2", "Checked B", [], { checked: true, checkbox: true }),
      ]);
    });
    try {
      const result = await callToolOk(allCheckedCtx.mcpClient, "read_document", {
        file_id: "doc_acd",
        max_depth: 1,
        include_checked: false,
      });
      const root = result.item as Record<string, unknown>;
      const children = root.children as Record<string, unknown>[];
      const p1 = children.find((c) => c.item_id === "p1")!;
      // All children are checked and filtered. No depth_limited, no child_count.
      expect(p1.depth_limited).toBeUndefined();
      expect(p1.child_count).toBeUndefined();
      expect(p1.children).toBeUndefined();
    } finally {
      await allCheckedCtx.cleanup();
    }
  });

  test("leaf nodes omit child_count and children", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    const n1 = rootChildren.find((c) => c.item_id === "n1")!;
    const n1a = (n1.children as Record<string, unknown>[]).find((c) => c.item_id === "n1a")!;
    expect(n1a.child_count).toBeUndefined();
    expect(n1a.children).toBeUndefined();
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
      expect(m.item_id).toBeDefined();
      expect(m.content).toBeDefined();
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
      parent_levels: "immediate",
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.item_id === "n1a")!;
    expect(match.parents).toBeDefined();
    const parents = match.parents as Record<string, unknown>[];
    expect(parents[0].item_id).toBe("n1");
  });

  test("query is not echoed back in response", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "hello",
    });
    expect(result.query).toBeUndefined();
  });

  test("empty query matches all nodes", async () => {
    // Empty regex matches every string.
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "",
    });
    // doc1 has 7 nodes (root, n1, n1a, n1b, n2, n2a, n3).
    // The root node may or may not be included depending on implementation.
    expect(result.count).toBeGreaterThanOrEqual(6);
  });

  // ─── Section 5a: additional basic behavior tests ───────────────────

  test("regex matching is case-insensitive by default", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "FIRST ITEM",
    });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "n1")).toBe(true);
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
    expect(matches.some((m) => m.item_id === "n1b")).toBe(true);
  });

  test("match in note only: NOT found when search_notes false", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "note on child",
      search_notes: false,
    });
    const matches = result.matches as Record<string, unknown>[];
    // "note on child" only appears in the note of n1b, not in any content.
    expect(matches.some((m) => m.item_id === "n1b")).toBe(false);
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

  test("parent_levels none: no parents field", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: "none",
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.item_id === "n1a")!;
    expect(match.parents).toBeUndefined();
  });

  test("parent_levels immediate: one parent returned", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: "immediate",
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.item_id === "n1a")!;
    const parents = match.parents as Record<string, unknown>[];
    expect(parents).toHaveLength(1);
    expect(parents[0].item_id).toBe("n1");
  });

  test("parent_levels all: full ancestor chain returned", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: "all",
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.item_id === "n1a")!;
    const parents = match.parents as Record<string, unknown>[];
    // n1a -> n1 -> root, so 2 parents.
    expect(parents).toHaveLength(2);
    // Nearest parent first.
    expect(parents[0].item_id).toBe("n1");
    expect(parents[1].item_id).toBe("root");
  });

  test("parent array ordered with nearest parent first", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
      parent_levels: "all",
    });
    const matches = result.matches as Record<string, unknown>[];
    const match = matches.find((m) => m.item_id === "n1a")!;
    const parents = match.parents as Record<string, unknown>[];
    expect(parents[0].item_id).toBe("n1");
  });

  test("match on root node: no parents regardless of parent_levels", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Test Document",
      parent_levels: "all",
    });
    const matches = result.matches as Record<string, unknown>[];
    const rootMatch = matches.find((m) => m.item_id === "root");
    expect(rootMatch).toBeDefined();
    // Root has no parent, so parents should be undefined (no parents found).
    expect(rootMatch!.parents).toBeUndefined();
  });

  // ─── Section 5c: size warnings ─────────────────────────────────────

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

  test("response includes file_id, title, count, matches but not query", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(typeof result.count).toBe("number");
    expect(result.query).toBeUndefined();
    expect(Array.isArray(result.matches)).toBe(true);
  });

  test("response includes sync_token as a string", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First",
    });
    expect(typeof result.sync_token).toBe("string");
  });

  test("plain node omits checked, show_checkbox, heading, color from match", async () => {
    // n1a is a plain node with no checkbox, heading, or color.
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A",
    });
    const matches = result.matches as Record<string, unknown>[];
    const n1a = matches.find((m) => m.item_id === "n1a")!;
    expect(n1a).toBeDefined();
    // These should be omitted for plain nodes, consistent with read_document.
    expect(n1a.checked).toBeUndefined();
    expect(n1a.show_checkbox).toBeUndefined();
    expect(n1a.heading).toBeUndefined();
    expect(n1a.color).toBeUndefined();
  });

  test("each match includes item_id, content", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(typeof match.item_id).toBe("string");
      expect(typeof match.content).toBe("string");
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
    const n1b = matches.find((m) => m.item_id === "n1b");
    const n1a = matches.find((m) => m.item_id === "n1a");
    if (n1b) {
      expect(n1b.note).toBe("A note on child B");
    }
    if (n1a) {
      expect(n1a.note).toBeUndefined();
    }
  });

  // ─── Section 5f: regex behavior ─────────────────────────────────────

  test("regex anchor matches only nodes starting with pattern", async () => {
    // "^Child" should match "Child A" and "Child B" but not "Nested child".
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "^Child",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "n1a")).toBe(true);
    expect(matches.some((m) => m.item_id === "n1b")).toBe(true);
    expect(matches.every((m) => (m.content as string).match(/^Child/i))).toBe(true);
  });

  test("regex alternation matches nodes with either pattern", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "Child A|Child B",
    });
    const nodeIds = (result.matches as Record<string, unknown>[]).map((m) => m.item_id);
    expect(nodeIds).toContain("n1a");
    expect(nodeIds).toContain("n1b");
  });

  test("case_sensitive true: uppercase pattern does not match mixed-case content", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "CHILD A",
      case_sensitive: true,
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "n1a")).toBe(false);
  });

  test("case_sensitive false (default): uppercase pattern matches mixed-case content", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "CHILD A",
      case_sensitive: false,
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "n1a")).toBe(true);
  });

  test("invalid regex returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "[invalid",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toMatch(/Invalid regex pattern/);
  });
});

// ─── get_recent_changes ──────────────────────────────────────────────

describe("get_recent_changes", () => {
  test("finds nodes within time range (default type: both)", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
    });
    expect(result.file_id).toBe("doc1");
    // Default type is "both", so freshly created nodes are included.
    expect(result.count).toBeGreaterThan(0);
  });

  test("type: modified excludes freshly created nodes", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
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
      since: new Date(Date.now() + 100000).toISOString(),
    });
    expect(result.count).toBe(0);
    expect(result.matches).toEqual([]);
  });

  test("invalid file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "get_recent_changes", {
      file_id: "nonexistent",
      since: "1970-01-01",
    });
    expect(err.error).toBe("NotFound");
  });

  test("invalid until date returns error instead of silently returning no results", async () => {
    const err = await callToolError(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
      until: "not-a-date",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("until");
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
      since: new Date(Date.now() - 1000).toISOString(),
      type: "created",
    });
    const matches = result.matches as Record<string, unknown>[];
    // n1 was created in the past, so it should not appear for type: created
    // in the recent time range.
    expect(matches.some((m) => m.item_id === "n1")).toBe(false);
  });

  test("type: both returns both created and modified", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
      type: "both",
    });
    // All nodes were created recently, so they should all appear.
    expect(result.count).toBeGreaterThan(0);
  });

  test("each match includes change_type field", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(["created", "modified"]).toContain(match.change_type as string);
    }
  });

  // ─── Section 6b: date parsing ──────────────────────────────────────

  test("since as full ISO datetime: exact match", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: new Date(Date.now() + 100000).toISOString(),
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
      since: new Date(Date.now() + 100000).toISOString(),
      until: new Date(Date.now() - 100000).toISOString(),
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
      since: "1970-01-01",
      sort: "newest_first",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (let i = 1; i < matches.length; i++) {
      const prevTime = matches[i - 1].created as string;
      const currTime = matches[i].created as string;
      expect(prevTime >= currTime).toBe(true);
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
      since: "1970-01-01",
      sort: "oldest_first",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (let i = 1; i < matches.length; i++) {
      const prevTime = matches[i - 1].created as string;
      const currTime = matches[i].created as string;
      expect(prevTime <= currTime).toBe(true);
    }
  });

  // ─── Section 6d: parent context ───────────────────────────────────

  test("parent_levels none: no parent context", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
      parent_levels: "none",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(match.parents).toBeUndefined();
    }
  });

  test("parent_levels immediate (default): one parent", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
      parent_levels: "immediate",
    });
    const matches = result.matches as Record<string, unknown>[];
    // n1a should have parent n1.
    const n1a = matches.find((m) => m.item_id === "n1a");
    if (n1a && n1a.parents) {
      const parents = n1a.parents as Record<string, unknown>[];
      expect(parents).toHaveLength(1);
      expect(parents[0].item_id).toBe("n1");
    }
  });

  test("parent_levels all: full ancestor chain", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
      parent_levels: "all",
    });
    const matches = result.matches as Record<string, unknown>[];
    const n1a = matches.find((m) => m.item_id === "n1a");
    if (n1a && n1a.parents) {
      const parents = n1a.parents as Record<string, unknown>[];
      expect(parents).toHaveLength(2);
      expect(parents[0].item_id).toBe("n1");
      expect(parents[1].item_id).toBe("root");
    }
  });

  // ─── Section 6e: size warnings ────────────────────────────────────

  test("bypass_warning true on small result: rejected as preemptive", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
      bypass_warning: true,
    });
    expect(result.warning).toBeDefined();
    const warning = result.warning as string;
    expect(warning).toContain("preemptively");
  });

  // ─── Section 6f: response shape ───────────────────────────────────

  test("response includes file_id, title, count, matches", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.matches)).toBe(true);
  });

  test("response includes sync_token as a string", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
    });
    expect(typeof result.sync_token).toBe("string");
  });

  test("each match includes item_id, content, created, modified, change_type, url", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
    });
    const matches = result.matches as Record<string, unknown>[];
    for (const match of matches) {
      expect(typeof match.item_id).toBe("string");
      expect(typeof match.content).toBe("string");
      expect(typeof match.created).toBe("string");
      expect(typeof match.modified).toBe("string");
      expect(match.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(match.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof match.change_type).toBe("string");
    }
  });

  test("plain node omits checked, show_checkbox, heading, color from match", async () => {
    // n1a is a plain node with no checkbox, heading, or color.
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
    });
    const matches = result.matches as Record<string, unknown>[];
    const n1a = matches.find((m) => m.item_id === "n1a")!;
    expect(n1a).toBeDefined();
    // These should be omitted for plain nodes, consistent with read_document.
    expect(n1a.checked).toBeUndefined();
    expect(n1a.show_checkbox).toBeUndefined();
    expect(n1a.heading).toBeUndefined();
    expect(n1a.color).toBeUndefined();
  });

  test("note included only when non-empty", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: "1970-01-01",
    });
    const matches = result.matches as Record<string, unknown>[];
    // n1b has a note. Other nodes do not.
    const n1b = matches.find((m) => m.item_id === "n1b");
    if (n1b) {
      expect(n1b.note).toBe("A note on child B");
    }
    const n1a = matches.find((m) => m.item_id === "n1a");
    if (n1a) {
      expect(n1a.note).toBeUndefined();
    }
  });
});

// ─── check_document_versions ─────────────────────────────────────────

describe("check_document_versions", () => {
  test("returns sync_tokens for valid documents", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1", "doc2"],
    });
    const syncTokens = result.sync_tokens as Record<string, string>;
    expect(typeof syncTokens.doc1).toBe("string");
    expect((syncTokens.doc1 as string).length).toBe(5);
    expect(typeof syncTokens.doc2).toBe("string");
    expect((syncTokens.doc2 as string).length).toBe(5);
  });

  test("non-existent document gets empty string sync_token", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["nonexistent"],
    });
    const syncTokens = result.sync_tokens as Record<string, string>;
    expect(syncTokens.nonexistent).toBe("");
  });

  test("sync_token changes after edits", async () => {
    const before = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1"],
    });
    const t1 = (before.sync_tokens as Record<string, string>).doc1;

    // Edit the document.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: syncToken,
    });

    const after = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1"],
    });
    const t2 = (after.sync_tokens as Record<string, string>).doc1;
    expect(t2).not.toBe(t1);
  });

  test("empty file_ids returns empty sync_tokens", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: [],
    });
    expect(result.sync_tokens).toEqual({});
  });

  // ─── Section 9a: additional tests ─────────────────────────────────

  test("multiple documents in single call: all sync_tokens returned", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1", "doc2", "inbox_doc"],
    });
    const syncTokens = result.sync_tokens as Record<string, string>;
    expect(typeof syncTokens.doc1).toBe("string");
    expect(typeof syncTokens.doc2).toBe("string");
    expect(typeof syncTokens.inbox_doc).toBe("string");
  });

  test("response shape: sync_tokens is a record of string to string", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1"],
    });
    expect(result.sync_tokens).toBeDefined();
    const syncTokens = result.sync_tokens as Record<string, string>;
    for (const [key, value] of Object.entries(syncTokens)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Config-dependent tests
//
// These tests use custom config files to verify that readDefaults and
// sizeWarning settings from config are applied correctly.
// ═════════════════════════════════════════════════════════════════════════


// ─── 4b. max_depth config defaults ────────────────────────────────────

describe("read_document config defaults: max_depth", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  test("default max_depth (omitted) uses config default of 3", async () => {
    // Build a document with nodes at depth 0 through 6.
    function deepSetup(server: DummyDynalistServer): void {
      const nodes = [server.makeNode("root", "Deep Doc", ["d1"])];
      let parentId = "d1";
      for (let i = 1; i <= 6; i++) {
        const childId = `d${i + 1}`;
        const children = i < 6 ? [childId] : [];
        nodes.push(server.makeNode(parentId, `Level ${i}`, children));
        parentId = childId;
      }
      // The leaf at depth 7.
      nodes.push(server.makeNode(parentId, "Level 7", []));
      server.addDocument("deep_doc", "Deep Doc", "root_folder", nodes);
    }

    // No custom config means default readDefaults.maxDepth = 3.
    cfgCtx = await createTestContext(deepSetup);

    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "deep_doc",
    });

    // Walk down the tree to depth 3. Node at depth 3 with children
    // should be depth_limited.
    let node = result.item as Record<string, unknown>;
    for (let i = 0; i < 3; i++) {
      const children = node.children as Record<string, unknown>[];
      expect(children.length).toBeGreaterThan(0);
      node = children[0];
    }
    // At depth 3, the node should have its children hidden.
    expect(node.children).toBeUndefined();
    expect(node.depth_limited).toBe(true);
  });

  test("custom readDefaults.maxDepth in config overrides hardcoded default", async () => {
    function treeSetup(server: DummyDynalistServer): void {
      server.addDocument("cfg_doc", "Config Doc", "root_folder", [
        server.makeNode("root", "Config Doc", ["a1"]),
        server.makeNode("a1", "Level 1", ["a2"]),
        server.makeNode("a2", "Level 2", ["a3"]),
        server.makeNode("a3", "Level 3", []),
      ]);
    }

    cfgCtx = await createTestContext(treeSetup, { readDefaults: { maxDepth: 2, includeCollapsedChildren: false, includeNotes: true, includeChecked: true } });

    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "cfg_doc",
    });

    // With maxDepth: 2, node at depth 2 (a2) should be depth_limited.
    const rootNode = result.item as Record<string, unknown>;
    const a1 = (rootNode.children as Record<string, unknown>[])[0];
    const a2 = (a1.children as Record<string, unknown>[])[0];
    expect(a2.children).toBeUndefined();
    expect(a2.depth_limited).toBe(true);
  });

  test("explicit max_depth parameter overrides config default", async () => {
    function treeSetup(server: DummyDynalistServer): void {
      server.addDocument("cfg_doc2", "Config Doc 2", "root_folder", [
        server.makeNode("root", "Config Doc 2", ["b1"]),
        server.makeNode("b1", "Level 1", ["b2"]),
        server.makeNode("b2", "Level 2", []),
      ]);
    }

    cfgCtx = await createTestContext(treeSetup, { readDefaults: { maxDepth: 1, includeCollapsedChildren: false, includeNotes: true, includeChecked: true } });

    // Explicit max_depth: 10 should override the config's maxDepth: 1.
    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "cfg_doc2",
      max_depth: 10,
    });
    const rootNode = result.item as Record<string, unknown>;
    const b1 = (rootNode.children as Record<string, unknown>[])[0];
    // b2 should be visible at depth 2 since explicit max_depth is 10.
    expect((b1.children as Record<string, unknown>[]).length).toBe(1);
    const b2 = (b1.children as Record<string, unknown>[])[0];
    expect(b2.item_id).toBe("b2");
  });
});

// ─── 4e. include_notes config default ─────────────────────────────────

describe("read_document config defaults: include_notes", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  test("config default readDefaults.includeNotes: false omits notes when parameter not specified", async () => {
    cfgCtx = await createTestContext(standardSetup, { readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: false, includeChecked: true } });

    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });

    // Walk the tree to confirm no node has a note field.
    function checkNoNotes(node: Record<string, unknown>) {
      expect(node.note).toBeUndefined();
      for (const child of (node.children ?? []) as Record<string, unknown>[]) {
        checkNoNotes(child);
      }
    }
    checkNoNotes(result.item as Record<string, unknown>);
  });
});

// ─── 4f. include_checked edge cases ───────────────────────────────────

describe("read_document config defaults: include_checked", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  test("include_checked false: child_count matches rendered children count", async () => {
    cfgCtx = await createTestContext(standardSetup);

    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
      include_checked: false,
    });
    const root = result.item as Record<string, unknown>;
    // Root has 3 children in source (n1, n2, n3), but n3 is checked
    // and excluded. child_count matches the rendered array length.
    expect(root.child_count).toBe(2);
    expect((root.children as Record<string, unknown>[]).length).toBe(2);
  });

  test("config default readDefaults.includeChecked: false omits checked nodes when parameter not specified", async () => {
    cfgCtx = await createTestContext(standardSetup, { readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: true, includeChecked: false } });

    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const rootChildren = (result.item as Record<string, unknown>).children as Record<string, unknown>[];
    // n3 is checked and should be excluded via config default.
    const n3 = rootChildren.find((c) => c.item_id === "n3");
    expect(n3).toBeUndefined();
  });
});

// ─── 4g. Size warning content ─────────────────────────────────────────

describe("read_document size warning content", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  test("warning includes suggestions for max_depth and item_id", async () => {

    function bigSetup(server: DummyDynalistServer): void {
      const childIds: string[] = [];
      const nodes = [server.makeNode("root", "Big Doc", [] as string[])];
      for (let i = 0; i < 20; i++) {
        const id = `w_${i}`;
        childIds.push(id);
        nodes.push(server.makeNode(id, "x".repeat(50), []));
      }
      nodes[0].children = childIds;
      server.addDocument("warn_doc", "Big Doc", "root_folder", nodes);
    }

    cfgCtx = await createTestContext(bigSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "warn_doc",
      max_depth: 10,
    });
    expect(result.warning).toBeDefined();
    const warning = result.warning as string;
    expect(warning).toContain("max_depth");
    expect(warning).toContain("item_id");
  });

  test("size warning response includes file_id, title, and sync_token", async () => {
    function bigSetup(server: DummyDynalistServer): void {
      const childIds: string[] = [];
      const nodes = [server.makeNode("root", "Big Doc", [] as string[])];
      for (let i = 0; i < 20; i++) {
        const id = `w2_${i}`;
        childIds.push(id);
        nodes.push(server.makeNode(id, "x".repeat(50), []));
      }
      nodes[0].children = childIds;
      server.addDocument("warn_doc2", "Big Doc", "root_folder", nodes);
    }

    cfgCtx = await createTestContext(bigSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "read_document", {
      file_id: "warn_doc2",
      max_depth: 10,
    });
    expect(result.warning).toBeDefined();
    expect(result.file_id).toBe("warn_doc2");
    expect(result.title).toBe("Big Doc");
    expect(typeof result.sync_token).toBe("string");
  });
});

// ─── 5d. search_in_document size warnings ─────────────────────────────

describe("search_in_document size warnings", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  // Setup function that creates many searchable nodes.
  function manyNodesSetup(server: DummyDynalistServer): void {
    const childIds: string[] = [];
    const nodes = [server.makeNode("root", "Search Doc", [] as string[])];
    for (let i = 0; i < 50; i++) {
      const id = `s_${i}`;
      childIds.push(id);
      nodes.push(server.makeNode(id, `searchable item ${i} ${"y".repeat(50)}`, []));
    }
    nodes[0].children = childIds;
    server.addDocument("search_warn_doc", "Search Doc", "root_folder", nodes);
  }

  test("large result set triggers size warning", async () => {
    cfgCtx = await createTestContext(manyNodesSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "search_in_document", {
      file_id: "search_warn_doc",
      query: "searchable",
    });
    expect(result.warning).toBeDefined();
  });

  test("warning suggests narrowing query and parent_levels none", async () => {
    cfgCtx = await createTestContext(manyNodesSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "search_in_document", {
      file_id: "search_warn_doc",
      query: "searchable",
    });
    const warning = result.warning as string;
    expect(warning).toContain("query");
    expect(warning).toContain("parent_levels: \"none\"");
  });

  test("bypass_warning true on large result under max threshold succeeds", async () => {
    // Set warning low but max high so result is between thresholds.
    cfgCtx = await createTestContext(manyNodesSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 100000 } });

    // First call should trigger warning.
    const first = await callToolOk(cfgCtx.mcpClient, "search_in_document", {
      file_id: "search_warn_doc",
      query: "searchable",
    });
    expect(first.warning).toBeDefined();

    // Second call with bypass_warning should succeed.
    const second = await callToolOk(cfgCtx.mcpClient, "search_in_document", {
      file_id: "search_warn_doc",
      query: "searchable",
      bypass_warning: true,
    });
    expect(second.warning).toBeUndefined();
    expect(second.matches).toBeDefined();
    expect(second.count).toBeGreaterThan(0);
  });

  test("size warning response includes file_id, title, and sync_token", async () => {
    cfgCtx = await createTestContext(manyNodesSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "search_in_document", {
      file_id: "search_warn_doc",
      query: "searchable",
    });
    expect(result.warning).toBeDefined();
    expect(result.file_id).toBe("search_warn_doc");
    expect(result.title).toBe("Search Doc");
    expect(typeof result.sync_token).toBe("string");
  });
});

// ─── 6b. get_recent_changes date parsing ──────────────────────────────

describe("get_recent_changes date parsing", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  function timedSetup(server: DummyDynalistServer): void {
    // Create a node with a known timestamp: 2025-03-11T12:00:00.000Z.
    const ts = new Date("2025-03-11T12:00:00.000Z").getTime();
    server.addDocument("timed_doc", "Timed Doc", "root_folder", [
      server.makeNode("root", "Timed Doc", ["t1"]),
      server.makeNode("t1", "Timed node", [], { created: ts, modified: ts }),
    ]);
  }

  test("since as ISO date string treated as start of day", async () => {
    cfgCtx = await createTestContext(timedSetup);

    // "2025-03-11" should be treated as start of day (midnight UTC).
    // The node at 12:00 UTC on that day should be included.
    const result = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11",
      until: "2025-03-11",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(true);
  });

  test("until as ISO date string treated as end of day", async () => {
    cfgCtx = await createTestContext(timedSetup);

    // "2025-03-11" for until should cover end of that day (23:59:59.999).
    // The node at 12:00 UTC should be included.
    const result = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "1970-01-01",
      until: "2025-03-11",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(true);

    // But "2025-03-10" as until should NOT include the node.
    const result2 = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "1970-01-01",
      until: "2025-03-10",
    });
    const matches2 = result2.matches as Record<string, unknown>[];
    expect(matches2.some((m) => m.item_id === "t1")).toBe(false);
  });

  test("until as full ISO datetime: exact match", async () => {
    cfgCtx = await createTestContext(timedSetup);

    // Using the exact ISO datetime as until should include the node.
    const result = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "1970-01-01",
      until: "2025-03-11T12:00:00.000Z",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(true);

    // One second before should exclude it.
    const result2 = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "1970-01-01",
      until: "2025-03-11T11:59:59.000Z",
    });
    const matches2 = result2.matches as Record<string, unknown>[];
    expect(matches2.some((m) => m.item_id === "t1")).toBe(false);
  });
});

// ─── 6c. Sorting edge case ────────────────────────────────────────────

describe("get_recent_changes sorting by change_type", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  test("sort key depends on change_type: created uses created ts, modified uses modified ts", async () => {
    const now = Date.now();
    const sinceTs = now - 5000;

    function sortSetup(server: DummyDynalistServer): void {
      // Node A: created within the since range (change_type = created).
      //         Sort key is its created timestamp.
      // Node B: created BEFORE the since range, modified within range
      //         (change_type = modified). Sort key is its modified timestamp.
      server.addDocument("sort_doc", "Sort Doc", "root_folder", [
        server.makeNode("root", "Sort Doc", ["sa", "sb"], {
          created: now - 100000,
          modified: now - 100000,
        }),
        server.makeNode("sa", "Node A", [], {
          created: sinceTs + 1000,
          modified: sinceTs + 1000,
        }),
        server.makeNode("sb", "Node B", [], {
          created: sinceTs - 100000,
          modified: sinceTs + 3000,
        }),
      ]);
    }

    cfgCtx = await createTestContext(sortSetup);

    // Node A: change_type=created, sort key = sinceTs+1000.
    // Node B: change_type=modified, sort key = sinceTs+3000.
    // With newest_first, B should come before A.
    const result = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "sort_doc",
      since: new Date(sinceTs).toISOString(),
      sort: "newest_first",
      type: "both",
    });
    const matches = result.matches as Record<string, unknown>[];
    const filtered = matches.filter(
      (m) => m.item_id === "sa" || m.item_id === "sb"
    );
    expect(filtered.length).toBe(2);

    const sbIdx = filtered.findIndex((m) => m.item_id === "sb");
    const saIdx = filtered.findIndex((m) => m.item_id === "sa");
    // sb (modified more recently) should come before sa (created earlier).
    expect(sbIdx).toBeLessThan(saIdx);

    // Verify the change_types are as expected.
    const sb = filtered.find((m) => m.item_id === "sb")!;
    const sa = filtered.find((m) => m.item_id === "sa")!;
    expect(sb.change_type).toBe("modified");
    expect(sa.change_type).toBe("created");
  });
});

// ─── 6e. get_recent_changes size warnings ─────────────────────────────

describe("get_recent_changes size warnings", () => {
  let cfgCtx: TestContext;

  afterEach(async () => {
    await cfgCtx.cleanup();
  });

  function manyChangesSetup(server: DummyDynalistServer): void {
    const childIds: string[] = [];
    const nodes = [server.makeNode("root", "Changes Doc", [] as string[])];
    for (let i = 0; i < 50; i++) {
      const id = `c_${i}`;
      childIds.push(id);
      nodes.push(server.makeNode(id, `changed item ${i} ${"z".repeat(50)}`, []));
    }
    nodes[0].children = childIds;
    server.addDocument("changes_doc", "Changes Doc", "root_folder", nodes);
  }

  test("large result triggers size warning", async () => {
    cfgCtx = await createTestContext(manyChangesSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "changes_doc",
      since: "1970-01-01",
    });
    expect(result.warning).toBeDefined();
  });

  test("warning suggests narrowing time period, filtering by type, parent_levels none", async () => {
    cfgCtx = await createTestContext(manyChangesSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "changes_doc",
      since: "1970-01-01",
    });
    const warning = result.warning as string;
    expect(warning).toContain("time period");
    expect(warning).toContain("parent_levels: \"none\"");
    expect(warning).toContain("type");
  });

  test("size warning response includes file_id, title, and sync_token", async () => {
    cfgCtx = await createTestContext(manyChangesSetup, { sizeWarning: { warningTokenThreshold: 50, maxTokenThreshold: 24500 } });

    const result = await callToolOk(cfgCtx.mcpClient, "get_recent_changes", {
      file_id: "changes_doc",
      since: "1970-01-01",
    });
    expect(result.warning).toBeDefined();
    expect(result.file_id).toBe("changes_doc");
    expect(result.title).toBe("Changes Doc");
    expect(typeof result.sync_token).toBe("string");
  });
});

// ─── 7b. list_documents edge case ─────────────────────────────────────

describe("list_documents empty account", () => {
  let emptyCtx: TestContext;

  afterEach(async () => {
    await emptyCtx.cleanup();
  });

  test("empty account (no documents): returns empty arrays, count 0", async () => {
    // Create a context with no setup function. The DummyDynalistServer
    // init() only creates a root folder, no documents.
    emptyCtx = await createTestContext();

    const result = await callToolOk(emptyCtx.mcpClient, "list_documents");
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });
});

// ─── 8a. search_documents edge case ───────────────────────────────────

describe("search_documents query echo", () => {
  test("query is not echoed back in response", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "My Unique Search Query 123",
    });
    expect(result.query).toBeUndefined();
  });
});

// ─── get_recent_changes date parsing ──────────────────────────────────

describe("get_recent_changes date parsing", () => {
  let dateCtx: TestContext;

  afterEach(async () => {
    await dateCtx.cleanup();
  });

  // All tests use a node created at a known timestamp.
  const knownTs = new Date("2025-03-11T12:00:00.000Z").getTime();

  function timedSetup(server: DummyDynalistServer): void {
    server.addDocument("timed_doc", "Timed Doc", "root_folder", [
      server.makeNode("root", "Timed Doc", ["t1"]),
      server.makeNode("t1", "Timed node", [], { created: knownTs, modified: knownTs }),
    ]);
  }

  test("date-only string for since is treated as start-of-day UTC", async () => {
    dateCtx = await createTestContext(timedSetup);

    // The node was created at 2025-03-11T12:00:00Z. Using "2025-03-11"
    // as since should be midnight, so the node falls within range.
    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(true);
  });

  test("date-only string for since excludes nodes from the previous day", async () => {
    dateCtx = await createTestContext(timedSetup);

    // Using "2025-03-12" as since should exclude a node from 2025-03-11T12:00.
    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-12",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(false);
  });

  test("date-only string for until is treated as end-of-day UTC", async () => {
    dateCtx = await createTestContext(timedSetup);

    // "2025-03-11" for until should cover up to 23:59:59.999 UTC.
    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "1970-01-01",
      until: "2025-03-11",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(true);
  });

  test("date-only string for until on previous day excludes the node", async () => {
    dateCtx = await createTestContext(timedSetup);

    // "2025-03-10" as until ends before the node's timestamp.
    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "1970-01-01",
      until: "2025-03-10",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(false);
  });

  test("full ISO timestamp is parsed correctly", async () => {
    dateCtx = await createTestContext(timedSetup);

    // Using the exact ISO timestamp should include the node.
    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11T12:00:00.000Z",
      until: "2025-03-11T12:00:00.000Z",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(true);
  });

  test("full ISO timestamp one second later excludes the node from since", async () => {
    dateCtx = await createTestContext(timedSetup);

    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11T12:00:01.000Z",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(false);
  });

  test("full ISO datetime works for since and until", async () => {
    dateCtx = await createTestContext(timedSetup);

    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11T12:00:00.000Z",
      until: "2025-03-11T12:00:00.000Z",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(true);
  });

  test("ISO datetime one second after the node excludes it from since", async () => {
    dateCtx = await createTestContext(timedSetup);

    const result = await callToolOk(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "2025-03-11T12:00:01.000Z",
      until: "2025-03-11T12:01:00.000Z",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(matches.some((m) => m.item_id === "t1")).toBe(false);
  });

  test("invalid date format for since returns error", async () => {
    dateCtx = await createTestContext(timedSetup);

    const err = await callToolError(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "not-a-date",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("since");
  });

  test("invalid date format for until returns error", async () => {
    dateCtx = await createTestContext(timedSetup);

    const err = await callToolError(dateCtx.mcpClient, "get_recent_changes", {
      file_id: "timed_doc",
      since: "1970-01-01",
      until: "garbage-date",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("until");
  });
});

// ─── read_document field omission ─────────────────────────────────────

describe("read_document field omission", () => {
  let omitCtx: TestContext;

  afterEach(async () => {
    await omitCtx.cleanup();
  });

  test("note field omitted when empty string", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("omit_doc", "Omit Test", "root_folder", [
        server.makeNode("root", "Omit Test", ["n1"]),
        server.makeNode("n1", "No note", [], { note: "" }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "omit_doc",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.note).toBeUndefined();
  });

  test("note field present when non-empty", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("note_doc", "Note Test", "root_folder", [
        server.makeNode("root", "Note Test", ["n1"]),
        server.makeNode("n1", "Has note", [], { note: "Important note" }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "note_doc",
      max_depth: 10,
      include_notes: true,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.note).toBe("Important note");
  });

  test("heading field omitted when 0", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("heading_doc", "Heading Test", "root_folder", [
        server.makeNode("root", "Heading Test", ["n1"]),
        server.makeNode("n1", "No heading", [], { heading: 0 }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "heading_doc",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.heading).toBeUndefined();
  });

  test("heading field present when non-zero", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("heading_doc2", "Heading Test 2", "root_folder", [
        server.makeNode("root", "Heading Test 2", ["n1"]),
        server.makeNode("n1", "H1 heading", [], { heading: 1 }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "heading_doc2",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.heading).toBe("h1");
  });

  test("color field omitted when 0", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("color_doc", "Color Test", "root_folder", [
        server.makeNode("root", "Color Test", ["n1"]),
        server.makeNode("n1", "No color", [], { color: 0 }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "color_doc",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.color).toBeUndefined();
  });

  test("color field present when non-zero", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("color_doc2", "Color Test 2", "root_folder", [
        server.makeNode("root", "Color Test 2", ["n1"]),
        server.makeNode("n1", "Red node", [], { color: 1 }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "color_doc2",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.color).toBe("red");
  });

  test("show_checkbox field omitted when not set on node", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("cb_doc", "Checkbox Test", "root_folder", [
        server.makeNode("root", "Checkbox Test", ["n1"]),
        // No checkbox or checked fields at all.
        server.makeNode("n1", "Plain node", []),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "cb_doc",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.show_checkbox).toBeUndefined();
    expect(n1.checked).toBeUndefined();
  });

  test("show_checkbox and checked fields present when set", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("cb_doc2", "Checkbox Test 2", "root_folder", [
        server.makeNode("root", "Checkbox Test 2", ["n1"]),
        server.makeNode("n1", "Checked node", [], { checkbox: true, checked: true }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "cb_doc2",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.show_checkbox).toBe(true);
    expect(n1.checked).toBe(true);
  });

  test("all optional fields present simultaneously", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("all_fields_doc", "All Fields", "root_folder", [
        server.makeNode("root", "All Fields", ["n1"]),
        server.makeNode("n1", "Full node", [], {
          note: "A note",
          heading: 2,
          color: 3,
          checkbox: true,
          checked: false,
        }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "all_fields_doc",
      max_depth: 10,
      include_notes: true,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.note).toBe("A note");
    expect(n1.heading).toBe("h2");
    expect(n1.color).toBe("yellow");
    expect(n1.show_checkbox).toBe(true);
    expect(n1.checked).toBe(false);
  });

  test("all optional fields omitted simultaneously", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("no_fields_doc", "No Fields", "root_folder", [
        server.makeNode("root", "No Fields", ["n1"]),
        // makeNode sets note: "", no heading/color/checkbox/checked.
        server.makeNode("n1", "Bare node", []),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "no_fields_doc",
      max_depth: 10,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.note).toBeUndefined();
    expect(n1.heading).toBeUndefined();
    expect(n1.color).toBeUndefined();
    expect(n1.show_checkbox).toBeUndefined();
    expect(n1.checked).toBeUndefined();
  });

  test("note field omitted when include_notes is false, even if non-empty", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("note_off_doc", "Note Off", "root_folder", [
        server.makeNode("root", "Note Off", ["n1"]),
        server.makeNode("n1", "Has note but hidden", [], { note: "Should not appear" }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "note_off_doc",
      max_depth: 10,
      include_notes: false,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    expect(n1.note).toBeUndefined();
  });

  test("whitespace-only note is treated as empty and omitted", async () => {
    omitCtx = await createTestContext((server) => {
      server.addDocument("ws_doc", "Whitespace Note", "root_folder", [
        server.makeNode("root", "Whitespace Note", ["n1"]),
        server.makeNode("n1", "Whitespace note", [], { note: "   \n  " }),
      ]);
    });

    const result = await callToolOk(omitCtx.mcpClient, "read_document", {
      file_id: "ws_doc",
      max_depth: 10,
      include_notes: true,
    });
    const node = result.item as Record<string, unknown>;
    const children = node.children as Record<string, unknown>[];
    const n1 = children.find((c) => c.item_id === "n1")!;
    // Whitespace-only notes should be omitted (buildNodeTree checks node.note.trim()).
    expect(n1.note).toBeUndefined();
  });
});
