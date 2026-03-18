/**
 * Configuration loader for ~/.dynalist-mcp.json (or DYNALIST_MCP_CONFIG).
 * Validates with Zod, reloads on mtime change, fail-closed on invalid config.
 */

import { statSync, readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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
    .describe("Default for including collapsed nodes' children"),
  includeNotes: z.boolean().default(true)
    .describe("Default for including node notes in responses"),
  includeChecked: z.boolean().default(true)
    .describe("Default for including checked/completed nodes"),
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
  readDefaults: ReadDefaultsSchema.default({}),
  sizeWarning: SizeWarningSchema.default({}),
  cache: CacheSchema.default({}),
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

const HOT_RELOAD_KEYS = ["access", "logLevel", "logFile"] as const;
type HotReloadKey = (typeof HOT_RELOAD_KEYS)[number];

// Startup-only config fields (everything not hot-reloadable). The type
// excludes hot-reloadable fields so callers cannot accidentally use a
// hot-reloadable value as a schema default.
export type StartupConfig = Omit<Config, HotReloadKey>;

// ─── ConfigError ───────────────────────────────────────────────────────

/**
 * Thrown when the config file exists but fails validation. Caught by
 * wrapToolHandler and returned as a structured MCP error.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ─── Default config (no file) ──────────────────────────────────────────

const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

// ─── Mtime-based loader ───────────────────────────────────────────────

let cachedConfig: Config = DEFAULT_CONFIG;
let cachedMtimeMs: number | null = null;
// Tracks whether the config file existed on last check.
let fileExisted = false;
// True after the first successful config load. Once set, subsequent
// reloads only propagate hot-reloadable fields.
let initialLoadDone = false;
// Incremented on every successful config reload. Consumers (e.g.
// AccessController) compare against this to detect config changes.
let configVersion = 0;

export function getConfigVersion(): number {
  return configVersion;
}

// ─── Test injection ───────────────────────────────────────────────────

let injectedConfig: Config | null = null;

/**
 * Inject a config for testing. When set, getConfig() returns it
 * directly without reading any file. Pass null to clear and fully
 * reset internal state for test isolation.
 */
export function setTestConfig(config: Config | null): void {
  injectedConfig = config;
  if (config === null) {
    // Reset all file-based state for test isolation.
    cachedConfig = DEFAULT_CONFIG;
    cachedMtimeMs = null;
    fileExisted = false;
    initialLoadDone = false;
  }
  configVersion++;
}

function getConfigPath(): string {
  return process.env.DYNALIST_MCP_CONFIG ?? join(homedir(), ".dynalist-mcp.json");
}

/**
 * Load the config, checking mtime for changes. Throws ConfigError if the
 * file exists but is invalid (fail-closed). Called on every tool invocation.
 */
export function getConfig(): Config {
  if (injectedConfig !== null) return injectedConfig;
  const configPath = getConfigPath();

  let mtimeMs: number | null = null;
  let exists = false;
  try {
    const stat = statSync(configPath);
    mtimeMs = stat.mtimeMs;
    exists = true;
  } catch {
    // File does not exist.
  }

  if (!exists) {
    if (fileExisted) {
      // File was deleted. Only revert hot-reloadable fields to defaults;
      // startup-only fields stay frozen from initial load.
      for (const key of HOT_RELOAD_KEYS) {
        (cachedConfig as Record<string, unknown>)[key] = (DEFAULT_CONFIG as Record<string, unknown>)[key];
      }
      cachedMtimeMs = null;
      fileExisted = false;
      configVersion++;
      log("info", "Config file removed, reverting hot-reloadable settings to defaults.");
    }
    return cachedConfig;
  }

  // File exists. Check if mtime changed.
  if (fileExisted && mtimeMs === cachedMtimeMs) {
    return cachedConfig;
  }

  // Load and validate.
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new ConfigError(
      `Config file is unreadable: ${err instanceof Error ? err.message : String(err)}. ` +
      `Fix the file or remove it to use defaults.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `Config file is invalid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      `Fix the file or remove it to use defaults.`
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(
      `Config file is invalid: ${details}. Fix the file or remove it to use defaults.`
    );
  }

  if (initialLoadDone) {
    // Subsequent reload: only propagate hot-reloadable fields.
    for (const key of HOT_RELOAD_KEYS) {
      (cachedConfig as Record<string, unknown>)[key] = (result.data as Record<string, unknown>)[key];
    }
  } else {
    // Initial load: set all fields.
    cachedConfig = result.data;
    initialLoadDone = true;
  }
  cachedMtimeMs = mtimeMs;
  fileExisted = true;
  configVersion++;
  log("info", "Config file loaded.");
  return cachedConfig;
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

/**
 * Log to stderr (stdout is reserved for MCP protocol) and optionally to
 * a file. Respects the configured logLevel.
 */
export function log(level: keyof typeof LOG_LEVELS, message: string): void {
  const threshold = LOG_LEVELS[cachedConfig.logLevel];
  if (LOG_LEVELS[level] <= threshold) {
    const line = `[dynalist-mcp] [${level}] ${message}`;
    console.error(line);
    if (cachedConfig.logFile) {
      try {
        appendFileSync(cachedConfig.logFile, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Silently ignore write failures to avoid recursive error loops.
      }
    }
  }
}

// ─── Documentation metadata ─────────────────────────────────────────
// Exported for codegen by scripts/generate-docs.ts.

export const ENV_VARS = [
  { name: "DYNALIST_API_TOKEN", required: true, description: "Your Dynalist API token from [dynalist.io/developer](https://dynalist.io/developer)" },
  { name: "DYNALIST_MCP_CONFIG", required: false, description: "Override the config file path (default: `~/.dynalist-mcp.json`)" },
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
