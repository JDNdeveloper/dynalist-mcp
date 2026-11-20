/**
 * Config loader for Cloudflare Workers. Parses DYNALIST_MCP_CONFIG_JSON
 * once and never reloads. Updating the secret deploys a new Worker
 * version, which restarts the Durable Object with the new config.
 *
 * This module imports nothing Workers-specific so the Bun tests can load it.
 */

import { ConfigError, DEFAULT_CONFIG, getConfig, setConfigLoader, type Config, type ConfigLoader } from "../config";
import { parseWorkerConfig } from "./env-validation";

/**
 * Create a loader from the raw config JSON (or undefined for defaults).
 * An invalid value makes every load() throw the same ConfigError, so the
 * server fails closed.
 */
export function createEnvConfigLoader(raw: string | undefined): ConfigLoader {
  let config: Config | undefined;
  let error: unknown;
  try {
    config = raw === undefined || raw === "" ? DEFAULT_CONFIG : parseWorkerConfig(raw);
  } catch (err) {
    error = err;
  }

  return {
    load(): Config {
      if (config === undefined) throw error;
      return config;
    },
  };
}

/**
 * Install the env loader and load it once, so log() uses the configured
 * logLevel from the start rather than only after the first tool call.
 * An invalid value is left for getConfig() callers to surface.
 */
export function installEnvConfigLoader(raw: string | undefined): void {
  setConfigLoader(createEnvConfigLoader(raw));
  try {
    getConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }
}
