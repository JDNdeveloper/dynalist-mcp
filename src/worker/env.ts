/**
 * Bindings, secrets, and variables available to the Worker and its
 * Durable Object.
 */

import type { DynalistMcpDurableObject } from "./mcp-durable-object";

export interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace<DynalistMcpDurableObject>;
  // The public MCP URL, used as the OAuth protected resource identifier.
  MCP_RESOURCE: string;
  DYNALIST_API_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERS: string;
  DYNALIST_MCP_CONFIG_JSON?: string;
  // Testing only: overrides the Dynalist API base URL.
  DYNALIST_API_BASE?: string;
}

/**
 * Props stored in each OAuth grant. Only the GitHub login is kept, so a
 * leaked grant exposes no GitHub credential.
 */
export interface GrantProps {
  login: string;
}
