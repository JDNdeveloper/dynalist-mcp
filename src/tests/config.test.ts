import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getConfig, getStartupConfig, getConfigVersion, ConfigError, setTestConfig } from "../config";
import {
  createTestContext,
  callToolOk,
  callToolError,
  getVersion,
  standardSetup,
  type TestContext,
} from "./tools/test-helpers";

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
  // Reset all internal config state for test isolation.
  setTestConfig(null);
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
    expect(config.readDefaults.maxDepth).toBe(3);
    expect(config.readDefaults.includeCollapsedChildren).toBe(false);
    expect(config.readDefaults.includeNotes).toBe(true);
    expect(config.readDefaults.includeChecked).toBe(true);
    expect(config.sizeWarning.warningTokenThreshold).toBe(5000);
    expect(config.sizeWarning.maxTokenThreshold).toBe(24500);
    expect(config.cache.ttlSeconds).toBe(300);
    expect(config.logLevel).toBe("warn");
  });

  test("partial config fills missing fields with defaults", () => {
    writeTestConfig({ logLevel: "debug" });
    const config = getConfig();
    expect(config.logLevel).toBe("debug");
    // Other fields should be defaults.
    expect(config.readDefaults.maxDepth).toBe(3);
    expect(config.cache.ttlSeconds).toBe(300);
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

  test("default maxDepth is 3 when readDefaults not specified", () => {
    writeTestConfig({});
    const config = getConfig();
    expect(config.readDefaults.maxDepth).toBe(3);
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

  test("readOnly is rejected by strict schema", () => {
    writeTestConfig({ readOnly: true });
    expect(() => getConfig()).toThrow(ConfigError);
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

  test("bare ** shorthand is transformed to /**", () => {
    writeTestConfig({
      access: {
        rules: [{ path: "**", policy: "deny" }],
      },
    });
    const config = getConfig();
    expect(config.access?.rules[0].path).toBe("/**");
  });

  test("bare * shorthand is transformed to /*", () => {
    writeTestConfig({
      access: {
        rules: [{ path: "*", policy: "read" }],
      },
    });
    const config = getConfig();
    expect(config.access?.rules[0].path).toBe("/*");
  });

  test("non-root bare glob like Docs/** is still rejected", () => {
    writeTestConfig({
      access: {
        rules: [{ path: "Documents/**", policy: "allow" }],
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
    writeTestConfig({ logLevel: "debug" });
    const config1 = getConfig();
    expect(config1.logLevel).toBe("debug");

    // Delete the config file.
    unlinkSync(TEST_CONFIG_PATH);
    const config2 = getConfig();
    expect(config2.logLevel).toBe("warn");
    expect(config2.readDefaults.maxDepth).toBe(3);
  });

  test("file modified causes new config to be loaded", () => {
    writeTestConfig({ logLevel: "warn" });
    const config1 = getConfig();
    expect(config1.logLevel).toBe("warn");

    writeTestConfig({ logLevel: "debug" });
    const config2 = getConfig();
    expect(config2.logLevel).toBe("debug");
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
    writeTestConfig({ logLevel: "warn" });
    getConfig();
    const v1 = getConfigVersion();

    writeTestConfig({ logLevel: "debug" });
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
    writeTestConfig({ logLevel: "debug" });
    const config1 = getConfig();
    expect(config1.logLevel).toBe("debug");

    // Write invalid config.
    writeTestConfig({ logLevel: "banana" });
    expect(() => getConfig()).toThrow(ConfigError);
  });
});

// ─── Hot-reload split ────────────────────────────────────────────────

describe("config hot-reload split", () => {
  beforeEach(() => {
    setConfigEnv();
  });

  afterEach(() => {
    cleanupConfig();
    delete process.env.DYNALIST_MCP_CONFIG;
  });

  test("startup-only fields are not updated on file change", () => {
    writeTestConfig({
      readDefaults: { maxDepth: 5 },
      sizeWarning: { warningTokenThreshold: 2000, maxTokenThreshold: 10000 },
      cache: { ttlSeconds: 120 },
      logLevel: "info",
    });
    const config1 = getConfig();
    expect(config1.readDefaults.maxDepth).toBe(5);
    expect(config1.sizeWarning.warningTokenThreshold).toBe(2000);
    expect(config1.cache.ttlSeconds).toBe(120);
    expect(config1.logLevel).toBe("info");

    // Change all fields including startup-only ones.
    writeTestConfig({
      readDefaults: { maxDepth: 20 },
      sizeWarning: { warningTokenThreshold: 9000, maxTokenThreshold: 50000 },
      cache: { ttlSeconds: 600 },
      logLevel: "debug",
    });
    const config2 = getConfig();

    // Hot-reloadable field updated.
    expect(config2.logLevel).toBe("debug");

    // Startup-only fields frozen from initial load.
    expect(config2.readDefaults.maxDepth).toBe(5);
    expect(config2.sizeWarning.warningTokenThreshold).toBe(2000);
    expect(config2.cache.ttlSeconds).toBe(120);
  });

  test("access rules are hot-reloaded", () => {
    writeTestConfig({
      access: { default: "allow", rules: [] },
    });
    const config1 = getConfig();
    expect(config1.access?.default).toBe("allow");

    writeTestConfig({
      access: { default: "deny", rules: [{ path: "/Docs/**", policy: "allow" }] },
    });
    const config2 = getConfig();
    expect(config2.access?.default).toBe("deny");
    expect(config2.access?.rules).toHaveLength(1);
  });

  test("logFile is hot-reloaded", () => {
    writeTestConfig({});
    const config1 = getConfig();
    expect(config1.logFile).toBeUndefined();

    writeTestConfig({ logFile: "/tmp/test.log" });
    const config2 = getConfig();
    expect(config2.logFile).toBe("/tmp/test.log");
  });

  test("file deletion reverts hot-reloadable fields but preserves startup-only fields", () => {
    writeTestConfig({
      readDefaults: { maxDepth: 7 },
      logLevel: "debug",
    });
    const config1 = getConfig();
    expect(config1.readDefaults.maxDepth).toBe(7);
    expect(config1.logLevel).toBe("debug");

    // Delete the file.
    unlinkSync(TEST_CONFIG_PATH);
    const config2 = getConfig();

    // Hot-reloadable field reverts to default.
    expect(config2.logLevel).toBe("warn");

    // Startup-only field preserved from initial load.
    expect(config2.readDefaults.maxDepth).toBe(7);
  });

  test("hot-reload mutates cached object so prior references see updates", () => {
    writeTestConfig({ logLevel: "info" });
    const config1 = getConfig();
    expect(config1.logLevel).toBe("info");

    // Hot-reload updates cachedConfig in place. The prior reference
    // should see the mutation since it points to the same object.
    writeTestConfig({ logLevel: "debug" });
    const config2 = getConfig();

    expect(config1).toBe(config2);
    expect(config1.logLevel).toBe("debug");
  });

  test("late-appearing config file gets full initial load for startup-only fields", () => {
    // No config file at startup. getConfig returns defaults.
    const config1 = getConfig();
    expect(config1.readDefaults.maxDepth).toBe(3);
    expect(config1.logLevel).toBe("warn");

    // Config file appears after startup. Since initialLoadDone is still
    // false (no file was ever loaded), the first file load sets all
    // fields including startup-only ones.
    writeTestConfig({
      readDefaults: { maxDepth: 15 },
      sizeWarning: { warningTokenThreshold: 8000, maxTokenThreshold: 40000 },
      logLevel: "info",
    });
    const config2 = getConfig();
    expect(config2.readDefaults.maxDepth).toBe(15);
    expect(config2.sizeWarning.warningTokenThreshold).toBe(8000);
    expect(config2.logLevel).toBe("info");

    // Subsequent reloads only propagate hot-reloadable fields.
    writeTestConfig({
      readDefaults: { maxDepth: 99 },
      sizeWarning: { warningTokenThreshold: 1, maxTokenThreshold: 1 },
      logLevel: "error",
    });
    const config3 = getConfig();
    expect(config3.logLevel).toBe("error");
    expect(config3.readDefaults.maxDepth).toBe(15);
    expect(config3.sizeWarning.warningTokenThreshold).toBe(8000);
  });

  test("removing access section on reload reverts to undefined", () => {
    writeTestConfig({
      access: { default: "deny", rules: [{ path: "/Docs/**", policy: "allow" }] },
    });
    const config1 = getConfig();
    expect(config1.access?.default).toBe("deny");
    expect(config1.access?.rules).toHaveLength(1);

    // Reload without access section. The hot-reload loop sets
    // cachedConfig.access to the new parsed value (undefined),
    // effectively lifting restrictions.
    writeTestConfig({ logLevel: "debug" });
    const config2 = getConfig();
    expect(config2.access).toBeUndefined();
  });

  test("getStartupConfig returns only startup-only fields", () => {
    writeTestConfig({
      access: { default: "deny", rules: [] },
      readDefaults: { maxDepth: 7 },
      logLevel: "debug",
    });
    const startup = getStartupConfig();
    expect(startup.readDefaults.maxDepth).toBe(7);
    expect(startup.sizeWarning.warningTokenThreshold).toBe(5000);
    expect(startup.cache.ttlSeconds).toBe(300);

    // Hot-reloadable fields are excluded from the return type and value.
    expect("logLevel" in startup).toBe(false);
    expect("access" in startup).toBe(false);
    expect("logFile" in startup).toBe(false);
  });
});

// ─── Config reloading between tool invocations ──────────────────────

describe("config reloading between tool invocations", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("access default change is picked up on next tool invocation", async () => {
    // Start with no access restrictions, so writes succeed.
    ctx = await createTestContext(standardSetup);

    const version = await getVersion(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      expected_version: version,
      nodes: [{ node_id: "n1", content: "Updated" }],
    });
    expect(result.file_id).toBe("doc1");

    // Switch to access.default: "read" via setTestConfig.
    setTestConfig({
      readDefaults: { maxDepth: 3, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
      sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },
      access: { default: "read", rules: [] },
      cache: { ttlSeconds: 300 },
      logLevel: "warn",
    });

    // The next write tool invocation should see the read-only policy and refuse.
    const version2 = await getVersion(ctx.mcpClient, "doc1");
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      expected_version: version2,
      nodes: [{ node_id: "n1", content: "Should fail" }],
    });
    expect(err.error).toBe("Forbidden");
    expect(err.message).toBe("Document is read-only per access policy.");
  });

  test("readDefaults are startup-only: changes after registration do not affect schema defaults", async () => {
    // Start with includeChecked: true baked into schema defaults.
    ctx = await createTestContext(standardSetup, {
      readDefaults: { maxDepth: 10, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
    });

    // n3 has checked: true. With default includeChecked: true, it should appear.
    const result1 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const node1 = result1.node as Record<string, unknown>;
    const children1 = node1.children as Record<string, unknown>[];
    expect(children1.some((c) => c.node_id === "n3")).toBe(true);

    // Change readDefaults after registration. Since readDefaults are startup-only
    // and baked into schema defaults at registration time, this should NOT affect
    // the schema's default for include_checked.
    setTestConfig({
      readDefaults: { maxDepth: 10, includeCollapsedChildren: false, includeNotes: true, includeChecked: false },
      sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },
      cache: { ttlSeconds: 300 },
      logLevel: "warn",
    });

    // n3 should STILL appear because the schema default (includeChecked: true)
    // was baked at registration time.
    const result2 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    const node2 = result2.node as Record<string, unknown>;
    const children2 = node2.children as Record<string, unknown>[];
    expect(children2.some((c) => c.node_id === "n3")).toBe(true);

    // Explicit parameter override still works.
    const result3 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      include_checked: false,
    });
    const node3 = result3.node as Record<string, unknown>;
    const children3 = node3.children as Record<string, unknown>[];
    expect(children3.some((c) => c.node_id === "n3")).toBe(false);
  });

  test("sizeWarning threshold change takes effect on next read", async () => {
    // Start with high thresholds so nothing triggers a warning.
    ctx = await createTestContext(standardSetup, {
      sizeWarning: { warningTokenThreshold: 100000, maxTokenThreshold: 200000 },
    });

    const result1 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    expect(result1.warning).toBeUndefined();
    expect(result1.node).toBeDefined();

    // Lower thresholds so the same read triggers a warning.
    setTestConfig({
      readDefaults: { maxDepth: 3, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
      sizeWarning: { warningTokenThreshold: 1, maxTokenThreshold: 24500 },
      cache: { ttlSeconds: 300 },
      logLevel: "warn",
    });

    const result2 = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    expect(result2.warning).toBeDefined();
  });
});
