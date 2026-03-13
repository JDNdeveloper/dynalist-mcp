import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
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

// ─── Response shape validation helpers ──────────────────────────────

/**
 * Content block shape returned in the `content` array.
 */
interface TextContentBlock {
  type: "text";
  text: string;
}

/**
 * Validate the common envelope of a successful tool response.
 * Every success response must have structuredContent, a text content
 * block for backwards compatibility, and isError must be absent or false.
 */
function assertSuccessEnvelope(
  result: { structuredContent?: unknown; content?: unknown; isError?: boolean },
): Record<string, unknown> {
  // structuredContent must be present and be an object.
  expect(result.structuredContent).toBeDefined();
  expect(typeof result.structuredContent).toBe("object");
  expect(result.structuredContent).not.toBeNull();

  // isError must be absent or false on success responses.
  expect(result.isError).toBeFalsy();

  // Text content block must be present for backwards compatibility.
  expect(result.content).toBeDefined();
  expect(Array.isArray(result.content)).toBe(true);
  const contentArray = result.content as TextContentBlock[];
  expect(contentArray.length).toBeGreaterThanOrEqual(1);
  expect(contentArray[0].type).toBe("text");
  expect(typeof contentArray[0].text).toBe("string");

  // The text content block should be valid JSON matching structuredContent.
  const parsed = JSON.parse(contentArray[0].text);
  expect(parsed).toEqual(result.structuredContent);

  return result.structuredContent as Record<string, unknown>;
}

/**
 * Validate the common envelope of an error tool response.
 * Every error response must have structuredContent with error + message,
 * a text content block, and isError: true.
 */
function assertErrorEnvelope(
  result: { structuredContent?: unknown; content?: unknown; isError?: boolean },
): { error: string; message: string } {
  // isError must be true on error responses.
  expect(result.isError).toBe(true);

  // structuredContent must be present with error and message fields.
  expect(result.structuredContent).toBeDefined();
  expect(typeof result.structuredContent).toBe("object");
  expect(result.structuredContent).not.toBeNull();

  const structured = result.structuredContent as Record<string, unknown>;
  expect(typeof structured.error).toBe("string");
  expect(typeof structured.message).toBe("string");
  expect((structured.error as string).length).toBeGreaterThan(0);
  expect((structured.message as string).length).toBeGreaterThan(0);

  // Text content block must be present for backwards compatibility.
  expect(result.content).toBeDefined();
  expect(Array.isArray(result.content)).toBe(true);
  const contentArray = result.content as TextContentBlock[];
  expect(contentArray.length).toBeGreaterThanOrEqual(1);
  expect(contentArray[0].type).toBe("text");
  expect(typeof contentArray[0].text).toBe("string");

  // The text content block should be valid JSON containing error and message.
  const parsed = JSON.parse(contentArray[0].text);
  expect(parsed.error).toBe(structured.error);
  expect(parsed.message).toBe(structured.message);

  return structured as { error: string; message: string };
}

// ─── list_documents ─────────────────────────────────────────────────

describe("list_documents response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "list_documents");
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.count).toBe("number");
    expect(Array.isArray(data.documents)).toBe(true);
    expect(Array.isArray(data.folders)).toBe(true);
    expect(typeof data.root_file_id).toBe("string");
  });
});

// ─── search_documents ───────────────────────────────────────────────

describe("search_documents response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "search_documents", { query: "Test" });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.count).toBe("number");
    expect(typeof data.query).toBe("string");
    expect(Array.isArray(data.matches)).toBe(true);
  });

  test("no matches still has correct success envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "search_documents", { query: "zzz_nonexistent_zzz" });
    const data = assertSuccessEnvelope(raw);
    expect(data.count).toBe(0);
    expect(Array.isArray(data.matches)).toBe(true);
  });
});

// ─── read_document ──────────────────────────────────────────────────

describe("read_document response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "read_document", { file_id: "doc1" });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
    expect(typeof data.url).toBe("string");
    expect(data.node).toBeDefined();

    // Validate the root node shape.
    const node = data.node as Record<string, unknown>;
    expect(typeof node.node_id).toBe("string");
    expect(typeof node.content).toBe("string");
    expect(typeof node.collapsed).toBe("boolean");
    expect(typeof node.children_count).toBe("number");
    expect(Array.isArray(node.children)).toBe(true);
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "read_document", { file_id: "nonexistent" });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for non-existent node has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      node_id: "bad_node",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NodeNotFound");
  });
});

// ─── search_in_document ─────────────────────────────────────────────

describe("search_in_document response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "search_in_document", {
      file_id: "doc1",
      query: "First",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
    expect(typeof data.url).toBe("string");
    expect(typeof data.count).toBe("number");
    expect(typeof data.query).toBe("string");
    expect(Array.isArray(data.matches)).toBe(true);

    // Validate match shape if there are results.
    const matches = data.matches as Record<string, unknown>[];
    expect(matches.length).toBeGreaterThan(0);
    const match = matches[0];
    expect(typeof match.node_id).toBe("string");
    expect(typeof match.content).toBe("string");
    expect(typeof match.url).toBe("string");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "search_in_document", {
      file_id: "nonexistent",
      query: "test",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });
});

// ─── get_recent_changes ─────────────────────────────────────────────

describe("get_recent_changes response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "get_recent_changes", {
      file_id: "doc1",
      since: 0,
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
    expect(typeof data.url).toBe("string");
    expect(typeof data.count).toBe("number");
    expect(Array.isArray(data.matches)).toBe(true);

    // Validate match shape if there are results.
    const matches = data.matches as Record<string, unknown>[];
    if (matches.length > 0) {
      const match = matches[0];
      expect(typeof match.node_id).toBe("string");
      expect(typeof match.content).toBe("string");
      expect(typeof match.url).toBe("string");
      expect(typeof match.created).toBe("number");
      expect(typeof match.modified).toBe("number");
      expect(typeof match.change_type).toBe("string");
    }
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "get_recent_changes", {
      file_id: "nonexistent",
      since: 0,
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });
});

// ─── check_document_versions ────────────────────────────────────────

describe("check_document_versions response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "check_document_versions", {
      file_ids: ["doc1", "doc2"],
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.versions).toBe("object");
    expect(data.versions).not.toBeNull();
    const versions = data.versions as Record<string, number>;
    expect(typeof versions["doc1"]).toBe("number");
    expect(typeof versions["doc2"]).toBe("number");
  });

  test("success response for empty file_ids has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "check_document_versions", {
      file_ids: [],
    });
    const data = assertSuccessEnvelope(raw);
    expect(typeof data.versions).toBe("object");
  });
});

// ─── edit_nodes ──────────────────────────────────────────────────────

describe("edit_nodes response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      nodes: [{ node_id: "n1", content: "Updated content" }],
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.edited_count).toBe("number");
    expect(Array.isArray(data.node_ids)).toBe(true);
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "edit_nodes", {
      file_id: "nonexistent",
      nodes: [{ node_id: "n1", content: "test" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for non-existent node has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      nodes: [{ node_id: "bad_node", content: "test" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NodeNotFound");
  });
});

// ─── insert_nodes ───────────────────────────────────────────────────

describe("insert_nodes response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [{ content: "Item A" }, { content: "Item B" }],
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.total_created).toBe("number");
    expect(Array.isArray(data.root_node_ids)).toBe(true);
    expect(typeof data.url).toBe("string");
  });

  test("error response for empty nodes array has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      nodes: [],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "insert_nodes", {
      file_id: "nonexistent",
      nodes: [{ content: "test" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });
});

// ─── send_to_inbox ──────────────────────────────────────────────────

describe("send_to_inbox response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "Inbox item",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.node_id).toBe("string");
    expect(typeof data.url).toBe("string");
  });

  test("error response for empty content has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });
});

// ─── delete_node ────────────────────────────────────────────────────

describe("delete_node response shape", () => {
  test("success response for leaf deletion has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1a",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.deleted_count).toBe("number");
  });

  test("success response for deletion with promotion has promoted_children", async () => {
    const raw = await callTool(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      include_children: false,
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.deleted_count).toBe("number");
    expect(typeof data.promoted_children).toBe("number");
  });

  test("error response for deleting root node has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "root",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "delete_node", {
      file_id: "nonexistent",
      node_id: "n1",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });
});

// ─── move_nodes ─────────────────────────────────────────────────────

describe("move_nodes response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n2a", reference_node_id: "n1", position: "last_child" }],
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.moved_count).toBe("number");
    expect(Array.isArray(data.node_ids)).toBe(true);
  });

  test("error response for self-referential move has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1", position: "last_child" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_nodes", {
      file_id: "nonexistent",
      moves: [{ node_id: "n1", reference_node_id: "n2", position: "after" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });
});

// ─── create_document ────────────────────────────────────────────────

describe("create_document response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "create_document", {
      parent_folder_id: "folder_a",
      title: "New Doc",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
    expect(typeof data.url).toBe("string");
  });

  test("error response for non-existent parent folder has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "create_document", {
      parent_folder_id: "nonexistent",
      title: "New Doc",
    });
    const err = assertErrorEnvelope(raw);
  });
});

// ─── create_folder ──────────────────────────────────────────────────

describe("create_folder response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "create_folder", {
      parent_folder_id: "folder_a",
      title: "New Folder",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
  });

  test("error response for non-existent parent folder has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "create_folder", {
      parent_folder_id: "nonexistent",
      title: "New Folder",
    });
    const err = assertErrorEnvelope(raw);
  });
});

// ─── rename_document ────────────────────────────────────────────────

describe("rename_document response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "rename_document", {
      file_id: "doc1",
      title: "Renamed Document",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "rename_document", {
      file_id: "nonexistent",
      title: "New Name",
    });
    const err = assertErrorEnvelope(raw);
  });
});

// ─── rename_folder ──────────────────────────────────────────────────

describe("rename_folder response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "rename_folder", {
      file_id: "folder_a",
      title: "Renamed Folder",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
  });

  test("error response for non-existent folder has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "rename_folder", {
      file_id: "nonexistent",
      title: "New Name",
    });
    const err = assertErrorEnvelope(raw);
  });
});

// ─── move_document ──────────────────────────────────────────────────

describe("move_document response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.parent_folder_id).toBe("string");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_document", {
      file_id: "nonexistent",
      parent_folder_id: "folder_a",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for non-existent destination has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      parent_folder_id: "nonexistent",
    });
    const err = assertErrorEnvelope(raw);
  });
});

// ─── move_folder ────────────────────────────────────────────────────

describe("move_folder response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      parent_folder_id: "folder_b",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.parent_folder_id).toBe("string");
  });

  test("error response for non-existent folder has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_folder", {
      file_id: "nonexistent",
      parent_folder_id: "folder_b",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for document file_id has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_folder", {
      file_id: "doc1",
      parent_folder_id: "folder_b",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidArgument");
  });
});
