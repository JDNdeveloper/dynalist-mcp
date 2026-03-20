import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AccessController, requireAccess } from "../access-control";
import { getConfig, ConfigError, type Config } from "../config";
import { DummyDynalistServer, MockDynalistClient } from "./dummy-server";

// ─── Test helpers ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
    sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },
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
    expect(requireAccess("allow", "read")).toBeNull();
    expect(requireAccess("allow", "write")).toBeNull();
  });

  test("read policy permits read but blocks write", () => {
    expect(requireAccess("read", "read")).toBeNull();
    const err = requireAccess("read", "write");
    expect(err).not.toBeNull();
    expect(err!.error).toBe("Forbidden");
  });

  test("deny policy blocks both read and write", () => {
    const readErr = requireAccess("deny", "read");
    expect(readErr).not.toBeNull();
    expect(readErr!.error).toBe("NotFound");

    const writeErr = requireAccess("deny", "write");
    expect(writeErr).not.toBeNull();
    expect(writeErr!.error).toBe("NotFound");
  });

  test("deny error message is generic (indistinguishable from NotFound)", () => {
    const err = requireAccess("deny", "read")!;
    expect(err.error).toBe("NotFound");
    expect(err.message).toBe("Document not found or access denied.");
  });

  test("Forbidden error message says 'read-only per access policy'", () => {
    const err = requireAccess("read", "write")!;
    expect(err.error).toBe("Forbidden");
    expect(err.message).toBe("Document is read-only per access policy.");
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

  test("single-level glob does not false-match a different folder with same-length path", async () => {
    const ac = new AccessController(client);
    // /Folder A/* must NOT match /Folder B/Doc C. Both prefixes are 9
    // characters, so a naive slice-based check would false-match.
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A/*", policy: "deny" }],
      },
    });
    // Doc C is under Folder B, not Folder A.
    expect(await ac.getPolicy("dc", config)).toBe("allow");
    // Doc A is under Folder A.
    expect(await ac.getPolicy("da", config)).toBe("deny");
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
  let _server: DummyDynalistServer;
  let client: MockDynalistClient;

  beforeEach(() => {
    ({ server: _server, client } = setupServer());
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
    expect(err.message).toContain("does not match its id");
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
    expect(err.message).toContain("does not match its id");
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
    expect(err.message).toContain("does not match its id");
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
    expect(err.message).toContain("does not match its id");
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
      writeAndLoad({ logLevel: "warn" });

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
      writeAndLoad({ logLevel: "debug" });

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

  test("duplicate titles in tree: non-ID-anchored rule throws ConfigError", async () => {
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
    // A path-only rule matching duplicate paths should fail validation.
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/FolderX/SameName", policy: "deny" }],
      },
    });

    await expect(ac.getPolicy("d1", config)).rejects.toThrow(ConfigError);
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
    // ID, validateRules skips the duplicate-title check entirely.
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/FolderX/SameName", policy: "deny", id: "d1" }],
      },
    });

    // Validation passes because ID-anchored rules are exempt from the
    // duplicate-title check. The rule matches d1's path.
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
    expect(await ac.getPolicy("d2", configWithFolder)).toBe("deny");
  });

  test("duplicate-title error does not reveal rule path or file IDs", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("f1", "SecretFolder", "root_folder");
    server.addFolder("f2", "SecretFolder", "root_folder");

    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/SecretFolder", policy: "deny" }],
      },
    });

    const err = await ac.getPolicy("f1", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).not.toContain("/SecretFolder");
    expect(err.message).not.toContain("f1");
    expect(err.message).not.toContain("f2");
  });
});

// ─── Slash escaping in paths ─────────────────────────────────────────

describe("slash escaping in paths", () => {
  test("folder with slash in title produces escaped path segment", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("slashf", "Q1/Q2 Review", "root_folder");
    server.addDocument("slashd", "Summary", "slashf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // The escaped path is /Q1\/Q2 Review/Summary.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Q1\\/Q2 Review/Summary", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("slashd", config)).toBe("allow");
  });

  test("document with slash in title produces escaped path segment", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("pf", "Projects", "root_folder");
    server.addDocument("slashd", "Q1/Q2 Report", "pf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Projects/Q1\\/Q2 Report", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("slashd", config)).toBe("allow");
  });

  test("slash-titled folder does not collide with nested folders of the same name parts", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Folder titled "A/B" (single folder with slash in name).
    server.addFolder("ab_slash", "A/B", "root_folder");
    server.addDocument("d_slash", "Doc", "ab_slash");
    // Folder "A" > subfolder "B" (two separate folders).
    server.addFolder("a_folder", "A", "root_folder");
    server.addFolder("b_folder", "B", "a_folder");
    server.addDocument("d_nested", "Doc", "b_folder");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Rule targets the escaped single-folder path. Should NOT match
    // the nested folder path /A/B/Doc.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/A\\/B/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("d_slash", config)).toBe("allow");
    expect(await ac.getPolicy("d_nested", config)).toBe("deny");
  });

  test("recursive glob on slash-escaped folder matches its descendants", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("slashf", "Work/Personal", "root_folder");
    server.addFolder("sub", "Sub", "slashf");
    server.addDocument("d1", "Doc1", "slashf");
    server.addDocument("d2", "Doc2", "sub");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Work\\/Personal/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("slashf", config)).toBe("allow");
    expect(await ac.getPolicy("d1", config)).toBe("allow");
    expect(await ac.getPolicy("d2", config)).toBe("allow");
  });

  test("single-level glob on slash-escaped folder matches direct children", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("slashf", "A/B", "root_folder");
    server.addFolder("sub", "Sub", "slashf");
    server.addDocument("d1", "Doc1", "slashf");
    server.addDocument("d2", "Doc2", "sub");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/A\\/B/*", policy: "allow" }],
      },
    });
    // Direct children match.
    expect(await ac.getPolicy("d1", config)).toBe("allow");
    expect(await ac.getPolicy("sub", config)).toBe("allow");
    // The folder itself and deeper descendants do not.
    expect(await ac.getPolicy("slashf", config)).toBe("deny");
    expect(await ac.getPolicy("d2", config)).toBe("deny");
  });

  test("exact-match rule on slash-escaped document matches only that document", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("pf", "Projects", "root_folder");
    server.addDocument("d_slash", "A/B", "pf");
    server.addDocument("d_other", "Other", "pf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Projects/A\\/B", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("d_slash", config)).toBe("allow");
    expect(await ac.getPolicy("d_other", config)).toBe("deny");
  });

  test("title with backslash is double-escaped and does not collide with slash-escaped title", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Title "A\B" contains a literal backslash. Escaped: A\\B.
    server.addFolder("bs", "A\\B", "root_folder");
    server.addDocument("d_bs", "Doc", "bs");
    // Title "A/B" contains a literal slash. Escaped: A\/B.
    server.addFolder("sl", "A/B", "root_folder");
    server.addDocument("d_sl", "Doc", "sl");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Target backslash folder (A\\B in the rule).
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/A\\\\B/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("d_bs", config)).toBe("allow");
    expect(await ac.getPolicy("d_sl", config)).toBe("deny");
  });

  test("recursive glob does not false-positive on escaped slash after prefix", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Folder titled "A/B" (escaped path: /A\/B).
    server.addFolder("ab_slash", "A/B", "root_folder");
    server.addDocument("d1", "Doc", "ab_slash");
    // Also create a folder "A" so the rule /A/** is valid.
    server.addFolder("a_folder", "A", "root_folder");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Rule /A/** should match descendants of folder "A", NOT folder "A/B".
    // The path /A\/B starts with /A but the next char is \, not /.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/A/**", policy: "allow" }],
      },
    });
    // Folder "A" itself matches /A/**.
    expect(await ac.getPolicy("a_folder", config)).toBe("allow");
    // Folder "A/B" should NOT match /A/** because the "/" after "A" is escaped.
    expect(await ac.getPolicy("ab_slash", config)).toBe("deny");
    expect(await ac.getPolicy("d1", config)).toBe("deny");
  });

  test("single-level glob correctly handles child with slash in title", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("pf", "Parent", "root_folder");
    // Child document with a slash in its title.
    server.addDocument("child_slash", "X/Y", "pf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // /Parent/* should match /Parent/X\/Y because X\/Y is a single
    // escaped segment (no unescaped slash).
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Parent/*", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("child_slash", config)).toBe("allow");
  });

  test("title with asterisk is escaped and does not trigger interior glob rejection", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("pf", "Projects", "root_folder");
    server.addDocument("star_doc", "Important*", "pf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // The escaped path is /Projects/Important\*. The rule uses the
    // same escaping so the \* is a literal asterisk, not a glob.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Projects/Important\\*", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("star_doc", config)).toBe("allow");
  });

  test("recursive glob on folder with asterisk in title works", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("starf", "A*B", "root_folder");
    server.addDocument("d1", "Doc", "starf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/A\\*B/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("starf", config)).toBe("allow");
    expect(await ac.getPolicy("d1", config)).toBe("allow");
  });

  test("unescaped asterisk in rule path still triggers interior glob rejection", async () => {
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
});

// ─── Dangling backslash validation ───────────────────────────────────

describe("dangling backslash validation", () => {
  test("rule path with dangling backslash before /** throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        // After stripping /**, base is "/Folder A\" which has a dangling \.
        rules: [{ path: "/Folder A\\/**", policy: "deny" }],
      },
    });
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("rule path with dangling backslash before /* throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A\\/*", policy: "deny" }],
      },
    });
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("rule path with dangling backslash at end (no glob) throws ConfigError", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Folder A\\", policy: "deny" }],
      },
    });
    await expect(ac.getPolicy("da", config)).rejects.toThrow(ConfigError);
  });

  test("rule path ending in escaped backslash (\\\\) does NOT have a dangling backslash", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Folder titled "A\" (literal backslash). Escaped: A\\.
    server.addFolder("bsf", "A\\", "root_folder");
    server.addDocument("d1", "Doc", "bsf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Rule path /A\\/** has base /A\\, which ends in \\ (even count).
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/A\\\\/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("bsf", config)).toBe("allow");
    expect(await ac.getPolicy("d1", config)).toBe("allow");
  });

  test("dangling backslash error does not reveal rule path", async () => {
    const { client } = setupServer();
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Secret\\/**", policy: "deny" }],
      },
    });
    const err = await ac.getPolicy("da", config).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).not.toContain("/Secret");
  });
});

// ─── Empty title handling ────────────────────────────────────────────

describe("empty title handling", () => {
  test("empty-titled root child is excluded from path map and gets default policy", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("empty_f", "", "root_folder");
    server.addDocument("normal_d", "Normal", "root_folder");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Normal", policy: "allow" }],
      },
    });
    // Empty-titled folder is not in pathMap, so it gets default (deny).
    expect(await ac.getPolicy("empty_f", config)).toBe("deny");
    expect(await ac.getPolicy("normal_d", config)).toBe("allow");
  });

  test("empty-titled nested folder is excluded along with its descendants", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("parent", "Parent", "root_folder");
    server.addFolder("empty_child", "", "parent");
    server.addDocument("deep_doc", "Deep", "empty_child");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Parent/**", policy: "allow" }],
      },
    });
    // Parent itself is accessible.
    expect(await ac.getPolicy("parent", config)).toBe("allow");
    // Empty-titled child and its descendants are excluded from pathMap.
    expect(await ac.getPolicy("empty_child", config)).toBe("deny");
    expect(await ac.getPolicy("deep_doc", config)).toBe("deny");
  });

  test("empty-titled file with allow default gets allow", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addDocument("empty_d", "", "root_folder");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "allow",
        rules: [],
      },
    });
    // Not in pathMap, so gets default (allow).
    expect(await ac.getPolicy("empty_d", config)).toBe("allow");
  });
});

// ─── Unicode normalization ───────────────────────────────────────────

describe("Unicode normalization", () => {
  // e-acute as a single code point (NFC) vs decomposed (NFD).
  const NFC_TITLE = "R\u00e9sum\u00e9";
  const NFD_TITLE = "Re\u0301sume\u0301";

  test("NFD title matches NFC rule path", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Dynalist stores the title in NFD form.
    server.addFolder("pf", "Work", "root_folder");
    server.addDocument("nfd_doc", NFD_TITLE, "pf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Rule uses NFC form (the natural form when typing in most editors).
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: `/Work/${NFC_TITLE}`, policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("nfd_doc", config)).toBe("allow");
  });

  test("NFC title matches NFD rule path", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("pf", "Work", "root_folder");
    server.addDocument("nfc_doc", NFC_TITLE, "pf");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Rule uses NFD form.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: `/Work/${NFD_TITLE}`, policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("nfc_doc", config)).toBe("allow");
  });

  test("NFD folder title with recursive glob matches descendants", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("nfd_f", NFD_TITLE, "root_folder");
    server.addDocument("d1", "Doc", "nfd_f");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: `/${NFC_TITLE}/**`, policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("nfd_f", config)).toBe("allow");
    expect(await ac.getPolicy("d1", config)).toBe("allow");
  });
});

// ─── Whitespace in titles ────────────────────────────────────────────

describe("whitespace in titles", () => {
  test("title with leading space does not match rule without space (fail-closed)", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("sp_f", " Work", "root_folder");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Rule omits the leading space. Validation fails because /Work
    // does not match any file (actual path is / Work).
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Work/**", policy: "deny" }],
      },
    });
    await expect(ac.getPolicy("sp_f", config)).rejects.toThrow(ConfigError);
  });

  test("title with leading space matches rule with leading space", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("sp_f", " Work", "root_folder");
    server.addDocument("d1", "Doc", "sp_f");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Rule includes the leading space. Path matches.
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/ Work/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("sp_f", config)).toBe("allow");
    expect(await ac.getPolicy("d1", config)).toBe("allow");
  });
});

// ─── Combined special characters ─────────────────────────────────────

describe("combined special characters in titles", () => {
  test("title with all three special characters (slash, backslash, asterisk)", async () => {
    const server = new DummyDynalistServer();
    server.init();
    // Title "A/B\\C*D" contains all three escaped characters.
    server.addFolder("combo", "A/B\\C*D", "root_folder");
    server.addDocument("d1", "Doc", "combo");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // Escaped path: A\/B\\C\*D. In a JS string the rule path is:
    // "/A\\/B\\\\C\\*D/**" (each \ doubled for JS, then for escaping).
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/A\\/B\\\\C\\*D/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("combo", config)).toBe("allow");
    expect(await ac.getPolicy("d1", config)).toBe("allow");
  });
});

// ─── Duplicate titles within a glob subtree ──────────────────────────

describe("duplicate titles within a glob subtree", () => {
  test("glob rule applies uniformly to duplicate-path files in its subtree", async () => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("fa", "Folder", "root_folder");
    // Two subfolders with the same name, creating duplicate paths.
    server.addFolder("sub1", "Sub", "fa");
    server.addFolder("sub2", "Sub", "fa");
    server.addDocument("d1", "Doc", "sub1");
    server.addDocument("d2", "Doc", "sub2");
    const client = new MockDynalistClient(server);
    const ac = new AccessController(client);

    // The glob rule covers the entire subtree. Duplicate paths within
    // the subtree do not cause ambiguity because the policy is uniform.
    // No validation error is raised (the duplicate check only applies
    // to the rule's base path, not paths within its scope).
    const config = makeConfig({
      access: {
        default: "deny",
        rules: [{ path: "/Folder/**", policy: "allow" }],
      },
    });
    expect(await ac.getPolicy("fa", config)).toBe("allow");
    expect(await ac.getPolicy("d1", config)).toBe("allow");
    expect(await ac.getPolicy("d2", config)).toBe("allow");
  });
});

// ─── Fail-closed when getPathMap fails ────────────────────────────────

describe("fail-closed on listFiles error", () => {
  test("getPolicy returns deny when listFiles throws a generic Error", async () => {
    // Create a mock client whose listFiles always throws.
    const failingClient = new MockDynalistClient(new DummyDynalistServer());
    failingClient.listFiles = () => {
      throw new Error("Network failure");
    };
    const ac = new AccessController(failingClient);

    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/Anything", policy: "allow" }],
      },
    });

    // Despite default: "allow", the controller should deny because
    // it cannot resolve the file tree.
    expect(await ac.getPolicy("any-file-id", config)).toBe("deny");
  });

  test("getPolicies returns deny for all IDs when listFiles throws", async () => {
    const failingClient = new MockDynalistClient(new DummyDynalistServer());
    failingClient.listFiles = () => {
      throw new Error("Connection refused");
    };
    const ac = new AccessController(failingClient);

    const config = makeConfig({
      access: {
        default: "allow",
        rules: [],
      },
    });

    const policies = await ac.getPolicies(["id1", "id2"], config);
    expect(policies.get("id1")).toBe("deny");
    expect(policies.get("id2")).toBe("deny");
  });
});

// ─── Root-level globs (/* and /**) ───────────────────────────────────
//
// NOTE: The bare glob shorthand (path: "*" and "**") is tested in
// config.test.ts where the Zod transform is exercised. These tests
// verify the canonical form behaves correctly in access control.

describe("root-level globs /* and /**", () => {
  let client: MockDynalistClient;

  beforeEach(() => {
    ({ client } = setupServer());
  });

  test("/** matches all files recursively", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/**", policy: "deny" }],
      },
    });
    // Every file should be denied.
    expect(await ac.getPolicy("da", config)).toBe("deny");
    expect(await ac.getPolicy("ds", config)).toBe("deny");
    expect(await ac.getPolicy("fa", config)).toBe("deny");
  });

  test("/* matches only direct children of root", async () => {
    const ac = new AccessController(client);
    const config = makeConfig({
      access: {
        default: "allow",
        rules: [{ path: "/*", policy: "deny" }],
      },
    });
    // Top-level folders are direct children of root.
    expect(await ac.getPolicy("fa", config)).toBe("deny");
    expect(await ac.getPolicy("fb", config)).toBe("deny");
    // Documents nested inside folders are not direct children of root.
    expect(await ac.getPolicy("da", config)).toBe("allow");
    expect(await ac.getPolicy("ds", config)).toBe("allow");
  });
});
