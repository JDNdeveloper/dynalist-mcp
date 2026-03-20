import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  standardSetup,
  type TestContext,
} from "./test-helpers";

/**
 * Find a file entry by file_id in a recursive list_documents tree.
 */
function findInFileTree(files: Record<string, unknown>[], fileId: string): Record<string, unknown> | undefined {
  for (const f of files) {
    if (f.file_id === fileId) return f;
    if (Array.isArray(f.children)) {
      const found = findInFileTree(f.children as Record<string, unknown>[], fileId);
      if (found) return found;
    }
  }
  return undefined;
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ─── create_document ─────────────────────────────────────────────────

describe("create_document", () => {
  test("creates document in folder", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      title: "New Doc",
      reference_file_id: "folder_a",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("New Doc");
  });

  test("created document appears in list_documents", async () => {
    const createResult = await callToolOk(ctx.mcpClient, "create_document", {
      title: "Created Doc",
      reference_file_id: "folder_a",
    });

    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], createResult.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Created Doc");
  });

  test("position: first_child creates at top of folder", async () => {
    await callToolOk(ctx.mcpClient, "create_document", {
      title: "Top Doc",
      reference_file_id: "folder_a",
      position: "first_child",
    });
    const folder = ctx.server.files.get("folder_a")!;
    const firstChild = ctx.server.files.get(folder.children![0])!;
    expect(firstChild.title).toBe("Top Doc");
  });

  test("position: last_child appends to end of folder (default)", async () => {
    // folder_a already has doc1 as a child.
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      title: "End Doc",
      reference_file_id: "folder_a",
    });
    const folder = ctx.server.files.get("folder_a")!;
    const lastChildId = folder.children![folder.children!.length - 1];
    expect(lastChildId).toBe(result.file_id as string);
  });

  test("position: after places document after reference sibling", async () => {
    // folder_a has [doc1]. Create another doc first, then place a third after doc1.
    const doc2 = await callToolOk(ctx.mcpClient, "create_document", {
      title: "Doc Two",
      reference_file_id: "folder_a",
    });
    await callToolOk(ctx.mcpClient, "create_document", {
      title: "After Doc1",
      reference_file_id: "doc1",
      position: "after",
    });
    const folder = ctx.server.files.get("folder_a")!;
    // Order should be: doc1, "After Doc1", doc2.
    expect(folder.children![0]).toBe("doc1");
    const afterDoc = ctx.server.files.get(folder.children![1])!;
    expect(afterDoc.title).toBe("After Doc1");
    expect(folder.children![2]).toBe(doc2.file_id as string);
  });

  test("position: before places document before reference sibling", async () => {
    await callToolOk(ctx.mcpClient, "create_document", {
      title: "Before Doc1",
      reference_file_id: "doc1",
      position: "before",
    });
    const folder = ctx.server.files.get("folder_a")!;
    const firstChild = ctx.server.files.get(folder.children![0])!;
    expect(firstChild.title).toBe("Before Doc1");
    expect(folder.children![1]).toBe("doc1");
  });

  test("creating in non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      title: "Orphan Doc",
      reference_file_id: "nonexistent",
    });
    expect(err.error).toBeDefined();
  });

  test("default title creates document with empty or default title", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      reference_file_id: "folder_a",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBeDefined();
  });

  test("omitting reference_file_id creates at top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      title: "Top Level Doc",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Top Level Doc");

    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], result.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Top Level Doc");
  });

  test("before without reference_file_id returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      title: "Bad",
      position: "before",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("reference_file_id pointing to document with first_child returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      title: "Bad",
      reference_file_id: "doc1",
      position: "first_child",
    });
    expect(err.error).toBe("InvalidInput");
  });
});

// ─── create_folder ───────────────────────────────────────────────────

describe("create_folder", () => {
  test("creates folder in parent", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      title: "New Folder",
      reference_file_id: "root_folder",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("New Folder");
  });

  test("created folder appears in list_documents", async () => {
    const createResult = await callToolOk(ctx.mcpClient, "create_folder", {
      title: "Visible Folder",
      reference_file_id: "root_folder",
    });

    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], createResult.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Visible Folder");
  });

  test("creating in non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      title: "Orphan Folder",
      reference_file_id: "nonexistent",
    });
    expect(err.error).toBeDefined();
  });

  test("omitting reference_file_id creates at top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      title: "Top Level Folder",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Top Level Folder");

    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], result.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Top Level Folder");
  });

  test("position: first_child creates folder at top", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      title: "First Folder",
      reference_file_id: "root_folder",
      position: "first_child",
    });
    const root = ctx.server.files.get("root_folder")!;
    expect(root.children![0]).toBe(result.file_id as string);
  });

  test("position: after places folder after reference sibling", async () => {
    await callToolOk(ctx.mcpClient, "create_folder", {
      title: "After Folder A",
      reference_file_id: "folder_a",
      position: "after",
    });
    const root = ctx.server.files.get("root_folder")!;
    const folderAIdx = root.children!.indexOf("folder_a");
    const nextChild = ctx.server.files.get(root.children![folderAIdx + 1])!;
    expect(nextChild.title).toBe("After Folder A");
  });

  test("position: before places folder before reference sibling", async () => {
    await callToolOk(ctx.mcpClient, "create_folder", {
      title: "Before Folder B",
      reference_file_id: "folder_b",
      position: "before",
    });
    const root = ctx.server.files.get("root_folder")!;
    const folderBIdx = root.children!.indexOf("folder_b");
    const prevChild = ctx.server.files.get(root.children![folderBIdx - 1])!;
    expect(prevChild.title).toBe("Before Folder B");
  });
});

// ─── create with document as parent ──────────────────────────────────

describe("create with document as reference_file_id (first_child/last_child)", () => {
  test("create_document returns error when reference_file_id is a document", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      title: "Should Fail",
      reference_file_id: "doc1",
      position: "first_child",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("create_folder returns error when reference_file_id is a document", async () => {
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      title: "Should Fail",
      reference_file_id: "doc1",
      position: "first_child",
    });
    expect(err.error).toBe("InvalidInput");
  });
});

// ─── rename_document ─────────────────────────────────────────────────

describe("rename_document", () => {
  test("renames a document", async () => {
    const result = await callToolOk(ctx.mcpClient, "rename_document", {
      file_id: "doc1",
      title: "Renamed Document",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.title).toBe("Renamed Document");
  });

  test("rename is reflected in list_documents", async () => {
    await callToolOk(ctx.mcpClient, "rename_document", {
      file_id: "doc1",
      title: "Fresh Title",
    });
    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const doc = findInFileTree(listResult.files as Record<string, unknown>[], "doc1")!;
    expect(doc.title).toBe("Fresh Title");
  });

  test("renaming non-existent document returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_document", {
      file_id: "nonexistent",
      title: "Nope",
    });
    expect(err.error).toBeDefined();
  });
});

// ─── rename_folder ───────────────────────────────────────────────────

describe("rename_folder", () => {
  test("renames a folder", async () => {
    const result = await callToolOk(ctx.mcpClient, "rename_folder", {
      file_id: "folder_a",
      title: "Renamed Folder",
    });
    expect(result.file_id).toBe("folder_a");
    expect(result.title).toBe("Renamed Folder");
  });

  test("rename is reflected in list_documents", async () => {
    await callToolOk(ctx.mcpClient, "rename_folder", {
      file_id: "folder_a",
      title: "New Folder Name",
    });
    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const folder = findInFileTree(listResult.files as Record<string, unknown>[], "folder_a")!;
    expect(folder.title).toBe("New Folder Name");
  });

  test("renaming non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_folder", {
      file_id: "nonexistent",
      title: "Nope",
    });
    expect(err.error).toBeDefined();
  });
});

// ─── move_document ───────────────────────────────────────────────────

describe("move_document", () => {
  test("moves document to another folder", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.parent_folder_id).toBe("folder_b");

    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children).toContain("doc1");

    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).not.toContain("doc1");
  });

  test("rejects folder file_id", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
    });
    expect(err.error).toBe("InvalidArgument");
  });

  test("moving to non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "nonexistent",
    });
    expect(err.error).toBeDefined();
  });

  test("moving non-existent document returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "nonexistent",
      reference_file_id: "folder_a",
    });
    expect(err.error).toBeDefined();
  });

  test("position: first_child places document at top of destination", async () => {
    ctx.server.addDocument("doc_extra", "Extra Doc", "folder_b", [
      ctx.server.makeNode("root", "Extra Doc", []),
    ]);
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "folder_b",
      position: "first_child",
    });
    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children![0]).toBe("doc1");
  });

  test("position: last_child appends document to end of destination", async () => {
    ctx.server.addDocument("doc_extra", "Extra Doc", "folder_b", [
      ctx.server.makeNode("root", "Extra Doc", []),
    ]);
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    const folderB = ctx.server.files.get("folder_b")!;
    const lastChildId = folderB.children![folderB.children!.length - 1];
    expect(lastChildId).toBe("doc1");
  });

  test("position: after places document after reference sibling", async () => {
    ctx.server.addDocument("doc_extra", "Extra Doc", "folder_b", [
      ctx.server.makeNode("root", "Extra Doc", []),
    ]);
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "doc2",
      position: "after",
    });
    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children![0]).toBe("doc2");
    expect(folderB.children![1]).toBe("doc1");
    expect(folderB.children![2]).toBe("doc_extra");
  });

  test("omitting reference_file_id moves to top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
    });
    expect(result.file_id).toBe("doc1");

    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).not.toContain("doc1");

    const root = ctx.server.files.get("root_folder")!;
    expect(root.children).toContain("doc1");
  });

  test("document disappears from source folder children after move", async () => {
    expect(ctx.server.files.get("folder_a")!.children).toContain("doc1");
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    expect(ctx.server.files.get("folder_a")!.children).not.toContain("doc1");
  });

  test("same-parent reorder with position: first_child", async () => {
    ctx.server.addDocument("doc_a2", "Doc A2", "folder_a", [
      ctx.server.makeNode("root", "Doc A2", []),
    ]);
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc_a2",
      reference_file_id: "folder_a",
      position: "first_child",
    });
    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children![0]).toBe("doc_a2");
    expect(folderA.children![1]).toBe("doc1");
  });

  test("same-parent reorder with position: before", async () => {
    ctx.server.addDocument("doc_a2", "Doc A2", "folder_a", [
      ctx.server.makeNode("root", "Doc A2", []),
    ]);
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc_a2",
      reference_file_id: "doc1",
      position: "before",
    });
    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children![0]).toBe("doc_a2");
    expect(folderA.children![1]).toBe("doc1");
  });
});

// ─── move_folder ────────────────────────────────────────────────────

describe("move_folder", () => {
  test("moves folder with children", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
    });
    expect(result.file_id).toBe("folder_a");

    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children).toContain("folder_a");

    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).toContain("doc1");
  });

  test("omitting reference_file_id moves to top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
    });
    expect(result.file_id).toBe("folder_a");

    const root = ctx.server.files.get("root_folder")!;
    expect(root.children).toContain("folder_a");

    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).toContain("doc1");
  });

  test("rejects document file_id", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    expect(err.error).toBe("InvalidArgument");
  });

  test("moving to non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "nonexistent",
    });
    expect(err.error).toBeDefined();
  });

  test("moving non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "nonexistent",
      reference_file_id: "folder_b",
    });
    expect(err.error).toBeDefined();
  });

  test("position: before places folder before reference sibling", async () => {
    await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_b",
      reference_file_id: "folder_a",
      position: "before",
    });
    const root = ctx.server.files.get("root_folder")!;
    const folderBIdx = root.children!.indexOf("folder_b");
    const folderAIdx = root.children!.indexOf("folder_a");
    expect(folderBIdx).toBeLessThan(folderAIdx);
    expect(folderAIdx).toBe(folderBIdx + 1);
  });

  test("position: after places folder after reference sibling", async () => {
    // root_folder has [folder_a, folder_b, ...]. Move folder_a after folder_b.
    await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
      position: "after",
    });
    const root = ctx.server.files.get("root_folder")!;
    const folderBIdx = root.children!.indexOf("folder_b");
    const folderAIdx = root.children!.indexOf("folder_a");
    expect(folderAIdx).toBe(folderBIdx + 1);
  });

  test("position: first_child places folder at top of destination", async () => {
    // Move folder_a into folder_b as first child.
    // First add a child to folder_b so we can verify first_child placement.
    ctx.server.addFolder("sub_folder", "Sub Folder", "folder_b");

    await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
      position: "first_child",
    });
    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children![0]).toBe("folder_a");
  });

  test("position: last_child places folder at end of destination", async () => {
    // folder_b has [doc2] from standardSetup. Move folder_a into folder_b as last child.
    await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
    });
    const folderB = ctx.server.files.get("folder_b")!;
    const lastChildId = folderB.children![folderB.children!.length - 1];
    expect(lastChildId).toBe("folder_a");
  });
});

// ─── cache invalidation after file operations ────────────────────────

describe("cache invalidation after file operations", () => {
  test("create_document invalidates path cache for new document", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "deny", rules: [{ path: "/Folder A/**", policy: "allow" }] },
    });
    const createResult = await callToolOk(ctx.mcpClient, "create_document", {
      title: "Cache Test Doc",
      reference_file_id: "folder_a",
    });
    const readResult = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: createResult.file_id as string,
    });
    expect(readResult.title).toBe("Cache Test Doc");
  });

  test("rename_document invalidates path cache for renamed document", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "allow", rules: [] },
    });
    await callToolOk(ctx.mcpClient, "rename_document", {
      file_id: "doc1",
      title: "Renamed Cache Doc",
    });
    const readResult = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(readResult.title).toBe("Renamed Cache Doc");
  });

  test("rename_folder invalidates path cache for documents under folder", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "allow", rules: [] },
    });
    await callToolOk(ctx.mcpClient, "rename_folder", {
      file_id: "folder_a",
      title: "Renamed Folder Cache",
    });
    const readResult = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(readResult.title).toBe("Test Document");
  });

  test("move_document invalidates path cache for moved document", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "allow", rules: [] },
    });
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    const readResult = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(readResult.title).toBe("Test Document");
  });

  test("move_folder invalidates path cache for moved folder", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "allow", rules: [] },
    });
    await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
    });
    const readResult = await callToolOk(ctx.mcpClient, "read_document", { file_id: "doc1" });
    expect(readResult.title).toBe("Test Document");
  });
});

// ─── response shapes ─────────────────────────────────────────────────

describe("response shapes", () => {
  test("create_document response includes file_id, title", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      title: "Shape Test Doc",
      reference_file_id: "folder_a",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(result.title).toBe("Shape Test Doc");
  });

  test("create_folder response includes file_id, title", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      title: "Shape Test Folder",
      reference_file_id: "root_folder",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(result.title).toBe("Shape Test Folder");
  });

  test("rename_document response includes file_id, title", async () => {
    const result = await callToolOk(ctx.mcpClient, "rename_document", {
      file_id: "doc1",
      title: "Shape Renamed Doc",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.title).toBe("Shape Renamed Doc");
  });

  test("rename_folder response includes file_id, title", async () => {
    const result = await callToolOk(ctx.mcpClient, "rename_folder", {
      file_id: "folder_a",
      title: "Shape Renamed Folder",
    });
    expect(result.file_id).toBe("folder_a");
    expect(result.title).toBe("Shape Renamed Folder");
  });

  test("move_document response includes file_id, parent_folder_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.parent_folder_id).toBe("string");
    expect(result.file_id).toBe("doc1");
    expect(result.parent_folder_id).toBe("folder_b");
  });

  test("move_folder response includes file_id, parent_folder_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.parent_folder_id).toBe("string");
    expect(result.file_id).toBe("folder_a");
    expect(result.parent_folder_id).toBe("folder_b");
  });
});
