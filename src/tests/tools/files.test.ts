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

// ─── create_document ─────────────────────────────────────────────────

describe("create_document", () => {
  test("creates document in folder", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "New Doc",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("New Doc");
    expect(result.url).toContain(result.file_id as string);
  });

  test("created document appears in list_documents", async () => {
    const createResult = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "Created Doc",
    });

    const listResult = await callToolOk(ctx.mcpClient, "list_documents");
    const docs = listResult.documents as Record<string, unknown>[];
    const found = docs.find((d) => d.id === createResult.file_id);
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
    const folders = listResult.folders as Record<string, unknown>[];
    const found = folders.find((f) => f.id === createResult.file_id);
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
    const docs = listResult.documents as Record<string, unknown>[];
    const doc = docs.find((d) => d.id === "doc1")!;
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
    const folders = listResult.folders as Record<string, unknown>[];
    const folder = folders.find((f) => f.id === "folder_a")!;
    expect(folder.title).toBe("New Folder Name");
  });
});

// ─── move_file ───────────────────────────────────────────────────────

describe("move_file", () => {
  test("moves document between folders", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_file", {
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

  test("moves folder with children", async () => {
    // Move folder_a (which contains doc1) into folder_b.
    const result = await callToolOk(ctx.mcpClient, "move_file", {
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

  test("moving to non-existent folder returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_file", {
      file_id: "doc1",
      parent_folder_id: "nonexistent",
    });
    expect(err.error).toBeDefined();
  });

  test("moving non-existent file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_file", {
      file_id: "nonexistent",
      parent_folder_id: "folder_a",
    });
    expect(err.error).toBeDefined();
  });
});
