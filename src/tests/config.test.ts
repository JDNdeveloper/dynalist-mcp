import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getConfig, ConfigError } from "../config";

// ─── Test helpers ────────────────────────────────────────────────────

const TEST_CONFIG_PATH = join(tmpdir(), `dynalist-mcp-test-config-${process.pid}.json`);

// Monotonically increasing fake mtime to guarantee the config module
// sees a different mtime on each write (avoids same-second caching).
let fakeMtime = Date.now();

function setConfigEnv() {
  process.env.DYNALIST_MCP_CONFIG = TEST_CONFIG_PATH;
}

function writeTestConfig(data: unknown) {
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(data));
  // Force a distinct mtime so the config module detects the change.
  fakeMtime += 2000;
  const secs = fakeMtime / 1000;
  utimesSync(TEST_CONFIG_PATH, secs, secs);
}

function cleanupConfig() {
  if (existsSync(TEST_CONFIG_PATH)) {
    unlinkSync(TEST_CONFIG_PATH);
  }
  // Call getConfig() so the module detects the file was deleted and
  // resets its internal fileExisted flag. This ensures a clean slate
  // for the next test.
  try {
    getConfig();
  } catch {
    // Ignore errors from stale state.
  }
}

describe("config loading", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("missing file returns defaults", () => {
    // Config file does not exist.
    const config = getConfig();
    expect(config.readDefaults.maxDepth).toBe(5);
    expect(config.readDefaults.includeCollapsedChildren).toBe(false);
    expect(config.readDefaults.includeNotes).toBe(true);
    expect(config.readDefaults.includeChecked).toBe(true);
    expect(config.sizeWarning.warningTokenThreshold).toBe(5000);
    expect(config.sizeWarning.maxTokenThreshold).toBe(24500);
    expect(config.inbox.defaultCheckbox).toBe(false);
    expect(config.readOnly).toBe(false);
    expect(config.cache.ttlSeconds).toBe(300);
    expect(config.logLevel).toBe("warn");
  });

  test("partial config fills missing fields with defaults", () => {
    writeTestConfig({ readOnly: true });
    const config = getConfig();
    expect(config.readOnly).toBe(true);
    // Other fields should be defaults.
    expect(config.readDefaults.maxDepth).toBe(5);
    expect(config.logLevel).toBe("warn");
  });

  test("full config is parsed correctly", () => {
    writeTestConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Docs/**", policy: "allow" }],
      },
      readDefaults: {
        maxDepth: 10,
        includeCollapsedChildren: true,
        includeNotes: false,
        includeChecked: false,
      },
      sizeWarning: { warningTokenThreshold: 1000, maxTokenThreshold: 5000 },
      inbox: { defaultCheckbox: true },
      readOnly: true,
      cache: { ttlSeconds: 60 },
      logLevel: "debug",
    });
    const config = getConfig();
    expect(config.access?.default).toBe("deny");
    expect(config.access?.rules).toHaveLength(1);
    expect(config.readDefaults.maxDepth).toBe(10);
    expect(config.readDefaults.includeCollapsedChildren).toBe(true);
    expect(config.readDefaults.includeNotes).toBe(false);
    expect(config.readDefaults.includeChecked).toBe(false);
    expect(config.sizeWarning.warningTokenThreshold).toBe(1000);
    expect(config.inbox.defaultCheckbox).toBe(true);
    expect(config.readOnly).toBe(true);
    expect(config.cache.ttlSeconds).toBe(60);
    expect(config.logLevel).toBe("debug");
  });

  test("invalid JSON throws ConfigError", () => {
    writeFileSync(TEST_CONFIG_PATH, "not valid json {{{");
    // Force distinct mtime.
    fakeMtime += 2000;
    utimesSync(TEST_CONFIG_PATH, fakeMtime / 1000, fakeMtime / 1000);
    expect(() => getConfig()).toThrow(ConfigError);
  });

  test("invalid logLevel throws ConfigError", () => {
    writeTestConfig({ logLevel: "verbose" });
    expect(() => getConfig()).toThrow(ConfigError);
  });
});
