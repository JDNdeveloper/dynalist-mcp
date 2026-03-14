/**
 * Tests for the post-write checkForUpdates failure path in the version
 * guard. Verifies that when the write succeeds but the post-write
 * version check throws, the result is still returned with a warning.
 */

import { describe, test, expect } from "bun:test";
import { withVersionGuard } from "../version-guard";
import { DynalistApiError, type DynalistClient } from "../dynalist-client";

type MockClient = Pick<DynalistClient, "checkForUpdates">;

/**
 * Create a mock client where checkForUpdates succeeds on the first call
 * (pre-write) but throws on the second call (post-write).
 */
function createPostWriteFailureClient(opts: {
  preVersion: number;
  fileId?: string;
  postError?: Error;
}): MockClient {
  const fileId = opts.fileId ?? "test_doc";
  let callCount = 0;

  return {
    checkForUpdates: async (fileIds: string[]) => {
      callCount++;
      if (callCount === 1) {
        // Pre-write check succeeds.
        const versions: Record<string, number> = {};
        if (fileIds.includes(fileId)) {
          versions[fileId] = opts.preVersion;
        }
        return { versions };
      }
      // Post-write check fails.
      throw opts.postError ?? new DynalistApiError("TooManyRequests", "Rate limited.");
    },
  };
}

describe("withVersionGuard post-write checkForUpdates failure", () => {
  test("write result is returned with a version warning", async () => {
    const client = createPostWriteFailureClient({ preVersion: 5 });
    let writeExecuted = false;

    const guardResult = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 5 },
      async () => {
        writeExecuted = true;
        return { result: "write-succeeded", apiCallCount: 1 };
      },
    );

    // The write executed and the result was preserved.
    expect(writeExecuted).toBe(true);
    expect(guardResult.result).toBe("write-succeeded");
    expect(guardResult.apiCallCount).toBe(1);
    expect(guardResult.preWriteVersion).toBe(5);

    // Post-write version is undefined since the check failed.
    expect(guardResult.postWriteVersion).toBeUndefined();

    // A warning is present indicating the check failed.
    expect(guardResult.versionWarning).toBeDefined();
    expect(guardResult.versionWarning).toContain("post-write version check failed");
  });

  test("warning is present regardless of the error type", async () => {
    const specificError = new DynalistApiError("TooManyRequests", "Rate limited on post-check.");
    const client = createPostWriteFailureClient({
      preVersion: 10,
      postError: specificError,
    });

    const guardResult = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 10 },
      async () => ({ result: "ok", apiCallCount: 1 }),
    );

    expect(guardResult.result).toBe("ok");
    expect(guardResult.versionWarning).toBeDefined();
    expect(guardResult.versionWarning).toContain("post-write version check failed");
  });

  test("store is still invalidated despite post-write failure", async () => {
    const client = createPostWriteFailureClient({ preVersion: 5 });

    let invalidated = false;
    const mockStore = {
      invalidate: (fileId: string) => {
        if (fileId === "test_doc") {
          invalidated = true;
        }
      },
    };

    await withVersionGuard(
      {
        client,
        fileId: "test_doc",
        expectedVersion: 5,
        store: mockStore as unknown as import("../document-store").DocumentStore,
      },
      async () => ({ result: "ok", apiCallCount: 1 }),
    );

    // The finally block in withVersionGuard should invalidate the
    // cache even when the post-write check throws.
    expect(invalidated).toBe(true);
  });

  test("non-DynalistApiError from post-write check returns result with warning", async () => {
    const client = createPostWriteFailureClient({
      preVersion: 5,
      postError: new Error("Network timeout"),
    });

    const guardResult = await withVersionGuard(
      { client, fileId: "test_doc", expectedVersion: 5 },
      async () => ({ result: "ok", apiCallCount: 1 }),
    );

    expect(guardResult.result).toBe("ok");
    expect(guardResult.versionWarning).toBeDefined();
    expect(guardResult.versionWarning).toContain("post-write version check failed");
  });
});
