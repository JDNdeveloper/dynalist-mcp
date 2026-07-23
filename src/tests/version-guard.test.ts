/**
 * Unit tests for the version guard module. Tests the guard in isolation
 * using a mock client that returns controlled version numbers.
 */

import { describe, test, expect } from "bun:test";
import { withVersionGuard, SyncTokenMismatchError } from "../version-guard";
import { DynalistApiError, type DynalistClient } from "../dynalist-client";
import { makeSyncToken } from "../sync-token";
import { DocumentStore } from "../document-store";

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
    // Mock client whose checkForUpdates returns versions from a fixed
    // sequence, one per call, to simulate a live document advancing across
    // several pre/post checks within and across batch members.
    function createSequencedClient(fileId: string, versions: number[]): MockClient {
      let call = 0;
      return {
        checkForUpdates: async (fileIds: string[]) => {
          const version = versions[Math.min(call, versions.length - 1)];
          call++;
          const out: Record<string, number> = {};
          if (fileIds.includes(fileId)) out[fileId] = version;
          return { versions: out };
        },
      };
    }

    test("defaults batchIndex to undefined, behaving like a plain equality check", async () => {
      const client = createMockClient({ preVersion: 5, postVersion: 6 });

      const guard = await withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5) },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );

      expect(guard.result).toBe("ok");
    });

    test("batch_index:0 behaves like a plain equality check", async () => {
      const client = createMockClient({ preVersion: 5, postVersion: 6 });

      const guard = await withVersionGuard(
        { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5), batchIndex: 0 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );

      expect(guard.result).toBe("ok");
    });

    test("second batch member succeeds when it matches the version recorded by the first", async () => {
      const store = new DocumentStore({} as never);
      const token = makeSyncToken("test_doc", 5);

      // First member: version 5 -> 8 (a single member spans multiple
      // internal /doc/edit calls, so it bumps by more than 1).
      const client1 = createSequencedClient("test_doc", [5, 8]);
      const first = await withVersionGuard(
        { client: client1, fileId: "test_doc", expectedSyncToken: token, batchIndex: 0, store },
        async () => ({ result: "first", apiCallCount: 3 }),
      );
      expect(first.result).toBe("first");

      // Second member: pre-write version must be 8, the version recorded
      // by the first member.
      const client2 = createSequencedClient("test_doc", [8, 9]);
      const second = await withVersionGuard(
        { client: client2, fileId: "test_doc", expectedSyncToken: token, batchIndex: 1, store },
        async () => ({ result: "second", apiCallCount: 1 }),
      );
      expect(second.result).toBe("second");
    });

    test("second batch member aborts if the live version does not match what the first member produced", async () => {
      const store = new DocumentStore({} as never);
      const token = makeSyncToken("test_doc", 5);

      const client1 = createSequencedClient("test_doc", [5, 6]);
      await withVersionGuard(
        { client: client1, fileId: "test_doc", expectedSyncToken: token, batchIndex: 0, store },
        async () => ({ result: "first", apiCallCount: 1 }),
      );

      // A concurrent edit landed between the two calls: live version is 9,
      // not the predicted 6.
      const client2 = createSequencedClient("test_doc", [9, 10]);
      await expect(
        withVersionGuard(
          { client: client2, fileId: "test_doc", expectedSyncToken: token, batchIndex: 1, store },
          async () => ({ result: "second", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("batch_index > 0 with no prior batch member recorded aborts with SyncTokenMismatchError", async () => {
      const store = new DocumentStore({} as never);
      const client = createMockClient({ preVersion: 6, postVersion: 7 });

      await expect(
        withVersionGuard(
          { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5), batchIndex: 1, store },
          async () => ({ result: "ok", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("batch_index > 0 with no store passed aborts with SyncTokenMismatchError", async () => {
      const client = createMockClient({ preVersion: 6, postVersion: 7 });

      await expect(
        withVersionGuard(
          { client, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 5), batchIndex: 1 },
          async () => ({ result: "ok", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("a detected conflict poisons the batch: the same still-valid checkpoint is rejected afterward", async () => {
      const store = new DocumentStore({} as never);
      const token = makeSyncToken("test_doc", 5);

      const client1 = createSequencedClient("test_doc", [5, 6]);
      await withVersionGuard(
        { client: client1, fileId: "test_doc", expectedSyncToken: token, batchIndex: 0, store },
        async () => ({ result: "first", apiCallCount: 1 }),
      );

      // A concurrent edit lands: live version is 9, not the predicted 6.
      // This call is rejected, and must also drop the recorded state.
      const client2 = createSequencedClient("test_doc", [9, 10]);
      await expect(
        withVersionGuard(
          { client: client2, fileId: "test_doc", expectedSyncToken: token, batchIndex: 1, store },
          async () => ({ result: "second", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);

      // A second call presenting the exact same batch_index:1 and token that
      // matched the pre-conflict checkpoint must still be rejected: the
      // conflict poisoned the batch, so there is no state left to match
      // against, independent of whatever live version this call sees.
      const client3 = createMockClient({ preVersion: 6, postVersion: 7 });
      await expect(
        withVersionGuard(
          { client: client3, fileId: "test_doc", expectedSyncToken: token, batchIndex: 1, store },
          async () => ({ result: "third", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("out-of-order batch_index (skipping ahead) aborts with SyncTokenMismatchError", async () => {
      const store = new DocumentStore({} as never);
      const token = makeSyncToken("test_doc", 5);

      const client1 = createSequencedClient("test_doc", [5, 6]);
      await withVersionGuard(
        { client: client1, fileId: "test_doc", expectedSyncToken: token, batchIndex: 0, store },
        async () => ({ result: "first", apiCallCount: 1 }),
      );

      // Next expected index is 1; jumping to 2 must be rejected even
      // though the live version happens to equal 7.
      const client2 = createSequencedClient("test_doc", [7, 8]);
      await expect(
        withVersionGuard(
          { client: client2, fileId: "test_doc", expectedSyncToken: token, batchIndex: 2, store },
          async () => ({ result: "second", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("batch_index:0 on a new document clears a stale batch state left by a prior interrupted batch", async () => {
      const store = new DocumentStore({} as never);
      const token = makeSyncToken("test_doc", 5);

      const client1 = createSequencedClient("test_doc", [5, 6]);
      await withVersionGuard(
        { client: client1, fileId: "test_doc", expectedSyncToken: token, batchIndex: 0, store },
        async () => ({ result: "first", apiCallCount: 1 }),
      );

      // Agent abandons the batch and starts a fresh one at batch_index:0.
      const freshToken = makeSyncToken("test_doc", 6);
      const client2 = createMockClient({ preVersion: 6, postVersion: 7 });
      const restarted = await withVersionGuard(
        { client: client2, fileId: "test_doc", expectedSyncToken: freshToken, batchIndex: 0, store },
        async () => ({ result: "restarted", apiCallCount: 1 }),
      );
      expect(restarted.result).toBe("restarted");

      // The abandoned batch's index 1 must no longer be honored.
      const client3 = createMockClient({ preVersion: 7, postVersion: 8 });
      await expect(
        withVersionGuard(
          { client: client3, fileId: "test_doc", expectedSyncToken: token, batchIndex: 1, store },
          async () => ({ result: "stale", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("a non-batch write clears in-progress batch state for the document", async () => {
      const store = new DocumentStore({} as never);
      const token = makeSyncToken("test_doc", 5);

      const client1 = createSequencedClient("test_doc", [5, 6]);
      await withVersionGuard(
        { client: client1, fileId: "test_doc", expectedSyncToken: token, batchIndex: 0, store },
        async () => ({ result: "first", apiCallCount: 1 }),
      );

      // A plain (non-batch) write against the live version clears state.
      const client2 = createMockClient({ preVersion: 6, postVersion: 7 });
      await withVersionGuard(
        { client: client2, fileId: "test_doc", expectedSyncToken: makeSyncToken("test_doc", 6), store },
        async () => ({ result: "plain", apiCallCount: 1 }),
      );

      const client3 = createMockClient({ preVersion: 7, postVersion: 8 });
      await expect(
        withVersionGuard(
          { client: client3, fileId: "test_doc", expectedSyncToken: token, batchIndex: 1, store },
          async () => ({ result: "stale", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });

    test("batch_index reused against a different document is rejected (state is keyed per-document)", async () => {
      const store = new DocumentStore({} as never);
      const token = makeSyncToken("doc_a", 5);

      const client1 = createSequencedClient("doc_a", [5, 6]);
      await withVersionGuard(
        { client: client1, fileId: "doc_a", expectedSyncToken: token, batchIndex: 0, store },
        async () => ({ result: "first", apiCallCount: 1 }),
      );

      // Reusing doc_a's token/batch_index against a different document: no
      // batch state was ever recorded for doc_b, so this is indistinguishable
      // from any other unmatched batch_index and gets the same message.
      const client2 = createMockClient({ preVersion: 6, postVersion: 7, fileId: "doc_b" });
      await expect(
        withVersionGuard(
          { client: client2, fileId: "doc_b", expectedSyncToken: token, batchIndex: 1, store },
          async () => ({ result: "second", apiCallCount: 1 }),
        ),
      ).rejects.toThrow(SyncTokenMismatchError);
    });
  });
});
