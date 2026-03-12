/**
 * Configuration loader for ~/.dynalist-mcp.json.
 * Provides user-configurable defaults for tool parameters.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface ReadDefaults {
  maxDepth: number | null;
  includeNotes: boolean;
  includeChecked: boolean;
}

export interface Config {
  readDefaults: ReadDefaults;
}

const DEFAULT_CONFIG: Config = {
  readDefaults: {
    maxDepth: 5,
    includeNotes: true,
    includeChecked: true,
  },
};

let cachedConfig: Config | null = null;

/**
 * Load and cache configuration from ~/.dynalist-mcp.json.
 * Falls back to defaults if the file doesn't exist or is malformed.
 */
export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  try {
    const configPath = join(homedir(), ".dynalist-mcp.json");
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    cachedConfig = {
      readDefaults: {
        ...DEFAULT_CONFIG.readDefaults,
        ...(parsed.readDefaults ?? {}),
      },
    };
  } catch {
    cachedConfig = DEFAULT_CONFIG;
  }

  return cachedConfig;
}
