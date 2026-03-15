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
});

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
});

const ReadDefaultsSchema = z.object({
  maxDepth: z.number().nullable().default(3)
    .describe("Default max depth for `read_document`. `null` = unlimited"),
  includeCollapsedChildren: z.boolean().default(false)
    .describe("Default for including collapsed nodes' children"),
  includeNotes: z.boolean().default(true)
    .describe("Default for including node notes in responses"),
  includeChecked: z.boolean().default(true)
    .describe("Default for including checked/completed nodes"),
});

const SizeWarningSchema = z.object({
  warningTokenThreshold: z.number().default(5000)
    .describe("Token count that triggers a size warning"),
  maxTokenThreshold: z.number().default(24500)
    .describe("Token count above which results are blocked entirely"),
});

const CacheSchema = z.object({
  ttlSeconds: z.number().default(300)
    .describe("File tree cache TTL in seconds"),
});

// Exported for codegen introspection by scripts/generate-docs.ts.
export const ConfigSchema = z.object({
  access: AccessSchema.optional(),
  readDefaults: ReadDefaultsSchema.default({}),
  sizeWarning: SizeWarningSchema.default({}),
  readOnly: z.boolean().default(false)
    .describe("Reject all write operations when true"),
  cache: CacheSchema.default({}),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn")
    .describe("Log verbosity"),
  logFile: z.string().optional()
    .describe("File path to write logs to (in addition to stderr)"),
});

export type AccessRule = z.infer<typeof AccessRuleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

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
 * directly without reading any file. Pass null to clear.
 */
export function setTestConfig(config: Config | null): void {
  injectedConfig = config;
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
      // File was deleted since last load. Revert to defaults.
      cachedConfig = DEFAULT_CONFIG;
      cachedMtimeMs = null;
      fileExisted = false;
      configVersion++;
      log("info", "Config file removed, reverting to defaults.");
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

  cachedConfig = result.data;
  cachedMtimeMs = mtimeMs;
  fileExisted = true;
  configVersion++;
  log("info", "Config file loaded.");
  return cachedConfig;
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
  "All fields are optional with sensible defaults. Validated with Zod on load. Automatically " +
  "reloaded when the file is modified (mtime-based check on every tool call). Invalid config " +
  "fails closed (all tools error until fixed or removed).";

export const LOGGING_DESCRIPTION =
  "All log output goes to stderr (stdout is reserved for MCP protocol).";

export const LOG_FILE_HINT =
  "Set `logFile` to redirect logs to a file, useful for debugging since stderr " +
  "from MCP subprocesses is not always visible.";
