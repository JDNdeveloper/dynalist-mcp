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
    expect(result.node_id).toBeString();
    expect(result.url).toContain("inbox_doc");
    expect(result.url).toContain(result.node_id as string);

    // Verify the node was created in the inbox document.
    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.node_id);
    expect(node).toBeDefined();
    expect(node!.content).toBe("Buy groceries");
  });

  test("sends item with note", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Read paper",
      note: "The one about distributed systems",
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.node_id)!;
    expect(node.content).toBe("Read paper");
    expect(node.note).toBe("The one about distributed systems");
  });

  test("sends item with checkbox, heading, and color", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Important task",
      checkbox: true,
      heading: 2,
      color: 3,
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.node_id)!;
    expect(node.content).toBe("Important task");
    expect(node.checkbox).toBe(true);
    expect(node.heading).toBe(2);
    expect(node.color).toBe(3);
  });

  test("sends item with checked state", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Already done",
      checkbox: true,
      checked: true,
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.node_id)!;
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(true);
  });

  // ─── Config defaults ────────────────────────────────────────────────

  test("uses defaultCheckbox from config when checkbox is omitted", async () => {
    // Recreate context with defaultCheckbox enabled.
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      inbox: { defaultCheckbox: true },
    });

    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Should have checkbox from config",
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.node_id)!;
    expect(node.checkbox).toBe(true);
  });

  test("explicit checkbox false overrides defaultCheckbox true", async () => {
    await ctx.cleanup();
    ctx = await createTestContext(standardSetup, {
      inbox: { defaultCheckbox: true },
    });

    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "No checkbox despite config",
      checkbox: false,
    });

    const doc = ctx.server.documents.get("inbox_doc")!;
    const node = doc.nodes.find((n) => n.id === result.node_id)!;
    // Explicit false overrides the config default of true.
    expect(node.checkbox).toBe(false);
  });

  // ─── Validation: out-of-range parameters ────────────────────────────

  test("rejects heading above max (5)", async () => {
    const result = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "Bad heading",
      heading: 5,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("heading");
  });

  test("rejects heading below min (-1)", async () => {
    const result = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "Bad heading",
      heading: -1,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("heading");
  });

  test("rejects color above max (10)", async () => {
    const result = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "Bad color",
      color: 10,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("color");
  });

  test("rejects color below min (-1)", async () => {
    const result = await callTool(ctx.mcpClient, "send_to_inbox", {
      content: "Bad color",
      color: -1,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("color");
  });
});
