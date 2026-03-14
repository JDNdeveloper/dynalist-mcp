import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getConfig, getConfigVersion, ConfigError } from "../config";

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

// ─── 2b. Read defaults ──────────────────────────────────────────────

describe("config read defaults", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("default maxDepth is 5 when readDefaults not specified", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.readDefaults.maxDepth).toBe(5);
  });

  test("custom readDefaults.maxDepth overrides the default", () => {
    writeTestConfig({ readDefaults: { maxDepth: 12 } });
    const config = getConfig();
    expect(config.readDefaults.maxDepth).toBe(12);
  });

  test("readDefaults.maxDepth null means unlimited depth", () => {
    writeTestConfig({ readDefaults: { maxDepth: null } });
    const config = getConfig();
    expect(config.readDefaults.maxDepth).toBeNull();
  });

  test("readDefaults.includeCollapsedChildren defaults to false", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.readDefaults.includeCollapsedChildren).toBe(false);
  });

  test("readDefaults.includeCollapsedChildren true is respected", () => {
    writeTestConfig({ readDefaults: { includeCollapsedChildren: true } });
    const config = getConfig();
    expect(config.readDefaults.includeCollapsedChildren).toBe(true);
  });

  test("readDefaults.includeNotes defaults to true", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.readDefaults.includeNotes).toBe(true);
  });

  test("readDefaults.includeNotes false is respected", () => {
    writeTestConfig({ readDefaults: { includeNotes: false } });
    const config = getConfig();
    expect(config.readDefaults.includeNotes).toBe(false);
  });

  test("readDefaults.includeChecked defaults to true", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.readDefaults.includeChecked).toBe(true);
  });

  test("readDefaults.includeChecked false is respected", () => {
    writeTestConfig({ readDefaults: { includeChecked: false } });
    const config = getConfig();
    expect(config.readDefaults.includeChecked).toBe(false);
  });
});

// ─── 2c. Size warning thresholds ────────────────────────────────────

describe("config size warning thresholds", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("default warningTokenThreshold is 5000", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.sizeWarning.warningTokenThreshold).toBe(5000);
  });

  test("default maxTokenThreshold is 24500", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.sizeWarning.maxTokenThreshold).toBe(24500);
  });

  test("custom thresholds are respected", () => {
    writeTestConfig({
      sizeWarning: { warningTokenThreshold: 2000, maxTokenThreshold: 10000 },
    });
    const config = getConfig();
    expect(config.sizeWarning.warningTokenThreshold).toBe(2000);
    expect(config.sizeWarning.maxTokenThreshold).toBe(10000);
  });

  test("non-numeric warningTokenThreshold is rejected", () => {
    writeTestConfig({ sizeWarning: { warningTokenThreshold: "big" } });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  test("non-numeric maxTokenThreshold is rejected", () => {
    writeTestConfig({ sizeWarning: { maxTokenThreshold: "huge" } });
    expect(() => getConfig()).toThrow(ConfigError);
  });
});

// ─── 2d. Cache settings ──────────────────────────────────────────────

describe("config cache settings", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("default cache.ttlSeconds is 300", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.cache.ttlSeconds).toBe(300);
  });

  test("custom cache.ttlSeconds is respected", () => {
    writeTestConfig({ cache: { ttlSeconds: 120 } });
    const config = getConfig();
    expect(config.cache.ttlSeconds).toBe(120);
  });

  test("cache.ttlSeconds zero is accepted by schema", () => {
    // The Zod schema uses a plain z.number().default(300) with no
    // minimum constraint, so 0 should be accepted.
    writeTestConfig({ cache: { ttlSeconds: 0 } });
    const config = getConfig();
    expect(config.cache.ttlSeconds).toBe(0);
  });

  test("cache.ttlSeconds negative is accepted by schema", () => {
    // Same reasoning as above: no minimum constraint in the schema.
    writeTestConfig({ cache: { ttlSeconds: -1 } });
    const config = getConfig();
    expect(config.cache.ttlSeconds).toBe(-1);
  });
});

// ─── 2f. Global settings ────────────────────────────────────────────

describe("config global settings", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("readOnly defaults to false", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.readOnly).toBe(false);
  });

  test("readOnly true is respected", () => {
    writeTestConfig({ readOnly: true });
    const config = getConfig();
    expect(config.readOnly).toBe(true);
  });

  test("logLevel defaults to warn", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.logLevel).toBe("warn");
  });

  test("all valid logLevel values accepted", () => {
    for (const level of ["error", "warn", "info", "debug"] as const) {
      writeTestConfig({ logLevel: level });
      const config = getConfig();
      expect(config.logLevel).toBe(level);
    }
  });

  test("logFile is optional and accepted as a string", () => {
    writeTestConfig({ logFile: "/tmp/dynalist-mcp.log" });
    const config = getConfig();
    expect(config.logFile).toBe("/tmp/dynalist-mcp.log");
  });

  test("logFile omitted results in undefined", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.logFile).toBeUndefined();
  });
});

// ─── 2g. Access control config ──────────────────────────────────────

describe("config access control", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("access.default defaults to allow when access section present but default missing", () => {
    writeTestConfig({ access: { rules: [] } });
    const config = getConfig();
    expect(config.access?.default).toBe("allow");
  });

  test("access.default accepts allow", () => {
    writeTestConfig({ access: { default: "allow" } });
    const config = getConfig();
    expect(config.access?.default).toBe("allow");
  });

  test("access.default accepts read", () => {
    writeTestConfig({ access: { default: "read" } });
    const config = getConfig();
    expect(config.access?.default).toBe("read");
  });

  test("access.default accepts deny", () => {
    writeTestConfig({ access: { default: "deny" } });
    const config = getConfig();
    expect(config.access?.default).toBe("deny");
  });

  test("access.rules with valid paths accepted", () => {
    writeTestConfig({
      access: {
        rules: [
          { path: "/Documents/**", policy: "allow" },
          { path: "/Private/**", policy: "deny" },
        ],
      },
    });
    const config = getConfig();
    expect(config.access?.rules).toHaveLength(2);
    expect(config.access?.rules[0].path).toBe("/Documents/**");
    expect(config.access?.rules[0].policy).toBe("allow");
    expect(config.access?.rules[1].path).toBe("/Private/**");
    expect(config.access?.rules[1].policy).toBe("deny");
  });

  test("rule path not starting with slash is rejected", () => {
    writeTestConfig({
      access: {
        rules: [{ path: "Documents/**", policy: "allow" }],
      },
    });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  test("duplicate rule paths are rejected", () => {
    writeTestConfig({
      access: {
        rules: [
          { path: "/Docs/**", policy: "allow" },
          { path: "/Docs/**", policy: "deny" },
        ],
      },
    });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  test("rule with id field is accepted", () => {
    writeTestConfig({
      access: {
        rules: [{ path: "/Docs/**", policy: "allow", id: "abc123" }],
      },
    });
    const config = getConfig();
    expect(config.access?.rules[0].id).toBe("abc123");
  });

  test("rule with invalid policy value is rejected", () => {
    writeTestConfig({
      access: {
        rules: [{ path: "/Docs/**", policy: "block" }],
      },
    });
    expect(() => getConfig()).toThrow(ConfigError);
  });
});

// ─── 2h. Reload behavior ───────────────────────────────────────────

describe("config reload behavior", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("file deleted after initial load reverts to defaults", () => {
    writeTestConfig({ readOnly: true });
    const config1 = getConfig();
    expect(config1.readOnly).toBe(true);

    // Delete the config file.
    unlinkSync(TEST_CONFIG_PATH);
    const config2 = getConfig();
    expect(config2.readOnly).toBe(false);
    expect(config2.readDefaults.maxDepth).toBe(5);
  });

  test("file modified causes new config to be loaded", () => {
    writeTestConfig({ readOnly: false });
    const config1 = getConfig();
    expect(config1.readOnly).toBe(false);

    writeTestConfig({ readOnly: true });
    const config2 = getConfig();
    expect(config2.readOnly).toBe(true);
  });

  test("file unchanged with same mtime returns cached config", () => {
    writeTestConfig({ logLevel: "debug" });
    const config1 = getConfig();
    // Call again without changing the file.
    const config2 = getConfig();
    // Both should be the same object reference since no reload happened.
    expect(config1).toBe(config2);
    expect(config2.logLevel).toBe("debug");
  });

  test("config version incremented on reload", () => {
    writeTestConfig({ readOnly: false });
    getConfig();
    const v1 = getConfigVersion();

    writeTestConfig({ readOnly: true });
    getConfig();
    const v2 = getConfigVersion();

    expect(v2).toBeGreaterThan(v1);
  });

  test("rapid changes pick up latest on next access", () => {
    // Write several configs in quick succession.
    writeTestConfig({ logLevel: "error" });
    writeTestConfig({ logLevel: "info" });
    writeTestConfig({ logLevel: "debug" });

    const config = getConfig();
    expect(config.logLevel).toBe("debug");
  });

  test("invalid config after valid config throws ConfigError", () => {
    writeTestConfig({ readOnly: true });
    const config1 = getConfig();
    expect(config1.readOnly).toBe(true);

    // Write invalid config.
    writeTestConfig({ logLevel: "banana" });
    expect(() => getConfig()).toThrow(ConfigError);
  });
});
