/**
 * Parity suite setup: adds the bun:test matchers the tool tests use that
 * vitest lacks.
 */

import { expect } from "vitest";

expect.extend({
  toBeString(received: unknown) {
    return {
      pass: typeof received === "string",
      message: () => `expected ${String(received)} to be a string`,
    };
  },
});

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toBeString(): T;
  }
}
