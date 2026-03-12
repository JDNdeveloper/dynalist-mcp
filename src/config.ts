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
  path: z.string().refine((p) => p.startsWith("/"), { message: "Access rule path must start with '/'" }),
  policy: z.enum(["allow", "read", "deny"]),
  id: z.string().optional(),
});

const AccessSchema = z.object({
  default: z.enum(["allow", "read", "deny"]).default("allow"),
  rules: z.array(AccessRuleSchema).default([]).refine(
    (rules) => {
      const paths = rules.map((r) => r.path);
      return new Set(paths).size === paths.length;
    },
    { message: "Duplicate path entries in access rules." },
  ),
});

const ReadDefaultsSchema = z.object({
  maxDepth: z.number().nullable().default(5),
  includeCollapsedChildren: z.boolean().default(false),
  includeNotes: z.boolean().default(true),
  includeChecked: z.boolean().default(true),
});

const SizeWarningSchema = z.object({
  warningTokenThreshold: z.number().default(5000),
  maxTokenThreshold: z.number().default(24500),
});

const InboxSchema = z.object({
  defaultCheckbox: z.boolean().default(false),
});

const CacheSchema = z.object({
  ttlSeconds: z.number().default(300),
});

const ConfigSchema = z.object({
  access: AccessSchema.optional(),
  readDefaults: ReadDefaultsSchema.default({}),
  sizeWarning: SizeWarningSchema.default({}),
  inbox: InboxSchema.default({}),
  readOnly: z.boolean().default(false),
  cache: CacheSchema.default({}),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn"),
  logFile: z.string().optional(),
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

function getConfigPath(): string {
  return process.env.DYNALIST_MCP_CONFIG ?? join(homedir(), ".dynalist-mcp.json");
}

/**
 * Load the config, checking mtime for changes. Throws ConfigError if the
 * file exists but is invalid (fail-closed). Called on every tool invocation.
 */
export function getConfig(): Config {
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
