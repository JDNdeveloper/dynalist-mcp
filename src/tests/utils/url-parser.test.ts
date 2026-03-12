import { describe, test, expect } from "bun:test";
import { buildDynalistUrl } from "../../utils/url-parser";

describe("buildDynalistUrl", () => {
  test("document-only URL", () => {
    expect(buildDynalistUrl("abc123")).toBe("https://dynalist.io/d/abc123");
  });

  test("URL with node ID", () => {
    expect(buildDynalistUrl("abc123", "nodeXYZ")).toBe(
      "https://dynalist.io/d/abc123#z=nodeXYZ"
    );
  });

  test("no node ID when undefined", () => {
    expect(buildDynalistUrl("doc1", undefined)).toBe("https://dynalist.io/d/doc1");
  });

  test("empty string node ID is treated as falsy", () => {
    expect(buildDynalistUrl("doc1", "")).toBe("https://dynalist.io/d/doc1");
  });
});
