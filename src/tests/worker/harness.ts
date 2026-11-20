/**
 * Shared helpers for the Worker tests. They run inside the Workers
 * runtime, where the Worker, its Durable Object, and the tests share one
 * isolate, so stubbing globalThis.fetch routes the Worker's outbound
 * Dynalist and GitHub requests to in-memory stubs.
 */

import { SELF, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DummyDynalistServer } from "../dummy-server";
import { createCodeVerifier, s256CodeChallenge } from "../../worker/pkce";

export const BASE_URL = "https://dynalist-mcp.example.workers.dev";
export const MCP_URL = `${BASE_URL}/mcp`;
export const CLIENT_REDIRECT_URI = "https://client.example/callback";
export const ALLOWED_LOGIN = "allowed-owner";

const DYNALIST_TEST_ORIGIN = "https://dynalist.test";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * Stand-in for GitHub's OAuth and user APIs. `login` is the account the
 * next sign-in resolves to.
 */
export class GithubStub {
  login = ALLOWED_LOGIN;
  tokenExchanges = 0;
}

/**
 * Records Dynalist API calls by endpoint so tests can assert on them.
 */
export class DynalistCallLog {
  calls: string[] = [];

  count(endpoint: string): number {
    return this.calls.filter((call) => call === endpoint).length;
  }
}

/**
 * Route outbound fetches from the Worker to the dummy Dynalist server
 * and the GitHub stub. Any other URL fails the test loudly.
 */
export function installOutboundStubs(
  dynalist: DummyDynalistServer,
  github: GithubStub,
  callLog: DynalistCallLog = new DynalistCallLog(),
): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);

    if (url.origin === DYNALIST_TEST_ORIGIN) {
      const endpoint = url.pathname.replace(/^\/api\/v1/, "");
      callLog.calls.push(endpoint);
      const body = await request.json() as Record<string, unknown>;
      return dynalist.handleHttpRequest(endpoint, body);
    }
    if (url.href === GITHUB_TOKEN_URL) {
      github.tokenExchanges++;
      return Response.json({ access_token: "github-test-token", token_type: "bearer", scope: "read:user" });
    }
    if (url.href === GITHUB_USER_URL) {
      return Response.json({ login: github.login });
    }
    throw new Error(`Unexpected outbound fetch in Worker test: ${request.url}`);
  });
}

/**
 * Minimal cookie jar for the browser side of the OAuth flow.
 */
class CookieJar {
  private cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/max-age=0/i.test(header) || value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export type OAuthOutcome =
  | { kind: "token"; accessToken: string }
  | { kind: "rejected"; status: number; body: string };

/**
 * Run the full authorization code flow as an MCP client and browser
 * would: dynamic registration, consent approval, the GitHub round trip,
 * and the token exchange.
 */
export async function runOAuthFlow(): Promise<OAuthOutcome> {
  const registration = await SELF.fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [CLIENT_REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!registration.ok) throw new Error(`Registration failed: ${registration.status} ${await registration.text()}`);
  const { client_id: clientId } = await registration.json() as { client_id: string };

  const verifier = createCodeVerifier();
  const challenge = await s256CodeChallenge(verifier);
  const jar = new CookieJar();
  const authorizeUrl = new URL(`${BASE_URL}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", CLIENT_REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "client-state");
  authorizeUrl.searchParams.set("resource", env.MCP_RESOURCE);

  const consentPage = await SELF.fetch(authorizeUrl.toString());
  if (consentPage.status !== 200) throw new Error(`Consent page failed: ${consentPage.status} ${await consentPage.text()}`);
  jar.store(consentPage);
  const html = await consentPage.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error("Consent page has no handle.");

  const approval = await SELF.fetch(authorizeUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": jar.header() },
    body: new URLSearchParams({ handle: decodeHtml(handle), decision: "approve" }).toString(),
    redirect: "manual",
  });
  if (approval.status !== 302) throw new Error(`Approval failed: ${approval.status} ${await approval.text()}`);
  jar.store(approval);
  const githubRedirect = new URL(approval.headers.get("Location")!);
  const state = githubRedirect.searchParams.get("state")!;

  const callback = await SELF.fetch(`${BASE_URL}/callback?code=github-code&state=${encodeURIComponent(state)}`, {
    headers: { "Cookie": jar.header() },
    redirect: "manual",
  });
  if (callback.status !== 302) {
    return { kind: "rejected", status: callback.status, body: await callback.text() };
  }
  const clientRedirect = new URL(callback.headers.get("Location")!);
  const code = clientRedirect.searchParams.get("code");
  if (!code) throw new Error(`Callback redirect has no code: ${clientRedirect.toString()}`);

  const token = await SELF.fetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: env.MCP_RESOURCE,
    }).toString(),
  });
  if (!token.ok) throw new Error(`Token exchange failed: ${token.status} ${await token.text()}`);
  const { access_token: accessToken } = await token.json() as { access_token: string };
  return { kind: "token", accessToken };
}

function decodeHtml(value: string): string {
  return value.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/**
 * Complete the OAuth flow and return the access token, failing if the
 * sign-in was rejected.
 */
export async function authorize(): Promise<string> {
  const outcome = await runOAuthFlow();
  if (outcome.kind !== "token") throw new Error(`Sign-in rejected: ${outcome.status} ${outcome.body}`);
  return outcome.accessToken;
}

/**
 * Connect an MCP client to the Worker over Streamable HTTP. Each tool
 * call is a separate HTTP request into the Durable Object.
 */
export async function connectMcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => SELF.fetch(withHostHeader(new Request(input as RequestInfo, init))),
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "worker-test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * Add the Host header that real traffic always carries. SELF.fetch does
 * not set it, and the MCP handler rejects requests without one.
 */
function withHostHeader(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("Host", new URL(request.url).host);
  return new Request(request, { headers });
}

/**
 * Build a POST of one raw JSON-RPC message to /mcp.
 */
export function mcpRequest(body: unknown, accessToken?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return withHostHeader(new Request(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) }));
}

/**
 * POST one raw JSON-RPC message to /mcp through the Worker.
 */
export function postMcp(body: unknown, accessToken?: string): Promise<Response> {
  return SELF.fetch(mcpRequest(body, accessToken));
}

/**
 * The single Durable Object instance the Worker forwards to.
 */
export function mcpObjectStub() {
  return env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName("default"));
}

/**
 * Wipe the Durable Object's storage and memory so state from an earlier
 * test (batch state, caches) cannot leak into this one.
 */
export async function resetDurableObject(): Promise<void> {
  const stub = mcpObjectStub();
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(stub);
}
