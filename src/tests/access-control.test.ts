import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AccessController, requireAccess, type Policy } from "../access-control";
import { getConfig, getConfigVersion, ConfigError, type Config } from "../config";
import { DummyDynalistServer, MockDynalistClient } from "./dummy-server";

// ─── Test helpers ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
    sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },
    inbox: { defaultCheckbox: false },
    readOnly: false,
    cache: { ttlSeconds: 300 },
    logLevel: "warn",
    ...overrides,
  };
}

function setupServer(): { server: DummyDynalistServer; client: MockDynalistClient } {
  const server = new DummyDynalistServer();
  server.init();
  // /Folder A/Doc A, /Folder A/Doc B, /Folder B/Doc C, /Private/Secret.
  server.addFolder("fa", "Folder A", "root_folder");
  server.addFolder("fb", "Folder B", "root_folder");
  server.addFolder("fp", "Private", "root_folder");
  server.addDocument("da", "Doc A", "fa");
  server.addDocument("db", "Doc B", "fa");
  server.addDocument("dc", "Doc C", "fb");
  server.addDocument("ds", "Secret", "fp");
  return { server, client: new MockDynalistClient(server) };
}

// ─── requireAccess ───────────────────────────────────────────────────

describe("requireAccess", () => {
  test("allow policy permits read and write", () => {
    expect(requireAccess("allow", "read", false)).toBeNull();
    expect(requireAccess("allow", "write", false)).toBeNull();
  });

  test("read policy permits read but blocks write", () => {
    expect(requireAccess("read", "read", false)).toBeNull();
    const err = requireAccess("read", "write", false);
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ReadOnly");
  });

  test("deny policy blocks both read and write", () => {
    const readErr = requireAccess("deny", "read", false);
    expect(readErr).not.toBeNull();
    expect(readErr!.error).toBe("NotFound");

    const writeErr = requireAccess("deny", "write", false);
    expect(writeErr).not.toBeNull();
    expect(writeErr!.error).toBe("NotFound");
  });

  test("readOnly mode blocks write even on allow policy", () => {
    const err = requireAccess("allow", "write", true);
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ReadOnly");
  });

  test("deny error message is generic (indistinguishable from NotFound)", () => {
    const err = requireAccess("deny", "read", false)!;
    expect(err.error).toBe("NotFound");
    expect(err.message).toBe("Document not found or access denied.");
  });

  test("ReadOnly error message says 'read-only per access policy'", () => {
    const err = requireAccess("read", "write", false)!;
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Document is read-only per access policy.");
  });

  test("global readOnly blocks write even when policy is allow", () => {
    const err = requireAccess("allow", "write", true);
    expect(err).not.toBeNull();
    expect(err!.error).toBe("ReadOnly");
    expect(err!.message).toBe("Server is in read-only mode.");
  });

  test("global readOnly error message says 'Server is in read-only mode.'", () => {
    const err = requireAccess("allow", "write", true)!;
    expect(err.message).toBe("Server is in read-only mode.");
  });
});

// ─── AccessController.getPolicy ──────────────────────────────────────

describe("AccessController.getPolicy", () => {
  let server: DummyDynalistServer;
  let client: MockDynalistClient;

  beforeEach(() => {
    ({ server, client } = setupServer());
  });

  test("no access config returns allow for all", async () => {
    const ac = new AccessController(client);
    const config = makeConfig();
    expect(await ac.getPolicy("da", config)).toBe("allow");
    expect(await ac.getPolicy("ds", config)).toBe("allow");
  });

  test("default deny blocks unmatched files", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Folder A/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("allow");
    expect(await ac.getPolicy("dc", config)).toBe("deny");
  });

  test("exact path match", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/Secret", policy: "deny" }],
      },
    });
    expect(await ac.getPolicy("ds", config)).toBe("deny");
    expect(await ac.getPolicy("da", config)).toBe("allow");
  });

  test("recursive glob matches deeply", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });
    expect(await ac.getPolicy("ds", config)).toBe("deny");
    expect(await ac.getPolicy("fp", config)).toBe("deny");
  });

  test("single-level glob matches only direct children", async () => {
    const ac = new AccessController(client);
    // /Folder A/* should match /Folder A/Doc A but NOT /Folder A itself.
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A/*", policy: "read" }],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("read");
    expect(await ac.getPolicy("db", config)).toBe("read");
    // The folder itself is not matched by single-level glob.
    expect(await ac.getPolicy("fa", config)).toBe("allow");
  });

  test("exact match beats single-level glob", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/Folder A/*", policy: "deny" },
          { path: "/Folder A/Doc A", policy: "allow" },
        ],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("allow");
    expect(await ac.getPolicy("db", config)).toBe("deny");
  });

  test("single-level glob beats recursive glob", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [
          { path: "/Folder A/**", policy: "deny" },
          { path: "/Folder A/*", policy: "allow" },
        ],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("allow");
  });

  test("longer prefix beats shorter prefix at same glob type", async () => {
    const ac = new AccessController(client);
    // Add a nested folder for this test.
    server.addFolder("fa_sub", "Sub", "fa");
    server.addDocument("da_sub", "Nested Doc", "fa_sub");

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [
          { path: "/Folder A/**", policy: "deny" },
          { path: "/Folder A/Sub/**", policy: "allow" },
        ],
      },
    });
    expect(await ac.getPolicy("da_sub", config)).toBe("allow");
    expect(await ac.getPolicy("da", config)).toBe("deny");
  });

  test("read policy on a document", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder B/**", policy: "read" }],
      },
    });
    expect(await ac.getPolicy("dc", config)).toBe("read");
  });

  test("file not in tree uses default policy", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });
    // Non-existent file ID.
    expect(await ac.getPolicy("nonexistent", config)).toBe("allow");
  });

  test("default allow permits unmatched files", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });
    // Doc A is not matched by any rule, so it falls back to default allow.
    expect(await ac.getPolicy("da", config)).toBe("allow");
  });

  test("default read makes unmatched files read-only", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "read",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });
    // Doc A is not matched by any rule, so it falls back to default read.
    expect(await ac.getPolicy("da", config)).toBe("read");
  });

  test("/* does NOT match the folder path prefix itself", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A/*", policy: "deny" }],
      },
    });
    // The glob /* should only match children, not the folder itself.
    expect(await ac.getPolicy("fa", config)).toBe("allow");
    // But children should be matched.
    expect(await ac.getPolicy("da", config)).toBe("deny");
  });

  test("/** DOES match the path prefix itself", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A/**", policy: "deny" }],
      },
    });
    // The glob /** should match the folder itself as well as descendants.
    expect(await ac.getPolicy("fa", config)).toBe("deny");
    expect(await ac.getPolicy("da", config)).toBe("deny");
  });

  test("overlapping rules: /A/** deny + /A/B/** allow, deeper allow wins", async () => {
    const ac = new AccessController(client);
    // Set up /Folder A/Sub/Nested Doc.
    server.addFolder("fa_sub", "Sub", "fa");
    server.addDocument("da_sub", "Nested Doc", "fa_sub");

    const config = makeConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/Folder A/**", policy: "deny" },
          { path: "/Folder A/Sub/**", policy: "allow" },
        ],
      },
    });
    expect(await ac.getPolicy("da_sub", config)).toBe("allow");
    expect(await ac.getPolicy("fa_sub", config)).toBe("allow");
  });

  test("overlapping rules: /A/** allow + /A/B/** deny, deeper deny wins", async () => {
    const ac = new AccessController(client);
    server.addFolder("fa_sub", "Sub", "fa");
    server.addDocument("da_sub", "Nested Doc", "fa_sub");

    const config = makeConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/Folder A/**", policy: "allow" },
          { path: "/Folder A/Sub/**", policy: "deny" },
        ],
      },
    });
    expect(await ac.getPolicy("da_sub", config)).toBe("deny");
    expect(await ac.getPolicy("fa_sub", config)).toBe("deny");
  });

  test("overlapping rules: /A/** deny + /A/B exact allow, exact wins", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/Folder A/**", policy: "deny" },
          { path: "/Folder A/Doc A", policy: "allow" },
        ],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("allow");
    // Other children of Folder A still denied.
    expect(await ac.getPolicy("db", config)).toBe("deny");
  });

  test("overlapping rules: /A/* read + /A/B exact allow, exact wins", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [
          { path: "/Folder A/*", policy: "read" },
          { path: "/Folder A/Doc A", policy: "allow" },
        ],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("allow");
    expect(await ac.getPolicy("db", config)).toBe("read");
  });

  test("deeper recursive glob beats shallower for nested files", async () => {
    const ac = new AccessController(client);
    server.addFolder("fa_sub", "Sub", "fa");
    server.addFolder("fa_sub_deep", "Deep", "fa_sub");
    server.addDocument("da_deep", "Deep Doc", "fa_sub_deep");

    const config = makeConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/Folder A/**", policy: "deny" },
          { path: "/Folder A/Sub/**", policy: "allow" },
        ],
      },
    });
    // /Folder A/Sub/Deep/Deep Doc should match /Folder A/Sub/** (longer prefix).
    expect(await ac.getPolicy("da_deep", config)).toBe("allow");
  });

  // Skipped: root-level globs like /** and /* fail validation because
  // the base path "/" does not match any file in the path map. The
  // validateRules function strips the glob suffix and checks if the
  // remaining base path exists in allPaths, but "/" is never in the
  // path map (root has no path entry). This causes fail-closed behavior.
  // See ~/sav/dynalist-mcp/testing-bug-report-acl-unit.md for details.
  test("root-level /** deny makes everything denied", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/**", policy: "deny" }],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("deny");
    expect(await ac.getPolicy("dc", config)).toBe("deny");
    expect(await ac.getPolicy("fa", config)).toBe("deny");
  });

  test("root-level /* read makes only top-level items read-only", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/*", policy: "read" }],
      },
    });
    // Top-level folders are direct children of root.
    expect(await ac.getPolicy("fa", config)).toBe("read");
    expect(await ac.getPolicy("fb", config)).toBe("read");
    // Nested documents should not be matched by /*.
    expect(await ac.getPolicy("da", config)).toBe("allow");
  });

  test("multiple rules at same specificity: last-wins or first-wins", async () => {
    const ac = new AccessController(client);
    // Both rules are recursive globs with same prefix length.
    // The implementation iterates rules and keeps the highest score.
    // Same score means the first one wins (> not >=).
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/Folder A/**", policy: "deny" },
          { path: "/Folder A/**", policy: "read" },
        ],
      },
    });
    // Duplicate paths are rejected by schema, so this config is actually
    // invalid. We test the raw evaluateRules behavior by using the same
    // path twice. Since the schema rejects duplicates, this test verifies
    // that the first match wins when scores are equal.
    //
    // NOTE: This config will fail schema validation, but makeConfig
    // bypasses the schema. The result depends on implementation: first
    // rule wins because the loop uses > (strict greater than).
    expect(await ac.getPolicy("da", config)).toBe("deny");
  });

  test("path with no matching rule and default allow returns allow", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });
    expect(await ac.getPolicy("dc", config)).toBe("allow");
  });

  test("path with no matching rule and default deny returns deny", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Private/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("dc", config)).toBe("deny");
  });
});

// ─── AccessController.getPolicies (batch) ────────────────────────────

describe("AccessController.getPolicies", () => {
  let server: DummyDynalistServer;
  let client: MockDynalistClient;

  beforeEach(() => {
    ({ server, client } = setupServer());
  });

  test("batch evaluation returns correct policies", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });

    const policies = await ac.getPolicies(["da", "ds", "dc"], config);
    expect(policies.get("da")).toBe("allow");
    expect(policies.get("ds")).toBe("deny");
    expect(policies.get("dc")).toBe("allow");
  });

  test("mixed batch: some allow, some read, some deny", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/Private/**", policy: "deny" },
          { path: "/Folder B/**", policy: "read" },
        ],
      },
    });

    const policies = await ac.getPolicies(["da", "dc", "ds"], config);
    expect(policies.get("da")).toBe("allow");
    expect(policies.get("dc")).toBe("read");
    expect(policies.get("ds")).toBe("deny");
  });

  test("batch with duplicate file IDs returns correct policies", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });

    const policies = await ac.getPolicies(["da", "da", "ds", "ds"], config);
    expect(policies.get("da")).toBe("allow");
    expect(policies.get("ds")).toBe("deny");
  });

  test("batch with unknown file IDs uses default policy", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Folder A/**", policy: "allow" }],
      },
    });

    const policies = await ac.getPolicies(["da", "nonexistent"], config);
    expect(policies.get("da")).toBe("allow");
    expect(policies.get("nonexistent")).toBe("deny");
  });

  test("empty batch returns empty map", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [],
      },
    });

    const policies = await ac.getPolicies([], config);
    expect(policies.size).toBe(0);
  });
});

// ─── getPolicies ConfigError propagation ──────────────────────────────

describe("AccessController.getPolicies ConfigError", () => {
  test("validation failure throws ConfigError through batch path", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Typo Folder/**", policy: "deny" }],
      },
    });
    await expect(ac.getPolicies(["da", "ds"], config)).rejects.toThrow(ConfigError);
  });
});

// ─── Error message information leaks ─────────────────────────────────

describe("ConfigError messages do not leak protected info", () => {
  test("path drift error does not reveal rule path, id, or resolved path", async () => {
    const { server, client } = setupServer();
    server.files.get("fp")!.title = "Secret Renamed";

    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });

    const err = await ac.getPolicy("da", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).not.toContain("/Private");
    expect(err.message).not.toContain("fp");
    expect(err.message).not.toContain("Secret Renamed");
  });

  test("missing id error does not reveal rule path or id", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Secret/**", policy: "deny", id: "gone123" }],
      },
    });

    const err = await ac.getPolicy("da", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).not.toContain("/Secret");
    expect(err.message).not.toContain("gone123");
  });

  test("unmatched path error does not reveal rule path", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Confidential/**", policy: "deny" }],
      },
    });

    const err = await ac.getPolicy("da", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).not.toContain("/Confidential");
  });

  test("interior glob error does not reveal rule path", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Secret/*/Nested", policy: "deny" }],
      },
    });

    const err = await ac.getPolicy("da", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).not.toContain("/Secret");
  });
});

// ─── ID-anchored rules ──────────────────────────────────────────────

describe("ID-anchored rules", () => {
  test("id-anchored rename throws ConfigError with corrected path", async () => {
    const { server, client } = setupServer();
    // Rename the folder so the path drifts from the rule's path pattern.
    const folder = server.files.get("fp")!;
    folder.title = "Renamed Private";

    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });

    // The rule's path says /Private/** but the folder is now /Renamed Private.
    // Path drift is a config error.
    const err = await ac.getPolicy("ds", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("no longer matches its id");
  });

  test("id-anchored move throws ConfigError with corrected path", async () => {
    const { server, client } = setupServer();

    // Move /Private folder under /Folder B.
    const rootFolder = server.files.get("root_folder")!;
    rootFolder.children = rootFolder.children!.filter((id) => id !== "fp");
    const folderB = server.files.get("fb")!;
    folderB.children!.push("fp");

    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });

    // ID resolves to /Folder B/Private but config says /Private.
    const err = await ac.getPolicy("ds", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("no longer matches its id");
  });

  test("id-anchored path drift includes glob suffix in suggested fix", async () => {
    const { server, client } = setupServer();

    // Rename the folder. The rule uses /** suffix.
    const folder = server.files.get("fp")!;
    folder.title = "Moved Private";

    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });

    // The error message should not reveal the resolved path.
    const err = await ac.getPolicy("ds", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("no longer matches its id");
  });

  test("id-anchored rule where ID does not exist throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Nonexistent/**", policy: "deny", id: "does_not_exist" }],
      },
    });

    // Validation should fail because the ID is not in the tree.
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("id-anchored rule path drift throws ConfigError with corrected path", async () => {
    const { server, client } = setupServer();

    // Rename Private to "Secure" so the path drifts.
    const folder = server.files.get("fp")!;
    folder.title = "Secure";

    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        // Path says /Private/** but folder is now /Secure.
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });

    // Path drift is a ConfigError.
    const err = await ac.getPolicy("ds", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("no longer matches its id");
  });
});

// ─── Path building (buildPathMap) ─────────────────────────────────────

describe("buildPathMap (via getPolicy)", () => {
  test("simple tree: root > folder > document produces correct paths", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);

    // If /Folder A/Doc A is the correct path, an exact rule should match.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Folder A/Doc A", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("allow");
  });

  test("root direct children have paths like /Title", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);

    // Folder A is a direct child of root, so its path should be /Folder A.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Folder A", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("fa", config)).toBe("allow");
  });

  test("deeply nested tree produces correct paths", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("l1", "Level1", "root_folder");
    server.addFolder("l2", "Level2", "l1");
    server.addFolder("l3", "Level3", "l2");
    server.addDocument("deep_doc", "DeepDoc", "l3");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Level1/Level2/Level3/DeepDoc", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("deep_doc", config)).toBe("allow");
  });

  test("root file itself has no path entry", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);

    // The root folder should not have a path entry, so it uses the default.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Folder A/**", policy: "allow" }],
      },
    });
    // Root file should get default deny since it has no path.
    expect(await ac.getPolicy("root_folder", config)).toBe("deny");
  });

  test("files with special characters in titles", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("sp_folder", "My Folder (2024)", "root_folder");
    server.addDocument("sp_doc", "Notes & Ideas!", "sp_folder");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/My Folder (2024)/Notes & Ideas!", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("sp_doc", config)).toBe("allow");
  });
});

// ─── Rule validation (validateRules) ─────────────────────────────────

describe("validateRules (via getPolicy)", () => {
  test("rule path matches a file: no error", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });
    // Should succeed without fail-closed behavior.
    expect(await ac.getPolicy("da", config)).toBe("allow");
  });

  test("rule path that does not match any file throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Typo Folder/**", policy: "deny" }],
      },
    });
    // Validation fails because /Typo Folder does not exist.
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("id-anchored rule with valid ID: no error", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });
    // Valid ID should not cause validation error.
    expect(await ac.getPolicy("da", config)).toBe("allow");
    expect(await ac.getPolicy("ds", config)).toBe("deny");
  });

  test("id-anchored rule with non-existent ID throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Whatever/**", policy: "deny", id: "bad_id" }],
      },
    });
    // Non-existent ID triggers ConfigError.
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("id-anchored rule with path drift throws ConfigError", async () => {
    const { server, client } = setupServer();
    // Rename Private to something else to cause path drift.
    server.files.get("fp")!.title = "Renamed";

    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        // Path says /Private/** but actual path is /Renamed.
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });
    // Path drift is now a ConfigError, not a silent warning.
    await expect(ac.getPolicy("ds", config)).rejects.toThrow(ConfigError);
  });

  test("validation errors throw ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Does Not Exist/**", policy: "read" }],
      },
    });
    // The path does not match any file. Validation throws ConfigError.
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });
});

// ─── Rule validation: interior globs ─────────────────────────────────

describe("validateRules: interior globs", () => {
  test("interior glob /foo/*/bar throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A/*/Doc A", policy: "deny" }],
      },
    });
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("interior glob with ID anchor throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/*/Secret", policy: "deny", id: "fp" }],
      },
    });
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("multiple glob segments /foo/**/bar/* throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A/**/Sub/*", policy: "deny" }],
      },
    });
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("trailing /** with ID anchor passes validation", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny", id: "fp" }],
      },
    });
    // Valid pattern. Should not fail-closed.
    expect(await ac.getPolicy("da", config)).toBe("allow");
    expect(await ac.getPolicy("ds", config)).toBe("deny");
  });

  test("trailing /* with ID anchor passes validation", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A/*", policy: "read", id: "fa" }],
      },
    });
    expect(await ac.getPolicy("da", config)).toBe("read");
    expect(await ac.getPolicy("fa", config)).toBe("allow");
  });

  test("no glob with ID anchor passes validation", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/Secret", policy: "deny", id: "ds" }],
      },
    });
    expect(await ac.getPolicy("ds", config)).toBe("deny");
    expect(await ac.getPolicy("da", config)).toBe("allow");
  });
});

// ─── Cache invalidation ─────────────────────────────────────────────

describe("cache invalidation", () => {
  test("invalidateCache forces refetch on next call", async () => {
    const { server, client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });

    expect(await ac.getPolicy("ds", config)).toBe("deny");

    // Move the document out of Private.
    const privateFolder = server.files.get("fp")!;
    privateFolder.children = [];
    const folderA = server.files.get("fa")!;
    folderA.children!.push("ds");

    // Without invalidation, stale cache still returns deny.
    // With invalidation, it should re-resolve.
    ac.invalidateCache();
    expect(await ac.getPolicy("ds", config)).toBe("allow");
  });

  test("cache TTL: after TTL expires, next call refetches", async () => {
    const { server, client } = setupServer();
    const ac = new AccessController(client);
    // Use a very short TTL so we can test expiration.
    const config = makeConfig({
      cache: { ttlSeconds: 0 },
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });

    expect(await ac.getPolicy("ds", config)).toBe("deny");

    // Move the document out of Private.
    const privateFolder = server.files.get("fp")!;
    privateFolder.children = [];
    const folderA = server.files.get("fa")!;
    folderA.children!.push("ds");

    // With TTL of 0, cache should be expired and refetched automatically.
    expect(await ac.getPolicy("ds", config)).toBe("allow");
  });

  test("stale cache after rename: denial retry invalidates cache", async () => {
    const { server, client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Private/**", policy: "deny" }],
      },
    });

    // Initial call caches the path map.
    expect(await ac.getPolicy("ds", config)).toBe("deny");

    // Now move ds out of Private without explicitly invalidating.
    const privateFolder = server.files.get("fp")!;
    privateFolder.children = [];
    const folderA = server.files.get("fa")!;
    folderA.children!.push("ds");

    // getPolicy should auto-retry on denial with fresh cache.
    // The first evaluation uses stale cache and gets "deny".
    // The retry invalidates cache, refetches, and gets "allow".
    expect(await ac.getPolicy("ds", config)).toBe("allow");
  });

  test("config version change triggers cache invalidation", async () => {
    const { server, client } = setupServer();
    const ac = new AccessController(client);

    // Set up a temp config file so we can bump the config version.
    const configPath = join(tmpdir(), `dynalist-mcp-acl-test-${process.pid}.json`);
    process.env.DYNALIST_MCP_CONFIG = configPath;
    let fakeMtime = Date.now();

    function writeAndLoad(data: unknown) {
      writeFileSync(configPath, JSON.stringify(data));
      fakeMtime += 2000;
      const secs = fakeMtime / 1000;
      utimesSync(configPath, secs, secs);
      getConfig();
    }

    try {
      // Write an initial config to establish a baseline version.
      writeAndLoad({ readOnly: false });

      const config = makeConfig({
        access: {
          default: "allow",
          rules: [{ path: "/Private/**", policy: "deny" }],
        },
      });

      // Populate the cache.
      expect(await ac.getPolicy("ds", config)).toBe("deny");

      // Move the document out of Private.
      const privateFolder = server.files.get("fp")!;
      privateFolder.children = [];
      const folderA = server.files.get("fa")!;
      folderA.children!.push("ds");

      // Bump the config version by writing and loading a new config.
      writeAndLoad({ readOnly: true });

      // The AccessController should detect the version change, invalidate
      // its cache, and refetch the file tree with the updated paths.
      expect(await ac.getPolicy("ds", config)).toBe("allow");
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
      delete process.env.DYNALIST_MCP_CONFIG;
      // Reset the config module so it detects the file was removed.
      try { getConfig(); } catch { /* Ignore errors from stale state. */ }
    }
  });
});

// ─── Rule validation: duplicate paths ────────────────────────────────

describe("rule validation: duplicates", () => {
  test("duplicate paths in rules rejected by config schema", () => {
    const configPath = join(tmpdir(), `dynalist-mcp-acl-dup-test-${process.pid}.json`);
    process.env.DYNALIST_MCP_CONFIG = configPath;
    let fakeMtime = Date.now();

    try {
      const configData = {
        access: {
          default: "allow",
          rules: [
            { path: "/Folder A/**", policy: "deny" },
            { path: "/Folder A/**", policy: "allow" },
          ],
        },
      };
      writeFileSync(configPath, JSON.stringify(configData));
      fakeMtime += 2000;
      const secs = fakeMtime / 1000;
      utimesSync(configPath, secs, secs);

      // The schema should reject duplicate path entries.
      expect(() => getConfig()).toThrow("Duplicate path entries in access rules.");
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
      delete process.env.DYNALIST_MCP_CONFIG;
      try { getConfig(); } catch { /* Ignore errors from stale state. */ }
    }
  });

  test("duplicate titles in tree: warning logged, rule applies to all files at that path", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Create two folders with different names.
    server.addFolder("f1", "FolderX", "root_folder");
    server.addFolder("f2", "FolderY", "root_folder");
    // Create two documents with the same name in different folders,
    // but give the folders the same name so paths collide.
    server.addDocument("d1", "SameName", "f1");
    server.addDocument("d2", "SameName", "f2");
    // Rename FolderY to FolderX so both folders share the same path.
    server.files.get("f2")!.title = "FolderX";

    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Both documents now live at /FolderX/SameName.
    // A path-only rule should apply to both of them.
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/FolderX/SameName", policy: "deny" }],
      },
    });

    // The rule matches the path for both d1 and d2.
    expect(await ac.getPolicy("d1", config)).toBe("deny");
    expect(await ac.getPolicy("d2", config)).toBe("deny");
  });

  test("duplicate titles with ID disambiguation: no validation error", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Create two folders with different names, then rename to collide.
    server.addFolder("f1", "FolderX", "root_folder");
    server.addFolder("f2", "FolderY", "root_folder");
    server.addDocument("d1", "SameName", "f1");
    server.addDocument("d2", "SameName", "f2");
    // Rename FolderY to FolderX so both folders share the same path.
    server.files.get("f2")!.title = "FolderX";

    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Use an ID-anchored rule targeting d1. Because the rule has an
    // ID, validateRules skips the duplicate-title warning check.
    // This means no validation error and no fail-closed behavior.
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/FolderX/SameName", policy: "deny", id: "d1" }],
      },
    });

    // The rule should work normally without fail-closed behavior.
    // The ID resolves to d1's path, which matches both d1 and d2
    // since they share the same literal path. The key point is that
    // validation passes (no fail-closed) because ID-anchored rules
    // are exempt from the duplicate-title warning.
    expect(await ac.getPolicy("d1", config)).toBe("deny");

    // Other unrelated files remain unaffected.
    const configWithFolder = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/FolderX/**", policy: "deny", id: "f1" }],
      },
    });
    // The ID-anchored glob rule targets f1's subtree.
    expect(await ac.getPolicy("d1", configWithFolder)).toBe("deny");
    // d2 is under f2 (also at /FolderX), so its path also matches.
    // No fail-closed behavior occurs since the ID is valid.
    expect(await ac.getPolicy("d2", configWithFolder)).toBe("deny");
  });
});
