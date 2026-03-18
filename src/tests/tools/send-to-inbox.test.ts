/**
 * Tests for send_to_inbox successful operations.
 * Covers basic sends, optional fields, config defaults, and
 * Zod schema validation for out-of-range parameters.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callTool,
  callToolOk,
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

// ─── Basic sends ─────────────────────────────────────────────────────

describe("send_to_inbox", () => {
  test("sends content-only item to inbox", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Buy groceries",
    });

    expect(result.file_id).toBe("inbox_doc");
    expect(result.item_id).toBeString();

    // Verify the node was created in the inbox document.
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.item_id);
    expect(node).toBeDefined();
    expect(node!.content).toBe("Buy groceries");
  });

  test("sends item with note", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Read paper",
      note: "The one about distributed systems",
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.item_id)!;
    expect(node.content).toBe("Read paper");
    expect(node.note).toBe("The one about distributed systems");
  });

  test("sends item with show_checkbox, heading, and color", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Important task",
      show_checkbox: true,
      heading: "h2",
      color: "yellow",
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.item_id)!;
    expect(node.content).toBe("Important task");
    expect(node.checkbox).toBe(true);
    expect(node.heading).toBe(2);
    expect(node.color).toBe(3);
  });

  test("sends item with checked state", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Already done",
      show_checkbox: true,
      checked: true,
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.item_id)!;
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(true);
  });

  // ─── Validation: invalid string values ─────────────────────────────

  test("rejects invalid heading string", async () => {
    const result = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "Bad heading",
      heading: "h4",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("heading");
  });

  test("rejects invalid color string", async () => {
    const result = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "Bad color",
      color: "magenta",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("color");
  });
});
