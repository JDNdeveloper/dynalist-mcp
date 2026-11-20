/**
 * Shared Zod schema helpers for tool input parameters.
 */

import { z } from "zod";

/**
 * Wraps a numeric schema to also accept a string-encoded number (e.g. "2"),
 * since some MCP clients serialize all tool arguments as strings. Blank
 * strings are passed through unconverted so they still fail validation
 * instead of silently coercing to 0, which z.coerce.number() would do.
 */
export function numberFromString<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((value) => {
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  }, schema);
}
