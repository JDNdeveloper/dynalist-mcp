import { describe, test, expect, afterEach } from "bun:test";
import { ConfigError, getConfig, log, parseConfig, setConfigLoader, setLogSink, setTestConfig } from "../config";
import { createFileConfigLoader } from "../config-file";
import { createEnvConfigLoader, installEnvConfigLoader } from "../worker/env-config-loader";

describe("parseConfig", () => {
  test("applies schema defaults", () => {
    const config = parseConfig("{}");
    expect(config.logLevel).toBe("warn");
    expect(config.cache.ttlSeconds).toBe(300);
  });

  test("names the source and remedy in errors", () => {
    expect(() => parseConfig("{", "Config file", "Fix it.")).toThrow(/^Config file is invalid JSON: .*Fix it\.$/);
    expect(() => parseConfig('{"logLevel": "loud"}', "Config file", "Fix it.")).toThrow(/^Config file is invalid: logLevel/);
  });
});

describe("env config loader", () => {
  afterEach(() => {
    // Restore the file loader that the test preload installs.
    setConfigLoader(createFileConfigLoader());
    setTestConfig(null);
    setLogSink((_level, line) => console.error(line));
  });

  test("returns defaults when the value is unset", () => {
    setConfigLoader(createEnvConfigLoader(undefined));
    expect(getConfig().logLevel).toBe("warn");
  });

  test("returns the parsed config for a valid value", () => {
    setConfigLoader(createEnvConfigLoader('{"logLevel": "debug", "cache": {"ttlSeconds": 60}}'));
    expect(getConfig().logLevel).toBe("debug");
    expect(getConfig().cache.ttlSeconds).toBe(60);
  });

  test("throws ConfigError on every load for invalid JSON", () => {
    setConfigLoader(createEnvConfigLoader("{"));
    expect(() => getConfig()).toThrow(ConfigError);
    expect(() => getConfig()).toThrow(/DYNALIST_MCP_CONFIG_JSON is invalid JSON/);
  });

  test("rejects logFile because Workers has no filesystem", () => {
    setConfigLoader(createEnvConfigLoader('{"logFile": "/tmp/x.log"}'));
    expect(() => getConfig()).toThrow(/`logFile` is not supported on Cloudflare Workers/);
  });

  // Log lines written before the first tool call must already respect
  // the configured logLevel.
  test("installEnvConfigLoader applies logLevel before any getConfig call", () => {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    installEnvConfigLoader('{"logLevel": "error"}');
    log("warn", "should be filtered");
    log("error", "should appear");
    expect(lines).toEqual(["[dynalist-mcp] [error] should appear"]);
  });
});
