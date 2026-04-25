/**
 * Tests for meta tools (get_instructions).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, callToolOk, type TestContext } from "./test-helpers";
import { INSTRUCTIONS } from "../../instructions";
import { INSTRUCTIONS_FIRST_GUIDANCE } from "../../tools/descriptions";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("get_instructions", () => {
  test("returns the full INSTRUCTIONS string", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_instructions");

    expect(result.instructions).toBe(INSTRUCTIONS);
  });

  test("takes no parameters", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_instructions", {});

    expect(typeof result.instructions).toBe("string");
    expect((result.instructions as string).length).toBeGreaterThan(0);
  });

  test("requires instructions before every non-meta tool description", async () => {
    const result = await ctx.mcpClient.listTools();
    const prefix = `${INSTRUCTIONS_FIRST_GUIDANCE} `;

    for (const tool of result.tools) {
      if (tool.name === "get_instructions") {
        expect(tool.description?.startsWith(prefix)).toBe(false);
      } else {
        expect(tool.description?.startsWith(prefix)).toBe(true);
      }
    }
  });
});
