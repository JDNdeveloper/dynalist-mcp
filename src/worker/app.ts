/**
 * Worker request handling. One Worker is both the OAuth authorization
 * server (GitHub sign-in with an owner allowlist) and the MCP resource
 * server. Authenticated /mcp requests are forwarded to the single
 * DynalistMcpDurableObject.
 */

import { OAuthProvider, getOAuthApi, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { log, setLogSink } from "../config";
import { runWithAuditContext } from "./audit-log";
import { installEnvConfigLoader } from "./env-config-loader";
import { isAllowedGithubUser, parseAllowedGithubUsers, validateEnv } from "./env-validation";
import { handleAuthorizationRoutes } from "./github-handler";
import {
  MISCONFIGURED_MESSAGE,
  NOT_ALLOWED_MESSAGE,
  PLATFORM_FAILURE_MESSAGE,
  jsonRpcErrorResponse,
  readJsonRpcId,
} from "./json-rpc";
import { workersLogSink } from "./log-sink";
import type { Env, GrantProps } from "./env";

const MCP_ROUTE = "/mcp";

setLogSink(workersLogSink);

/**
 * Whether a Durable Object response came from the MCP handler rather
 * than from the platform (an uncaught exception, a limit kill, or a
 * reset during deploy).
 */
function isMcpResponse(response: Response): boolean {
  if (response.status < 500) return true;
  const contentType = response.headers.get("Content-Type") ?? "";
  return contentType.includes("application/json") || contentType.includes("text/event-stream");
}

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Re-check the allowlist on every request, so removing a username and
    // updating the secret revokes that account's existing grants.
    const id = await readJsonRpcId(request);
    const props = ctx.props as GrantProps | undefined;
    const allowlist = parseAllowedGithubUsers(env.ALLOWED_GITHUB_USERS);
    if (!props?.login || !allowlist.ok || !isAllowedGithubUser(props.login, allowlist.value)) {
      return jsonRpcErrorResponse(id, NOT_ALLOWED_MESSAGE, 403);
    }

    try {
      const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName("default"));
      const response = await stub.fetch(request);
      if (isMcpResponse(response)) return response;
      log("error", `Durable Object returned HTTP ${response.status} outside the MCP handler.`);
    } catch (error) {
      log("error", `Durable Object request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return jsonRpcErrorResponse(id, PLATFORM_FAILURE_MESSAGE, 500);
  },
};

// The OAuth provider depends on MCP_RESOURCE, so it is built on first
// use and rebuilt only if that value changes.
let cachedProvider: { resource: string; provider: OAuthProvider<Env> } | null = null;

function getProvider(env: Env): OAuthProvider<Env> {
  if (cachedProvider?.resource === env.MCP_RESOURCE) return cachedProvider.provider;

  const options: OAuthProviderOptions<Env> = {
    apiRoute: MCP_ROUTE,
    apiHandler: mcpApiHandler,
    defaultHandler: {
      // The authorization pages need the provider's helpers, which are
      // derived from these same options.
      fetch: (request, environment) => handleAuthorizationRoutes(request, environment, getOAuthApi(options, environment)),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: env.MCP_RESOURCE,
      resource_name: "Dynalist MCP",
    },
  };
  const provider = new OAuthProvider<Env>(options);
  cachedProvider = { resource: env.MCP_RESOURCE, provider };
  return provider;
}

// Env validation runs once per isolate. Changing a secret deploys a new
// Worker version, which starts new isolates.
let envValid: boolean | null = null;

function checkEnv(env: Env): boolean {
  if (envValid !== null) return envValid;
  const failures = validateEnv(env);
  for (const failure of failures) {
    // Names the field and rule, never the value.
    log("error", `Invalid Worker environment: ${failure.name} ${failure.rule}.`);
  }
  envValid = failures.length === 0;
  // The Worker isolate may differ from the Durable Object's, so it loads
  // config too, for its own logLevel.
  if (envValid) installEnvConfigLoader(env.DYNALIST_MCP_CONFIG_JSON);
  return envValid;
}

async function misconfiguredResponse(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === MCP_ROUTE) {
    return jsonRpcErrorResponse(await readJsonRpcId(request), MISCONFIGURED_MESSAGE, 503);
  }
  return new Response(MISCONFIGURED_MESSAGE, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * Serve one request. Every route is refused while the environment is
 * invalid.
 */
export async function handleWorkerRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return runWithAuditContext(env, ctx, async () => {
    if (!checkEnv(env)) return misconfiguredResponse(request);
    return getProvider(env).fetch(request, env, ctx);
  });
}

/**
 * Reset per-isolate memoization. Tests only: each test may run with a
 * different environment in the same isolate.
 */
export function resetWorkerStateForTests(): void {
  envValid = null;
  cachedProvider = null;
}
