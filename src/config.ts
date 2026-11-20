/**
 * Platform-agnostic configuration core: the Zod schema, parsing, the
 * active config, and logging. Where config comes from is decided by an
 * installed ConfigLoader (a file on stdio, an environment secret on
 * Cloudflare Workers). This module imports no Node modules so it runs on
 * both platforms.
 */

import { z } from "zod";

// ─── Zod schemas ───────────────────────────────────────────────────────

const AccessRuleSchema = z.object({
  path: z.string()
    .transform((p) => (p === "*" || p === "**") ? `/${p}` : p)
    .refine((p) => p.startsWith("/"), { message: "Access rule path must start with '/'" })
    .transform((p) => p.normalize("NFC")),
  policy: z.enum(["allow", "read", "deny"]),
  id: z.string().optional(),
}).strict();

const AccessSchema = z.object({
  default: z.enum(["allow", "read", "deny"]).default("allow")
    .describe("Default policy for files not matched by any rule"),
  rules: z.array(AccessRuleSchema).default([])
    .describe("Access control rules (see [Access control](access-control.md))")
    .refine(
      (rules) => {
        const paths = rules.map((r) => r.path);
        return new Set(paths).size === paths.length;
      },
      { message: "Duplicate path entries in access rules." },
    ),
}).strict();

const ReadDefaultsSchema = z.object({
  maxDepth: z.number().nullable().default(3)
    .describe("Default max depth for `read_document`. `null` = unlimited"),
  includeCollapsedChildren: z.boolean().default(false)
    .describe("Default for including collapsed items' children"),
  includeNotes: z.boolean().default(true)
    .describe("Default for including item notes in responses"),
  includeChecked: z.boolean().default(true)
    .describe("Default for including checked/completed items"),
}).strict();

const SizeWarningSchema = z.object({
  warningTokenThreshold: z.number().default(5000)
    .describe("Token count that triggers a size warning"),
  maxTokenThreshold: z.number().default(24500)
    .describe("Token count above which results are blocked entirely"),
}).strict();

const CacheSchema = z.object({
  ttlSeconds: z.number().default(300)
    .describe("File tree cache TTL in seconds"),
}).strict();

// Exported for codegen introspection by scripts/generate-docs.ts.
export const ConfigSchema = z.object({
  access: AccessSchema.optional(),
  readDefaults: ReadDefaultsSchema.prefault({}),
  sizeWarning: SizeWarningSchema.prefault({}),
  cache: CacheSchema.prefault({}),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn")
    .describe("Log verbosity"),
  logFile: z.string().optional()
    .describe("File path to write logs to (in addition to stderr)"),
}).strict();

export type AccessRule = z.infer<typeof AccessRuleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// ─── Hot-reload split ────────────────────────────────────────────────
// Only these fields are updated when the config file changes after
// startup. All other fields are frozen at init and baked into schemas.

export const HOT_RELOAD_KEYS = ["access", "logLevel", "logFile"] as const;
type HotReloadKey = (typeof HOT_RELOAD_KEYS)[number];

// Startup-only config fields (everything not hot-reloadable). The type
// excludes hot-reloadable fields so callers cannot accidentally use a
// hot-reloadable value as a schema default.
export type StartupConfig = Omit<Config, HotReloadKey>;

// ─── ConfigError ───────────────────────────────────────────────────────

/**
 * Thrown when the config exists but fails validation. Caught by
 * wrapToolHandler and returned as a structured MCP error.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/**
 * Parse and validate raw config JSON. Throws ConfigError naming the
 * source (e.g. "Config file") and ending with the remedy, so each
 * platform can tell the operator how to fix its own config source.
 */
export function parseConfig(
  raw: string,
  source: string = "Config",
  remedy: string = "Fix the config or remove it to use defaults.",
): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `${source} is invalid JSON: ${err instanceof Error ? err.message : String(err)}. ${remedy}`
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`${source} is invalid: ${details}. ${remedy}`);
  }
  return result.data;
}

// ─── Loader hook ──────────────────────────────────────────────────────

/**
 * Supplies the active config. load() runs on every getConfig() call, so
 * it must be cheap when nothing changed, and it throws ConfigError on
 * invalid config (fail-closed). A loader calls notifyConfigChanged()
 * whenever the config it returns changes.
 */
export interface ConfigLoader {
  load(): Config;
  /** Reset internal state for test isolation. */
  reset?(): void;
  /** Append a formatted log line to an extra sink (e.g. logFile). */
  writeLog?(config: Config, line: string): void;
}

// Without an installed loader, the defaults apply.
const defaultLoader: ConfigLoader = { load: () => DEFAULT_CONFIG };

let loader: ConfigLoader = defaultLoader;
// The config most recently returned by the loader. log() reads it
// directly so logging never triggers a reload.
let activeConfig: Config = DEFAULT_CONFIG;
// Incremented whenever the loader reports a change.
let configVersion = 0;

/**
 * Install the loader that supplies config. Entry points call this once
 * before registering tools.
 */
export function setConfigLoader(next: ConfigLoader): void {
  loader = next;
  activeConfig = DEFAULT_CONFIG;
}

/**
 * Record that the loader's config changed and make it active, so log()
 * immediately uses the new logLevel. Loaders call this on every
 * successful load or reload.
 */
export function notifyConfigChanged(config: Config): void {
  activeConfig = config;
  configVersion++;
}

export function getConfigVersion(): number {
  return configVersion;
}

// ─── Test injection ───────────────────────────────────────────────────

let injectedConfig: Config | null = null;

/**
 * Inject a config for testing. When set, getConfig() returns it
 * directly without consulting the loader. Pass null to clear and fully
 * reset the loader's state for test isolation.
 */
export function setTestConfig(config: Config | null): void {
  injectedConfig = config;
  if (config === null) {
    loader.reset?.();
    activeConfig = DEFAULT_CONFIG;
  }
  configVersion++;
}

/**
 * Return the active config from the installed loader. Throws ConfigError
 * if the config is invalid (fail-closed). Called on every tool invocation.
 */
export function getConfig(): Config {
  if (injectedConfig !== null) return injectedConfig;
  activeConfig = loader.load();
  return activeConfig;
}

/**
 * Return startup-only config fields (readDefaults, sizeWarning, cache).
 * Call before tool registration to bake values into Zod schema
 * `.default()` calls. The return type excludes hot-reloadable fields
 * to prevent accidental use as schema defaults.
 */
export function getStartupConfig(): StartupConfig {
  const config = getConfig();
  return {
    readDefaults: config.readDefaults,
    sizeWarning: config.sizeWarning,
    cache: config.cache,
  };
}

// ─── Logger ────────────────────────────────────────────────────────────

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Writes one formatted log line. The default sink sends every level to
 * stderr, since stdout is reserved for the MCP protocol on stdio.
 */
export type LogSink = (level: LogLevel, line: string) => void;

let logSink: LogSink = (_level, line) => console.error(line);

/**
 * Replace the log sink. Cloudflare Workers maps each level to the
 * matching console method so Workers Logs can filter by level.
 */
export function setLogSink(sink: LogSink): void {
  logSink = sink;
}

/**
 * Log through the active sink and the loader's extra sink (if any).
 * Respects the configured logLevel.
 */
export function log(level: LogLevel, message: string): void {
  const threshold = LOG_LEVELS[activeConfig.logLevel];
  if (LOG_LEVELS[level] <= threshold) {
    const line = `[dynalist-mcp] [${level}] ${message}`;
    logSink(level, line);
    loader.writeLog?.(activeConfig, line);
  }
}

// ─── Documentation metadata ─────────────────────────────────────────
// Exported for codegen by scripts/generate-docs.ts.

export const ENV_VARS = [
  { name: "DYNALIST_API_TOKEN", required: true, description: "Your Dynalist API token from [dynalist.io/developer](https://dynalist.io/developer)" },
  { name: "DYNALIST_MCP_CONFIG", required: false, description: "Override the config file path (default: `~/.dynalist-mcp.json`)" },
] as const;

// Secrets and variables for the Cloudflare Worker.
export const WORKER_ENV_VARS = [
  { name: "DYNALIST_API_TOKEN", kind: "Secret", required: true, description: "Your Dynalist API token from [dynalist.io/developer](https://dynalist.io/developer)" },
  { name: "GITHUB_CLIENT_ID", kind: "Secret", required: true, description: "Client ID of the GitHub OAuth app used for sign-in" },
  { name: "GITHUB_CLIENT_SECRET", kind: "Secret", required: true, description: "Client secret of the GitHub OAuth app (40 lowercase hex characters)" },
  { name: "ALLOWED_GITHUB_USERS", kind: "Secret", required: true, description: "Comma-separated GitHub usernames allowed to sign in. Case-insensitive. Removing a username revokes its existing grants" },
  { name: "DYNALIST_MCP_CONFIG_JSON", kind: "Secret", required: false, description: "Config as JSON, using the same schema as the config file below. `logFile` is rejected. Update it with `bun run worker-config`" },
  { name: "MCP_RESOURCE", kind: "Variable", required: true, description: "Public MCP URL (e.g. `https://dynalist-mcp.<subdomain>.workers.dev/mcp`). Must match the connector URL exactly" },
  { name: "DYNALIST_API_BASE", kind: "Variable", required: false, description: "Testing only. Overrides the Dynalist API base URL" },
] as const;

export const LOG_LEVEL_DESCRIPTIONS: Record<string, string> = {
  error: "failures only",
  warn: "includes rate limit retries and access rule warnings",
  info: "batch progress, config reloads",
  debug: "full request/response details",
};

export const CONFIG_FILE_DESCRIPTION =
  "Optional. Located at `~/.dynalist-mcp.json` by default (override with `DYNALIST_MCP_CONFIG`). " +
  "All fields are optional with sensible defaults. Validated with Zod on load. " +
  "Only `access`, `logLevel`, and `logFile` are hot-reloaded on file changes; " +
  "all other settings are read once at startup. Invalid config fails closed " +
  "(all tools error until fixed or removed).";

export const LOGGING_DESCRIPTION =
  "All log output goes to stderr (stdout is reserved for MCP protocol).";

export const LOG_FILE_HINT =
  "Set `logFile` to redirect logs to a file, useful for debugging since stderr " +
  "from MCP subprocesses is not always visible.";
