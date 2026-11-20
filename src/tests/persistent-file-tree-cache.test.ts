import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { AccessController } from "../access-control";
import type { Config } from "../config";
import { InMemoryPersistentStore } from "../persistent-store";
import { DummyDynalistServer, MockDynalistClient } from "./dummy-server";

function makeConfig(rules: NonNullable<Config["access"]>["rules"]): Config {
  return {
    access: { default: "allow", rules },
    readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
    sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },
    cache: { ttlSeconds: 300 },
    logLevel: "warn",
  };
}

/**
 * Client that counts /file/list calls, the rate-limited endpoint the
 * persisted cache exists to avoid.
 */
class CountingClient extends MockDynalistClient {
  listFilesCalls = 0;

  override async listFiles() {
    this.listFilesCalls++;
    return super.listFiles();
  }
}

describe("persisted file tree cache", () => {
  let client: CountingClient;
  let persistent: InMemoryPersistentStore;
  const config = makeConfig([{ path: "/Private/**", policy: "deny" }]);

  beforeEach(() => {
    const server = new DummyDynalistServer();
    server.init();
    server.addFolder("fp", "Private", "root_folder");
    server.addDocument("ds", "Secret", "fp");
    server.addDocument("dp", "Public", "root_folder");
    client = new CountingClient(server);
    persistent = new InMemoryPersistentStore();
  });

  afterEach(() => {
    setSystemTime();
  });

  // A Durable Object builds a fresh AccessController after every
  // hibernation, so the cache must outlive the controller.
  test("reuses a persisted entry from a previous AccessController", async () => {
    await new AccessController(client, persistent).getPolicy("dp", config);
    expect(client.listFilesCalls).toBe(1);

    const policy = await new AccessController(client, persistent).getPolicy("dp", config);
    expect(policy).toBe("allow");
    expect(client.listFilesCalls).toBe(1);
  });

  test("ignores a persisted entry built under different access rules", async () => {
    await new AccessController(client, persistent).getPolicy("dp", config);

    const changed = makeConfig([{ path: "/Public", policy: "read" }]);
    const policy = await new AccessController(client, persistent).getPolicy("dp", changed);
    expect(policy).toBe("read");
    expect(client.listFilesCalls).toBe(2);
  });

  test("refetches once the persisted entry is older than the TTL", async () => {
    const start = new Date("2026-11-20T00:00:00Z");
    setSystemTime(start);
    await new AccessController(client, persistent).getPolicy("dp", config);

    setSystemTime(new Date(start.getTime() + 301_000));
    await new AccessController(client, persistent).getPolicy("dp", config);
    expect(client.listFilesCalls).toBe(2);
  });

  test("invalidateCache clears the persisted entry", async () => {
    const ac = new AccessController(client, persistent);
    await ac.getPolicy("dp", config);
    ac.invalidateCache();

    expect(persistent.getFileTreeCache()).toBeUndefined();
    await new AccessController(client, persistent).getPolicy("dp", config);
    expect(client.listFilesCalls).toBe(2);
  });
});
