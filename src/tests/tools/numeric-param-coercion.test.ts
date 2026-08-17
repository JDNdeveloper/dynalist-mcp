/**
 * Regression tests for string-encoded numeric params. Some MCP clients
 * serialize all tool arguments as strings, so numeric params must accept
 * "2" as well as 2 while still rejecting genuinely non-numeric strings.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callTool,
  callToolOk,
  getSyncToken,
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

describe("max_depth accepts string-encoded integers", () => {
  test("read_document with max_depth as a string behaves like the equivalent number", async () => {
    const asString = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: "1",
    });
    const asNumber = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 1,
    });
    expect(asString.item).toEqual(asNumber.item);

    // Contrast against a different depth to prove the coerced value ("1")
    // actually drove the traversal rather than the assertion above passing
    // trivially regardless of max_depth.
    const deeper = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 2,
    });
    expect(asString.item).not.toEqual(deeper.item);
  });

  test("list_documents with max_depth as a string behaves like the equivalent number", async () => {
    const asString = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: "1",
    });
    const asNumber = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 1,
    });
    expect(asString.files).toEqual(asNumber.files);
    expect(asString.document_count).toBe(asNumber.document_count as number);
  });

  test("read_document rejects a non-numeric max_depth string", async () => {
    const result = await callTool(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: "not-a-number",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("max_depth");
  });

  // z.coerce.number() would silently turn "" into 0, changing a blank/
  // omitted-looking value into a target-only read instead of an error.
  test("read_document rejects a blank max_depth string instead of silently treating it as 0", async () => {
    const result = await callTool(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: "",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("max_depth");
  });
});

describe("batch_index accepts string-encoded integers", () => {
  test("edit_items with batch_index as a string succeeds like the equivalent number", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");

    const first = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "First update" }],
      expected_sync_token: syncToken,
      batch_index: "0",
    });
    expect(first.sync_warning).toBeUndefined();

    const second = await callToolOk(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n2", content: "Second update" }],
      expected_sync_token: syncToken,
      batch_index: "1",
    });
    expect(second.sync_warning).toBeUndefined();
  });

  test("insert_items with batch_index as a string succeeds", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");

    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      inserts: [{
        position: "last_child",
        reference_item_id: "n1",
        items: [{ content: "New child" }],
      }],
      expected_sync_token: syncToken,
      batch_index: "0",
    });
    expect(result.created_count).toBe(1);
  });

  test("edit_items rejects a non-numeric batch_index string", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");

    const result = await callTool(ctx.mcpClient, "edit_items", {
      file_id: "doc1",
      items: [{ item_id: "n1", content: "Updated" }],
      expected_sync_token: syncToken,
      batch_index: "not-a-number",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("batch_index");
  });
});
