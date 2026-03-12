import { describe, test, expect, beforeEach } from "bun:test";
import { AccessController, requireAccess, type Policy } from "../access-control";
import type { Config } from "../config";
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
});

// ─── AccessController.getPolicies (batch) ────────────────────────────

describe("AccessController.getPolicies", () => {
  test("batch evaluation returns correct policies", async () => {
    const { client } = setupServer();
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
});

// ─── ID-anchored rules ──────────────────────────────────────────────

describe("ID-anchored rules", () => {
  test("id-anchored rule uses resolved path", async () => {
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
    // ID anchoring resolves to the actual path.
    expect(await ac.getPolicy("ds", config)).toBe("deny");
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
});
