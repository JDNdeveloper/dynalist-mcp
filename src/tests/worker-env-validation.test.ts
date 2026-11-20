import { describe, test, expect } from "bun:test";
import {
  isAllowedGithubUser,
  parseAllowedGithubUsers,
  validateConfigJson,
  validateDynalistApiToken,
  validateEnv,
  validateGithubClientId,
  validateGithubClientSecret,
  validateMcpResource,
} from "../worker/env-validation";

const VALID_ENV = {
  DYNALIST_API_TOKEN: "abc123token",
  GITHUB_CLIENT_ID: "Iv1.abcdef",
  GITHUB_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
  ALLOWED_GITHUB_USERS: "owner",
  MCP_RESOURCE: "https://dynalist-mcp.example.workers.dev/mcp",
  OAUTH_KV: {},
  MCP_OBJECT: {},
};

describe("Worker env validators", () => {
  describe("validateDynalistApiToken", () => {
    test("accepts a token without whitespace", () => {
      expect(validateDynalistApiToken("abc123").ok).toBe(true);
    });

    test("rejects empty, missing, and whitespace-containing tokens", () => {
      expect(validateDynalistApiToken("").ok).toBe(false);
      expect(validateDynalistApiToken(undefined).ok).toBe(false);
      expect(validateDynalistApiToken("abc 123").ok).toBe(false);
      expect(validateDynalistApiToken(" abc").ok).toBe(false);
    });
  });

  describe("validateGithubClientId", () => {
    test("accepts letters, digits, and dots", () => {
      expect(validateGithubClientId("Iv1.abc123").ok).toBe(true);
    });

    test("rejects empty, whitespace, and other characters", () => {
      expect(validateGithubClientId("").ok).toBe(false);
      expect(validateGithubClientId("Iv1 abc").ok).toBe(false);
      expect(validateGithubClientId("Iv1-abc").ok).toBe(false);
    });
  });

  describe("validateGithubClientSecret", () => {
    test("accepts 40 lowercase hex characters", () => {
      expect(validateGithubClientSecret("0123456789abcdef0123456789abcdef01234567").ok).toBe(true);
    });

    test("rejects empty, wrong length, uppercase, and whitespace", () => {
      expect(validateGithubClientSecret("").ok).toBe(false);
      expect(validateGithubClientSecret("0123456789abcdef").ok).toBe(false);
      expect(validateGithubClientSecret("0123456789ABCDEF0123456789abcdef01234567").ok).toBe(false);
      expect(validateGithubClientSecret("0123456789abcdef0123456789abcdef0123456 ").ok).toBe(false);
    });
  });

  describe("parseAllowedGithubUsers", () => {
    test("trims, lowercases, and deduplicates entries", () => {
      const result = parseAllowedGithubUsers(" Owner , other-user,owner");
      expect(result).toEqual({ ok: true, value: ["owner", "other-user"] });
    });

    test("rejects an empty value and an allowlist of only commas", () => {
      expect(parseAllowedGithubUsers("").ok).toBe(false);
      expect(parseAllowedGithubUsers(" , ,").ok).toBe(false);
    });

    test("rejects the whole list when one entry is invalid", () => {
      expect(parseAllowedGithubUsers("owner,-bad").ok).toBe(false);
      expect(parseAllowedGithubUsers("owner,has space").ok).toBe(false);
      expect(parseAllowedGithubUsers("owner,double--hyphen").ok).toBe(false);
      expect(parseAllowedGithubUsers(`owner,${"a".repeat(40)}`).ok).toBe(false);
    });

    test("rejects an empty entry between valid ones", () => {
      expect(parseAllowedGithubUsers("owner,,other").ok).toBe(false);
    });
  });

  test("isAllowedGithubUser compares case-insensitively", () => {
    expect(isAllowedGithubUser("Owner", ["owner"])).toBe(true);
    expect(isAllowedGithubUser("stranger", ["owner"])).toBe(false);
  });

  describe("validateMcpResource", () => {
    test("accepts https URLs and http on localhost", () => {
      expect(validateMcpResource("https://example.workers.dev/mcp").ok).toBe(true);
      expect(validateMcpResource("http://localhost:8787/mcp").ok).toBe(true);
    });

    test("rejects empty, relative, remote http, and query-bearing URLs", () => {
      expect(validateMcpResource("").ok).toBe(false);
      expect(validateMcpResource("/mcp").ok).toBe(false);
      expect(validateMcpResource("http://example.com/mcp").ok).toBe(false);
      expect(validateMcpResource("https://example.com/mcp?x=1").ok).toBe(false);
      expect(validateMcpResource("https://example.workers.dev/").ok).toBe(false);
    });
  });

  describe("validateConfigJson", () => {
    test("treats an unset value as no config", () => {
      expect(validateConfigJson(undefined)).toEqual({ ok: true, value: undefined });
    });

    test("rejects invalid JSON, schema violations, and logFile", () => {
      expect(validateConfigJson("{").ok).toBe(false);
      expect(validateConfigJson('{"logLevel": "loud"}').ok).toBe(false);
      expect(validateConfigJson('{"logFile": "/tmp/x.log"}').ok).toBe(false);
    });
  });

  describe("validateEnv", () => {
    test("returns no failures for a complete environment", () => {
      expect(validateEnv(VALID_ENV)).toEqual([]);
    });

    test("names each failing field and rule without its value", () => {
      const failures = validateEnv({ ...VALID_ENV, GITHUB_CLIENT_SECRET: "not-a-secret", OAUTH_KV: undefined });
      expect(failures.map((failure) => failure.name)).toEqual(["GITHUB_CLIENT_SECRET", "OAUTH_KV"]);
      expect(JSON.stringify(failures)).not.toContain("not-a-secret");
    });
  });
});
