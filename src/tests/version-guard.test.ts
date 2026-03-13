/**
 * Unit tests for the version guard module. Tests the guard in isolation
 * using a mock client that returns controlled version numbers.
 */

import { describe, test, expect } from "bun:test";
import { withVersionGuard, VersionMismatchError } from "../version-guard";
import { DynalistApiError, DynalistClient } from "../dynalist-client";

/**
 * Create a minimal mock client that returns controlled versions from
 * checkForUpdates. Only checkForUpdates is implemented; other methods
 * throw if called unexpectedly.
 */
function createMockClient(opts: {
  preVersion: number;
  postVersion: number;
  fileId?: string;
}): DynalistClient {
  const fileId = opts.fileId ?? "test_doc";
  let callCount = 0;

  return {
    checkForUpdates: async (fileIds: string[]) => {
      callCount++;
      const versions: Record<string, number> = {};
      if (fileIds.includes(fileId)) {
        versions[fileId] = callCount === 1 ? opts.preVersion : opts.postVersion;
      }
      return { versions };
    },
  } as unknown as DynalistClient;
}

describe("withVersionGuard", () => {
  test("passes when expectedVersion matches current version", async () => {
    const client = createMockClient({ preVersion: 5, postVersion: 6 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 5 },
      async () => ({ result: "ok", apiCallCount: 1 }),
    );

    expect(guard.result).toBe("ok");
    expect(guard.preWriteVersion).toBe(5);
    expect(guard.postWriteVersion).toBe(6);
    expect(guard.versionWarning).toBeUndefined();
  });

  test("aborts with VersionMismatchError when expectedVersion is stale", async () => {
    const client = createMockClient({ preVersion: 7, postVersion: 8 });
    let writeCalled = false;

    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedVersion: 5 },
        async () => {
          writeCalled = true;
          return { result: "ok", apiCallCount: 1 };
        },
      ),
    ).rejects.toThrow(VersionMismatchError);

    // The write function must not have been called.
    expect(writeCalled).toBe(false);
  });

  test("aborts with VersionMismatchError and includes version info in message", async () => {
    const client = createMockClient({ preVersion: 7, postVersion: 8 });

    try {
      await withVersionGuard(
        { client, fileId: "test_doc", expectedVersion: 5 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );
      throw new Error("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VersionMismatchError);
      const msg = (e as VersionMismatchError).message;
      expect(msg).toContain("expected 5");
      expect(msg).toContain("current is 7");
    }
  });

  test("detects concurrent edit when version delta exceeds apiCallCount", async () => {
    // Pre=10, post=13. With apiCallCount=1, delta=3 != 1.
    const client = createMockClient({ preVersion: 10, postVersion: 13 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 10 },
      async () => ({ result: "data", apiCallCount: 1 }),
    );

    expect(guard.result).toBe("data");
    expect(guard.versionWarning).toBeDefined();
    expect(guard.versionWarning).toContain("advanced by 3");
    expect(guard.versionWarning).toContain("expected 1");
  });

  test("clean write produces no warning when delta equals apiCallCount", async () => {
    const client = createMockClient({ preVersion: 10, postVersion: 13 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 10 },
      async () => ({ result: "data", apiCallCount: 3 }),
    );

    expect(guard.versionWarning).toBeUndefined();
  });

  test("detects unexpected delta when version advances less than apiCallCount", async () => {
    // Pre=10, post=11. With apiCallCount=3, delta=1 != 3.
    const client = createMockClient({ preVersion: 10, postVersion: 11 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 10 },
      async () => ({ result: "data", apiCallCount: 3 }),
    );

    expect(guard.versionWarning).toBeDefined();
    expect(guard.versionWarning).toContain("advanced by 1");
    expect(guard.versionWarning).toContain("expected 3");
  });

  test("propagates writeFn errors without running post-write check", async () => {
    let checkForUpdatesCallCount = 0;
    const client = {
      checkForUpdates: async (fileIds: string[]) => {
        checkForUpdatesCallCount++;
        const versions: Record<string, number> = {};
        if (fileIds.includes("test_doc")) versions["test_doc"] = 5;
        return { versions };
      },
    } as unknown as DynalistClient;

    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedVersion: 5 },
        async () => {
          throw new Error("write failed");
        },
      ),
    ).rejects.toThrow("write failed");

    // Only the pre-write check should have been called, not the post-write.
    expect(checkForUpdatesCallCount).toBe(1);
  });

  test("throws DynalistApiError NotFound for nonexistent document", async () => {
    // Client returns empty versions (simulates checkForUpdates dropping unknown IDs).
    const client = {
      checkForUpdates: async () => ({ versions: {} }),
    } as unknown as DynalistClient;

    await expect(
      withVersionGuard(
        { client, fileId: "nonexistent", expectedVersion: 1 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      ),
    ).rejects.toThrow(DynalistApiError);

    try {
      await withVersionGuard(
        { client, fileId: "nonexistent", expectedVersion: 1 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );
    } catch (e) {
      expect((e as DynalistApiError).code).toBe("NotFound");
    }
  });

  test("handles multi-batch write with correct total apiCallCount", async () => {
    // Simulate a write that makes 4 API calls (e.g. 4-level tree insert).
    const client = createMockClient({ preVersion: 1, postVersion: 5 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 1 },
      async () => ({ result: "tree", apiCallCount: 4 }),
    );

    expect(guard.versionWarning).toBeUndefined();
    expect(guard.apiCallCount).toBe(4);
  });

  test("handles large version jump gracefully", async () => {
    const client = createMockClient({ preVersion: 100, postVersion: 200 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 100 },
      async () => ({ result: "ok", apiCallCount: 1 }),
    );

    expect(guard.versionWarning).toBeDefined();
    expect(guard.versionWarning).toContain("advanced by 100");
  });

  test("checkForUpdates failure propagates as error", async () => {
    const client = {
      checkForUpdates: async () => {
        throw new DynalistApiError("TooManyRequests", "Rate limited.");
      },
    } as unknown as DynalistClient;

    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedVersion: 1 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      ),
    ).rejects.toThrow(DynalistApiError);
  });
});
