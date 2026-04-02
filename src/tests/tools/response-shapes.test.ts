import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callTool,
  getSyncToken,
  parseErrorContent,
  standardSetup,
  type TestContext,
} from "./test-helpers";
import { makeSyncToken } from "../../sync-token";

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
 * Every error response must have isError: true and a text content block
 * with JSON containing error + message fields.
 */
function assertErrorEnvelope(
  result: { structuredContent?: unknown; content?: unknown; isError?: boolean },
): { error: string; message: string } {
  expect(result.isError).toBe(true);

  const parsedError = parseErrorContent(result);
  expect(typeof parsedError.error).toBe("string");
  expect(typeof parsedError.message).toBe("string");
  expect((parsedError.error as string).length).toBeGreaterThan(0);
  expect((parsedError.message as string).length).toBeGreaterThan(0);

  return parsedError as { error: string; message: string };
}

// ─── list_documents ─────────────────────────────────────────────────

describe("list_documents response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "list_documents");
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.document_count).toBe("number");
    expect(Array.isArray(data.files)).toBe(true);
  });

  test("error response for invalid folder_id has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "list_documents", { folder_id: "nonexistent" });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for document as folder_id has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "list_documents", { folder_id: "doc1" });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });
});

// ─── search_documents ───────────────────────────────────────────────

describe("search_documents response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "search_documents", { query: "Test" });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.count).toBe("number");
    expect(data.query).toBeUndefined();
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
    expect(data.item).toBeDefined();

    // Validate the root node shape.
    const node = data.item as Record<string, unknown>;
    expect(typeof node.item_id).toBe("string");
    expect(typeof node.content).toBe("string");
    // Test doc has children, so child_count and children are both present (expanded shape).
    expect(typeof node.child_count).toBe("number");
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
      item_id: "bad_node",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("ItemNotFound");
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
    expect(typeof data.count).toBe("number");
    expect(data.query).toBeUndefined();
    expect(Array.isArray(data.matches)).toBe(true);

    // Validate match shape if there are results.
    const matches = data.matches as Record<string, unknown>[];
    expect(matches.length).toBeGreaterThan(0);
    const match = matches[0];
    expect(typeof match.item_id).toBe("string");
    expect(typeof match.content).toBe("string");
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
      since: "1970-01-01",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
    expect(typeof data.count).toBe("number");
    expect(Array.isArray(data.matches)).toBe(true);

    // Validate match shape if there are results.
    const matches = data.matches as Record<string, unknown>[];
    if (matches.length > 0) {
      const match = matches[0];
      expect(typeof match.item_id).toBe("string");
      expect(typeof match.content).toBe("string");
      expect(typeof match.created).toBe("string");
      expect(typeof match.modified).toBe("string");
      expect(typeof match.change_type).toBe("string");
    }
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "get_recent_changes", {
      file_id: "nonexistent",
      since: "1970-01-01",
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

    expect(typeof data.sync_tokens).toBe("object");
    expect(data.sync_tokens).not.toBeNull();
    const syncTokens = data.sync_tokens as Record<string, string>;
    expect(typeof syncTokens["doc1"]).toBe("string");
    expect(typeof syncTokens["doc2"]).toBe("string");
  });

  test("success response for empty file_ids has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "check_document_versions", {
      file_ids: [],
    });
    const data = assertSuccessEnvelope(raw);
    expect(typeof data.sync_tokens).toBe("object");
  });
});

// ─── edit_items ──────────────────────────────────────────────────────

describe("edit_items response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const raw = await callTool(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "n1", content: "Updated content" }],
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.edited_count).toBe("number");
    expect(data.item_ids).toBeUndefined();
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "edit_items", {
      file_id: "nonexistent",
      expected_sync_token: "zzzzz",
      items: [{ item_id: "n1", content: "test" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for non-existent node has correct envelope", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const raw = await callTool(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ item_id: "bad_node", content: "test" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("ItemNotFound");
  });
});

// ─── insert_items ───────────────────────────────────────────────────

describe("insert_items response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const raw = await callTool(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "Item A" }, { content: "Item B" }],
      position: "last_child",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.created_count).toBe("number");
    expect(Array.isArray(data.root_item_ids)).toBe(true);
  });

  test("error response for empty nodes array has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: "zzzzz",
      items: [],
      position: "last_child",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "insert_items", {
      file_id: "nonexistent",
      expected_sync_token: "zzzzz",
      items: [{ content: "test" }],
      position: "last_child",
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
    expect(typeof data.item_id).toBe("string");
  });

  test("error response for empty content has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });
});

// ─── delete_items ───────────────────────────────────────────────────

describe("delete_items response shape", () => {
  test("success response for leaf deletion has correct envelope and fields", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const raw = await callTool(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      item_ids: ["n1a"],
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.deleted_count).toBe("number");
  });

  test("success response for deletion with promotion has promoted_children_count", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const raw = await callTool(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      item_ids: ["n1"],
      children: "promote",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.deleted_count).toBe("number");
    expect(typeof data.promoted_children_count).toBe("number");
  });

  test("error response for deleting root node has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: "zzzzz",
      item_ids: ["root"],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "delete_items", {
      file_id: "nonexistent",
      expected_sync_token: "zzzzz",
      item_ids: ["n1"],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });
});

// ─── move_items ─────────────────────────────────────────────────────

describe("move_items response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const raw = await callTool(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      moves: [{ item_id: "n2a", reference_item_id: "n1", position: "last_child" }],
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.moved_count).toBe("number");
    expect(data.item_ids).toBeUndefined();
  });

  test("error response for self-referential move has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: makeSyncToken("doc1", 1),
      moves: [{ item_id: "n1", reference_item_id: "n1", position: "last_child" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidInput");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_items", {
      file_id: "nonexistent",
      expected_sync_token: "zzzzz",
      moves: [{ item_id: "n1", reference_item_id: "n2", position: "after" }],
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });
});

// ─── create_document ────────────────────────────────────────────────

describe("create_document response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "create_document", {
      title: "New Doc",
      reference_file_id: "folder_a",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
  });

  test("error response for non-existent parent folder has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "create_document", {
      title: "New Doc",
      reference_file_id: "nonexistent",
    });
    assertErrorEnvelope(raw);
  });
});

// ─── create_folder ──────────────────────────────────────────────────

describe("create_folder response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "create_folder", {
      title: "New Folder",
      reference_file_id: "folder_a",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.title).toBe("string");
  });

  test("error response for non-existent parent folder has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "create_folder", {
      title: "New Folder",
      reference_file_id: "nonexistent",
    });
    assertErrorEnvelope(raw);
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
    assertErrorEnvelope(raw);
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
    assertErrorEnvelope(raw);
  });
});

// ─── move_document ──────────────────────────────────────────────────

describe("move_document response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.parent_folder_id).toBe("string");
  });

  test("error response for non-existent document has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_document", {
      file_id: "nonexistent",
      reference_file_id: "folder_a",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for non-existent destination has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_document", {
      file_id: "doc1",
      reference_file_id: "nonexistent",
    });
    assertErrorEnvelope(raw);
  });
});

// ─── move_folder ────────────────────────────────────────────────────

describe("move_folder response shape", () => {
  test("success response has correct envelope and fields", async () => {
    const raw = await callTool(ctx.mcpClient, "move_folder", {
      file_id: "folder_a",
      reference_file_id: "folder_b",
    });
    const data = assertSuccessEnvelope(raw);

    expect(typeof data.file_id).toBe("string");
    expect(typeof data.parent_folder_id).toBe("string");
  });

  test("error response for non-existent folder has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_folder", {
      file_id: "nonexistent",
      reference_file_id: "folder_b",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("NotFound");
  });

  test("error response for document file_id has correct envelope", async () => {
    const raw = await callTool(ctx.mcpClient, "move_folder", {
      file_id: "doc1",
      reference_file_id: "folder_b",
    });
    const err = assertErrorEnvelope(raw);
    expect(err.error).toBe("InvalidArgument");
  });
});
