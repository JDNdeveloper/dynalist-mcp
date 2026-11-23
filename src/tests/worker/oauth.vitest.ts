import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SELF, env, createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { DummyDynalistServer } from "../dummy-server";
import { standardSetup } from "../tools/test-helpers";
import { handleWorkerRequest, resetWorkerStateForTests } from "../../worker/app";
import type { Env } from "../../worker/env";
import {
  BASE_URL,
  GithubStub,
  authorize,
  connectMcpClient,
  installOutboundStubs,
  mcpObjectStub,
  mcpRequest,
  postMcp,
  runOAuthFlow,
} from "./harness";

type SecretOrVarName = Exclude<keyof Env, "OAUTH_KV" | "MCP_OBJECT">;

const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

/**
 * Send one request through the Worker with a modified environment. The
 * per-isolate env validation result is reset first and again afterward,
 * so the override does not leak into other tests.
 */
async function fetchWithEnv(overrides: Partial<Record<SecretOrVarName, string | undefined>>, request: Request): Promise<Response> {
  resetWorkerStateForTests();
  try {
    const ctx = createExecutionContext();
    const response = await handleWorkerRequest(request, { ...env, ...overrides } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  } finally {
    resetWorkerStateForTests();
  }
}

describe("Worker OAuth", () => {
  let github: GithubStub;

  beforeEach(() => {
    const dynalist = new DummyDynalistServer();
    dynalist.init();
    standardSetup(dynalist);
    github = new GithubStub();
    installOutboundStubs(dynalist, github);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("unauthenticated requests", () => {
    it("returns 401 with WWW-Authenticate for /mcp without a token", async () => {
      const response = await postMcp(TOOLS_LIST);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    });

    it("serves protected resource metadata whose resource matches MCP_RESOURCE", async () => {
      const metadata = await SELF.fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`);
      expect(metadata.status).toBe(200);
      const body = await metadata.json() as { resource: string };
      expect(body.resource).toBe(env.MCP_RESOURCE);
    });
  });

  describe("sign-in", () => {
    it("completes OAuth for an allowlisted login and can list tools", async () => {
      const accessToken = await authorize();
      const client = await connectMcpClient(accessToken);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("read_document");
      await client.close();
    });

    it("matches allowlisted logins case-insensitively", async () => {
      github.login = "Allowed-Owner";
      const outcome = await runOAuthFlow();
      expect(outcome.kind).toBe("token");
    });

    it("issues no grant for a login that is not on the allowlist", async () => {
      github.login = "someone-else";
      // KV is shared across tests in this file, so compare grant counts.
      const before = (await env.OAUTH_KV.list({ prefix: "grant:" })).keys.length;
      const outcome = await runOAuthFlow();
      expect(outcome).toMatchObject({ kind: "rejected", status: 403 });
      // The callback stops before completeAuthorization, so no grant is added.
      const after = (await env.OAUTH_KV.list({ prefix: "grant:" })).keys.length;
      expect(after).toBe(before);
    });

    it("keeps sign-in and rejection entries in the audit log", async () => {
      github.login = "audit-rejected";
      await runOAuthFlow();
      github.login = "Allowed-Owner";
      await runOAuthFlow();

      // The Worker writes the entries in the background after responding.
      await vi.waitFor(async () => {
        const lines = await runInDurableObject(mcpObjectStub(), (_instance, state) =>
          state.storage.sql.exec("SELECT line FROM audit_log").toArray().map((row) => String(row.line)),
        );
        expect(lines.some((line) => line.includes('Rejected sign-in from GitHub account "audit-rejected"'))).toBe(true);
        expect(lines.some((line) => line.includes('Signed in GitHub account "Allowed-Owner"'))).toBe(true);
      });
    });

    it("rejects existing tokens once their login is removed from the allowlist", async () => {
      const accessToken = await authorize();
      const response = await fetchWithEnv({ ALLOWED_GITHUB_USERS: "a-different-owner" }, mcpRequest(TOOLS_LIST, accessToken));
      expect(response.status).toBe(403);
      const body = await response.json() as { error: { message: string } };
      expect(body.error.message).toContain("not allowed");
    });
  });

  describe("environment validation", () => {
    const routes = [
      () => mcpRequest(TOOLS_LIST),
      () => new Request(`${BASE_URL}/authorize?response_type=code&client_id=x`),
      () => new Request(`${BASE_URL}/token`, { method: "POST" }),
    ];

    it("returns 503 on every route when a secret is missing, without naming it", async () => {
      for (const route of routes) {
        const response = await fetchWithEnv({ GITHUB_CLIENT_SECRET: undefined }, route());
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("GITHUB_CLIENT_SECRET");
      }
    });

    it("returns 503 on every route when the allowlist is empty", async () => {
      for (const route of routes) {
        const response = await fetchWithEnv({ ALLOWED_GITHUB_USERS: " , " }, route());
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("ALLOWED_GITHUB_USERS");
      }
    });

    it("returns a JSON-RPC error from /mcp when misconfigured", async () => {
      const response = await fetchWithEnv({ DYNALIST_API_TOKEN: "" }, mcpRequest(TOOLS_LIST));
      expect(response.status).toBe(503);
      const body = await response.json() as { error: { message: string } };
      expect(body.error.message).toContain("misconfigured");
    });

    // Config errors are logged, never returned, because env validation runs
    // before OAuth on a public URL.
    it("returns the generic 503 for an invalid DYNALIST_MCP_CONFIG_JSON without the ConfigError text", async () => {
      const response = await fetchWithEnv({ DYNALIST_MCP_CONFIG_JSON: '{"logFile": "/tmp/x.log"}' }, mcpRequest(TOOLS_LIST));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toContain("misconfigured");
      expect(text).not.toContain("logFile");
    });
  });
});
