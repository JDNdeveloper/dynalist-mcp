/**
 * Unit tests for the version guard module. Tests the guard in isolation
 * using a mock client that returns controlled version numbers.
 */

import { describe, test, expect } from "bun:test";
import { withVersionGuard, SyncTokenMismatchError } from "../version-guard";
import { DynalistApiError, type DynalistClient } from "../dynalist-client";
import { makeSyncToken } from "../sync-token";

type MockClient = Pick<DynalistClient, "checkForUpdates">;

/**
 * Create a minimal mock client that returns controlled versions from
 * checkForUpdates. Only checkForUpdates is implemented; other methods
 * throw if called unexpectedly.
 */
function createMockClient(opts: {
  preVersion: number;
  postVersion: number;
  fileId?: string;
}): MockClient {
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
  };
}

describe("withVersionGuard", () => {
  test("passes when expectedSyncToken matches current version", async () => {
    const client = createMockClient({ preVersion: 5, postVersion: 6 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5) },
      async () => ({ result: "ok", apiCallCount: 1 }),
    );

    expect(guard.result).toBe("ok");
    expect(guard.preWriteVersion).toBe(5);
    expect(guard.postWriteVersion).toBe(6);
    expect(guard.syncWarning).toBeUndefined();
  });

  test("aborts with SyncTokenMismatchError when expectedSyncToken is stale", async () => {
    const client = createMockClient({ preVersion: 7, postVersion: 8 });
    let writeCalled = false;

    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5) },
        async () => {
          writeCalled = true;
          return { result: "ok", apiCallCount: 1 };
        },
      ),
    ).rejects.toThrow(SyncTokenMismatchError);

    // The write function must not have been called.
    expect(writeCalled).toBe(false);
  });

  test("aborts with SyncTokenMismatchError and includes mismatch info in message", async () => {
    const client = createMockClient({ preVersion: 7, postVersion: 8 });

    try {
      await withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5) },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );
      throw new Error("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SyncTokenMismatchError);
      const msg = (e as SyncTokenMismatchError).message;
      expect(msg).toContain("Sync token mismatch");
    }
  });

  test("detects concurrent edit when version delta exceeds apiCallCount", async () => {
    // Pre=10, post=13. With apiCallCount=1, delta=3 != 1.
    const client = createMockClient({ preVersion: 10, postVersion: 13 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 10) },
      async () => ({ result: "data", apiCallCount: 1 }),
    );

    expect(guard.result).toBe("data");
    expect(guard.syncWarning).toBeDefined();
  });

  test("clean write produces no warning when delta equals apiCallCount", async () => {
    const client = createMockClient({ preVersion: 10, postVersion: 13 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 10) },
      async () => ({ result: "data", apiCallCount: 3 }),
    );

    expect(guard.syncWarning).toBeUndefined();
  });

  test("detects unexpected delta when version advances less than apiCallCount", async () => {
    // Pre=10, post=11. With apiCallCount=3, delta=1 != 3.
    const client = createMockClient({ preVersion: 10, postVersion: 11 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 10) },
      async () => ({ result: "data", apiCallCount: 3 }),
    );

    expect(guard.syncWarning).toBeDefined();
  });

  test("propagates writeFn errors without running post-write check", async () => {
    let checkForUpdatesCallCount = 0;
    const client: MockClient = {
      checkForUpdates: async (fileIds: string[]) => {
        checkForUpdatesCallCount++;
        const versions: Record<string, number> = {};
        if (fileIds.includes("test_doc")) versions["test_doc"] = 5;
        return { versions };
      },
    };

    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5) },
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
    const client: MockClient = {
      checkForUpdates: async () => ({ versions: {} }),
    };

    await expect(
      withVersionGuard(
        { client, fileId: "nonexistent", expectedSyncToken: makeSyncToken("nonexistent", 1) },
        async () => ({ result: "ok", apiCallCount: 1 }),
      ),
    ).rejects.toThrow(DynalistApiError);

    try {
      await withVersionGuard(
        { client, fileId: "nonexistent", expectedSyncToken: makeSyncToken("nonexistent", 1) },
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
      { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 1) },
      async () => ({ result: "tree", apiCallCount: 4 }),
    );

    expect(guard.syncWarning).toBeUndefined();
    expect(guard.apiCallCount).toBe(4);
  });

  test("handles large version jump gracefully", async () => {
    const client = createMockClient({ preVersion: 100, postVersion: 200 });

    const guard = await withVersionGuard(
      { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 100) },
      async () => ({ result: "ok", apiCallCount: 1 }),
    );

    expect(guard.syncWarning).toBeDefined();
  });

  test("checkForUpdates failure propagates as error", async () => {
    const client: MockClient = {
      checkForUpdates: async () => {
        throw new DynalistApiError("TooManyRequests", "Rate limited.");
      },
    };

    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 1) },
        async () => ({ result: "ok", apiCallCount: 1 }),
      ),
    ).rejects.toThrow(DynalistApiError);
  });

  describe("batchIndex", () => {
    test("passes when live version equals expectedSyncToken's version plus batchIndex", async () => {
      // Token was issued at version 5. Two prior batch members have already
      // applied, so the live pre-write version is 7.
      const client = createMockClient({ preVersion: 7, postVersion: 8 });

      const guard = await withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5), batchIndex: 2 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );

      expect(guard.result).toBe("ok");
      expect(guard.preWriteVersion).toBe(7);
    });

    test("defaults batchIndex to 0, matching today's plain equality check", async () => {
      const client = createMockClient({ preVersion: 5, postVersion: 6 });

      const guard = await withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5) },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );

      expect(guard.result).toBe("ok");
    });

    test("aborts with SyncTokenMismatchError when live version does not account for batchIndex", async () => {
      // Token issued at version 5, batchIndex 2 implies live version should be
      // 7, but the live version is only 6 (one prior batch member missing).
      const client = createMockClient({ preVersion: 6, postVersion: 7 });

      await expect(
        withVersionGuard(
          { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5), batchIndex: 2 },
          async () => ({ result: "ok", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("aborts when batchIndex overshoots the live version (negative implied original version)", async () => {
      const client = createMockClient({ preVersion: 1, postVersion: 2 });

      await expect(
        withVersionGuard(
          { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 1), batchIndex: 5 },
          async () => ({ result: "ok", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });
  });
});
