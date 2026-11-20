/**
 * Config loader for ~/.dynalist-mcp.json (or DYNALIST_MCP_CONFIG), used
 * by the stdio server. Reloads on mtime change, fail-closed on invalid
 * config, and appends log lines to logFile when set.
 */

import { statSync, readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  ConfigError,
  DEFAULT_CONFIG,
  HOT_RELOAD_KEYS,
  log,
  notifyConfigChanged,
  parseConfig,
  type Config,
  type ConfigLoader,
} from "./config";

const REMEDY = "Fix the file or remove it to use defaults.";

function getConfigPath(): string {
  return process.env.DYNALIST_MCP_CONFIG ?? join(homedir(), ".dynalist-mcp.json");
}

/**
 * Create a loader that reads the config file, checking its mtime on
 * every load. After the first successful load, only hot-reloadable
 * fields are updated; startup-only fields stay frozen.
 */
export function createFileConfigLoader(): ConfigLoader {
  let cachedConfig: Config = DEFAULT_CONFIG;
  let cachedMtimeMs: number | null = null;
  // Tracks whether the config file existed on last check.
  let fileExisted = false;
  // True after the first successful config load. Once set, subsequent
  // reloads only propagate hot-reloadable fields.
  let initialLoadDone = false;

  return {
    load(): Config {
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
          notifyConfigChanged(cachedConfig);
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
          `Config file is unreadable: ${err instanceof Error ? err.message : String(err)}. ${REMEDY}`
        );
      }

      const parsed = parseConfig(raw, "Config file", REMEDY);

      if (initialLoadDone) {
        // Subsequent reload: only propagate hot-reloadable fields.
        for (const key of HOT_RELOAD_KEYS) {
          (cachedConfig as Record<string, unknown>)[key] = (parsed as Record<string, unknown>)[key];
        }
      } else {
        // Initial load: set all fields.
        cachedConfig = parsed;
        initialLoadDone = true;
      }
      cachedMtimeMs = mtimeMs;
      fileExisted = true;
      notifyConfigChanged(cachedConfig);
      log("info", "Config file loaded.");
      return cachedConfig;
    },

    reset(): void {
      cachedConfig = DEFAULT_CONFIG;
      cachedMtimeMs = null;
      fileExisted = false;
      initialLoadDone = false;
    },

    writeLog(config: Config, line: string): void {
      if (!config.logFile) return;
      try {
        appendFileSync(config.logFile, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Silently ignore write failures to avoid recursive error loops.
      }
    },
  };
}
