/**
 * Validators for the Worker's secrets, variables, and bindings. The
 * setup script and the Worker share them, so a value the script accepts
 * is exactly a value the Worker accepts.
 *
 * This module imports nothing Workers-specific so the Bun tests and the
 * setup script can load it.
 */

import { ConfigError, parseConfig, type Config } from "../config";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; rule: string };

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(rule: string): ValidationResult<T> {
  return { ok: false, rule };
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

/**
 * Dynalist API token: non-empty with no whitespace. The token format is
 * undocumented, so the setup script also verifies it against Dynalist.
 */
export function validateDynalistApiToken(value: string | undefined): ValidationResult<string> {
  if (!value) return fail("must not be empty");
  if (hasWhitespace(value)) return fail("must not contain whitespace");
  return ok(value);
}

/**
 * GitHub OAuth app client ID: letters, digits, and dots.
 */
export function validateGithubClientId(value: string | undefined): ValidationResult<string> {
  if (!value) return fail("must not be empty");
  if (!/^[A-Za-z0-9.]+$/.test(value)) return fail("must contain only letters, digits, and dots");
  return ok(value);
}

/**
 * GitHub OAuth app client secret: 40 lowercase hex characters.
 */
export function validateGithubClientSecret(value: string | undefined): ValidationResult<string> {
  if (!value) return fail("must not be empty");
  if (!/^[0-9a-f]{40}$/.test(value)) return fail("must be 40 lowercase hexadecimal characters");
  return ok(value);
}

// GitHub usernames are 1 to 39 alphanumerics or single hyphens, with no
// leading or trailing hyphen.
const GITHUB_USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Comma-separated GitHub usernames. Entries are trimmed and lowercased,
 * since GitHub usernames are case-insensitive. At least one entry is
 * required so an empty allowlist rejects everyone rather than allowing
 * everyone.
 */
export function parseAllowedGithubUsers(value: string | undefined): ValidationResult<string[]> {
  if (!value) return fail("must list at least one GitHub username");
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.every((entry) => entry === "")) return fail("must list at least one GitHub username");
  if (entries.some((entry) => entry === "")) return fail("must not contain empty entries");
  for (const entry of entries) {
    if (!GITHUB_USERNAME_PATTERN.test(entry)) {
      return fail(
        "every entry must be a valid GitHub username (1 to 39 letters, digits, or single hyphens, " +
        "not starting or ending with a hyphen)",
      );
    }
  }
  return ok([...new Set(entries.map((entry) => entry.toLowerCase()))]);
}

/**
 * Whether a GitHub login is on the allowlist. Comparison is
 * case-insensitive.
 */
export function isAllowedGithubUser(login: string, allowlist: string[]): boolean {
  return allowlist.includes(login.toLowerCase());
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Public MCP URL used as the protected resource identifier: an https
 * URL, or http on a loopback host for local development.
 */
export function validateMcpResource(value: string | undefined): ValidationResult<string> {
  if (!value) return fail("must not be empty");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("must be an absolute URL");
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    return fail("must use https (http is allowed only on localhost)");
  }
  if (url.hash || url.search) return fail("must not contain a query or fragment");
  // The Worker serves MCP only at /mcp, and clients require the resource
  // to match the connector URL exactly.
  if (url.pathname !== "/mcp") return fail("must end with the /mcp path");
  return ok(value);
}

/**
 * Optional config JSON. Uses the same schema as the local config file,
 * plus a Workers-only rule: logFile is rejected because Workers has no
 * filesystem.
 */
export function validateConfigJson(value: string | undefined): ValidationResult<Config | undefined> {
  if (value === undefined || value === "") return ok(undefined);
  try {
    return ok(parseWorkerConfig(value));
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message);
    throw err;
  }
}

/**
 * Parse config JSON for the Worker. Throws ConfigError on invalid JSON,
 * schema violations, or a logFile setting.
 */
export function parseWorkerConfig(raw: string): Config {
  const config = parseConfig(
    raw,
    "DYNALIST_MCP_CONFIG_JSON",
    "Fix the file and update it with `bun run worker-config`.",
  );
  if (config.logFile !== undefined) {
    throw new ConfigError("`logFile` is not supported on Cloudflare Workers. Remove it from DYNALIST_MCP_CONFIG_JSON.");
  }
  return config;
}

/**
 * The environment fields validateEnv checks. Bindings are typed loosely
 * so this module does not depend on Workers types.
 */
export interface ValidatableEnv {
  DYNALIST_API_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_USERS?: string;
  DYNALIST_MCP_CONFIG_JSON?: string;
  MCP_RESOURCE?: string;
  OAUTH_KV?: unknown;
  MCP_OBJECT?: unknown;
}

export interface EnvValidationFailure {
  name: string;
  rule: string;
}

/**
 * Check every secret, variable, and binding. Returns one failure per
 * invalid field, naming the field and the rule but never the value.
 */
export function validateEnv(env: ValidatableEnv): EnvValidationFailure[] {
  const failures: EnvValidationFailure[] = [];
  const check = (name: string, result: ValidationResult<unknown>) => {
    if (!result.ok) failures.push({ name, rule: result.rule });
  };

  check("DYNALIST_API_TOKEN", validateDynalistApiToken(env.DYNALIST_API_TOKEN));
  check("GITHUB_CLIENT_ID", validateGithubClientId(env.GITHUB_CLIENT_ID));
  check("GITHUB_CLIENT_SECRET", validateGithubClientSecret(env.GITHUB_CLIENT_SECRET));
  check("ALLOWED_GITHUB_USERS", parseAllowedGithubUsers(env.ALLOWED_GITHUB_USERS));
  check("DYNALIST_MCP_CONFIG_JSON", validateConfigJson(env.DYNALIST_MCP_CONFIG_JSON));
  check("MCP_RESOURCE", validateMcpResource(env.MCP_RESOURCE));
  if (!env.OAUTH_KV) failures.push({ name: "OAUTH_KV", rule: "KV namespace binding is missing" });
  if (!env.MCP_OBJECT) failures.push({ name: "MCP_OBJECT", rule: "Durable Object binding is missing" });

  return failures;
}
