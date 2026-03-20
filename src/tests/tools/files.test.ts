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
      parent_folder_id: "folder_a",
      title: "New Doc",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("New Doc");
  });

  test("created document appears in list_documents", async () => {
    const createResult = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Created Doc",
    });

    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], createResult.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Created Doc");
  });

  test("index: 0 creates at top of folder", async () => {
    await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Top Doc",
      index: 0,
    });
    const folder = ctx.server.files.get("folder_a")!;
    const firstChild = ctx.server.files.get(folder.children![0])!;
    expect(firstChild.title).toBe("Top Doc");
  });

  test("creating in non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      parent_folder_id: "nonexistent",
      title: "Orphan Doc",
    });
    expect(err.error).toBeDefined();
  });

  test("default title creates document with empty or default title", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
    });
    expect(result.file_id).toBeDefined();
    // The document should be created even without specifying a title.
    expect(result.title).toBeDefined();
  });

  test("index: -1 appends to end of folder", async () => {
    // Folder A already has doc1 as a child.
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "End Doc",
      index: -1,
    });
    const folder = ctx.server.files.get("folder_a")!;
    const lastChildId = folder.children![folder.children!.length - 1];
    expect(lastChildId).toBe(result.file_id as string);
  });

  test("omitting parent_folder_id creates at top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      title: "Top Level Doc",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Top Level Doc");

    // Verify it appears as a top-level entry.
    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], result.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Top Level Doc");
  });
});

// ─── create_folder ───────────────────────────────────────────────────

describe("create_folder", () => {
  test("creates folder in parent", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      parent_folder_id: "root_folder",
      title: "New Folder",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("New Folder");
  });

  test("created folder appears in list_documents", async () => {
    const createResult = await callToolOk(ctx.mcpClient, "create_folder", {
      parent_folder_id: "root_folder",
      title: "Visible Folder",
    });

    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], createResult.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Visible Folder");
  });

  test("creating in non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      parent_folder_id: "nonexistent",
      title: "Orphan Folder",
    });
    expect(err.error).toBeDefined();
  });

  test("omitting parent_folder_id creates at top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      title: "Top Level Folder",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Top Level Folder");

    // Verify it appears as a top-level entry.
    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const found = findInFileTree(listResult.files as Record<string, unknown>[], result.file_id as string);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Top Level Folder");
  });
});

// ─── create_document with document as parent ─────────────────────────

describe("create_document with document as parent", () => {
  test("returns error when parent_folder_id is a document", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      parent_folder_id: "doc1",
      title: "Should Fail",
    });
    expect(err.error).toBeDefined();
  });
});

// ─── create_folder with document as parent ───────────────────────────

describe("create_folder with document as parent", () => {
  test("returns error when parent_folder_id is a document", async () => {
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      parent_folder_id: "doc1",
      title: "Should Fail",
    });
    expect(err.error).toBeDefined();
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
  test("moves document between folders", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.parent_folder_id).toBe("folder_b");

    // Verify doc1 is now in folder_b.
    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children).toContain("doc1");

    // And removed from folder_a.
    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).not.toContain("doc1");
  });

  test("rejects folder file_id", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "folder_a",
      parent_folder_id: "folder_b",
    });
    expect(err.error).toBe("InvalidArgument");
  });

  test("moving to non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "nonexistent",
    });
    expect(err.error).toBeDefined();
  });

  test("moving non-existent document returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "nonexistent",
      parent_folder_id: "folder_a",
    });
    expect(err.error).toBeDefined();
  });

  test("index: 0 places document at top of destination", async () => {
    // Add a second doc to folder_b so it already has children.
    ctx.server.addDocument("doc_extra", "Extra Doc", "folder_b", [
      ctx.server.makeNode("root", "Extra Doc", []),
    ]);

    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
      index: 0,
    });

    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children![0]).toBe("doc1");
  });

  test("index: -1 appends document to end of destination", async () => {
    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
      index: -1,
    });

    const folderB = ctx.server.files.get("folder_b")!;
    const lastChildId = folderB.children![folderB.children!.length - 1];
    expect(lastChildId).toBe("doc1");
  });

  test("omitting parent_folder_id moves to top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
    });
    expect(result.file_id).toBe("doc1");

    // Should be removed from folder_a.
    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).not.toContain("doc1");

    // Should be in root folder.
    const root = ctx.server.files.get("root_folder")!;
    expect(root.children).toContain("doc1");
  });

  test("document disappears from source folder children after move", async () => {
    const folderABefore = ctx.server.files.get("folder_a")!;
    expect(folderABefore.children).toContain("doc1");

    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
    });

    const folderAAfter = ctx.server.files.get("folder_a")!;
    expect(folderAAfter.children).not.toContain("doc1");
  });
});

// ─── move_folder ────────────────────────────────────────────────────

describe("move_folder", () => {
  test("moves folder with children", async () => {
    // Move folder_a (which contains doc1) into folder_b.
    const result = await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      parent_folder_id: "folder_b",
    });
    expect(result.file_id).toBe("folder_a");

    const folderB = ctx.server.files.get("folder_b")!;
    expect(folderB.children).toContain("folder_a");

    // folder_a's children should be unaffected.
    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).toContain("doc1");
  });

  test("omitting parent_folder_id moves to top level", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
    });
    expect(result.file_id).toBe("folder_a");

    // folder_a should be a direct child of root.
    const root = ctx.server.files.get("root_folder")!;
    expect(root.children).toContain("folder_a");

    // Its children should be unaffected.
    const folderA = ctx.server.files.get("folder_a")!;
    expect(folderA.children).toContain("doc1");
  });

  test("rejects document file_id", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
    });
    expect(err.error).toBe("InvalidArgument");
  });

  test("moving to non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      parent_folder_id: "nonexistent",
    });
    expect(err.error).toBeDefined();
  });

  test("moving non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "nonexistent",
      parent_folder_id: "folder_b",
    });
    expect(err.error).toBeDefined();
  });
});

// ─── cache invalidation after file operations ────────────────────────

describe("cache invalidation after file operations", () => {
  // These tests verify that file management operations invalidate the
  // AccessController path cache so that ACL resolves correctly for
  // newly created, renamed, or moved files.

  // These tests need their own context with ACL config active.

  test("create_document invalidates path cache for new document", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "deny", rules: [{ path: "/Folder A/**", policy: "allow" }] },
    });

    // Create a new doc inside Folder A.
    const createResult = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Cache Test Doc",
    });

    // If cache was invalidated, reading the new doc should succeed
    // because it is under /Folder A/ which has allow policy.
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

    const readResult = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
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

    const readResult = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    expect(readResult.title).toBe("Test Document");
  });

  test("move_document invalidates path cache for moved document", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "allow", rules: [] },
    });

    await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
    });

    const readResult = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    expect(readResult.title).toBe("Test Document");
  });

  test("move_folder invalidates path cache for moved folder", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      access: { default: "allow", rules: [] },
    });

    await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      parent_folder_id: "folder_b",
    });

    const readResult = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    expect(readResult.title).toBe("Test Document");
  });
});

// ─── response shapes ─────────────────────────────────────────────────

describe("response shapes", () => {
  test("create_document response includes file_id, title", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Shape Test Doc",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(result.title).toBe("Shape Test Doc");
  });

  test("create_folder response includes file_id, title", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      parent_folder_id: "root_folder",
      title: "Shape Test Folder",
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
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(result.file_id).toBe("doc1");
    expect(result.title).toBe("Shape Renamed Doc");
  });

  test("rename_folder response includes file_id, title", async () => {
    const result = await callToolOk(ctx.mcpClient, "rename_folder", {
      file_id: "folder_a",
      title: "Shape Renamed Folder",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(result.file_id).toBe("folder_a");
    expect(result.title).toBe("Shape Renamed Folder");
  });

  test("move_document response includes file_id, parent_folder_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.parent_folder_id).toBe("string");
    expect(result.file_id).toBe("doc1");
    expect(result.parent_folder_id).toBe("folder_b");
  });

  test("move_folder response includes file_id, parent_folder_id", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      parent_folder_id: "folder_b",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.parent_folder_id).toBe("string");
    expect(result.file_id).toBe("folder_a");
    expect(result.parent_folder_id).toBe("folder_b");
  });
});

// ─── File creation with out-of-bounds index ───────────────────────────

describe("file creation with out-of-bounds index", () => {
  let idxCtx: TestContext;

  beforeEach(async () => {
    idxCtx = await createTestContext(standardSetup);
  });

  afterEach(async () => {
    await idxCtx.cleanup();
  });

  test("create_document with index far beyond folder child count succeeds", async () => {
    // folder_a has 1 child (doc1). Using index=1000 should still create.
    const result = await callToolOk(idxCtx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Out of Bounds Doc",
      index: 1000,
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Out of Bounds Doc");

    // Verify the document was created in the folder.
    const folder = idxCtx.server.files.get("folder_a")!;
    expect(folder.children).toContain(result.file_id as string);
  });

  test("create_folder with index far beyond parent child count succeeds", async () => {
    // root_folder has a few children. Using index=1000 should still create.
    const result = await callToolOk(idxCtx.mcpClient, "create_folder", {
      parent_folder_id: "root_folder",
      title: "Out of Bounds Folder",
      index: 1000,
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("Out of Bounds Folder");

    // Verify the folder was created.
    const root = idxCtx.server.files.get("root_folder")!;
    expect(root.children).toContain(result.file_id as string);
  });

  test("create_document with index 0 in empty folder places it first", async () => {
    // Add an empty folder.
    idxCtx.server.addFolder("empty_folder", "Empty Folder", "root_folder");
    const result = await callToolOk(idxCtx.mcpClient, "create_document", {
      parent_folder_id: "empty_folder",
      title: "First Doc",
      index: 0,
    });
    expect(result.file_id).toBeDefined();
    const folder = idxCtx.server.files.get("empty_folder")!;
    expect(folder.children).toHaveLength(1);
    expect(folder.children![0]).toBe(result.file_id as string);
  });

  test("create_document with large index in folder with children appends at end", async () => {
    // folder_a has [doc1]. Using index=999 should place the new doc after doc1.
    const result = await callToolOk(idxCtx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Appended Doc",
      index: 999,
    });
    const folder = idxCtx.server.files.get("folder_a")!;
    // The new doc should be at the end (splice with out-of-bounds index appends).
    const lastChild = folder.children![folder.children!.length - 1];
    expect(lastChild).toBe(result.file_id as string);
  });
});
