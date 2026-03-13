/**
 * Tests for the post-write checkForUpdates failure path in the version
 * guard. Verifies behavior when the write succeeds but the post-write
 * version check throws.
 */

import { describe, test, expect } from "bun:test";
import { withVersionGuard } from "../version-guard";
import { DynalistApiError, DynalistClient } from "../dynalist-client";

/**
 * Create a mock client where checkForUpdates succeeds on the first call
 * (pre-write) but throws on the second call (post-write).
 */
function createPostWriteFailureClient(opts: {
  preVersion: number;
  fileId?: string;
  postError?: Error;
}): DynalistClient {
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
  } as unknown as DynalistClient;
}

describe("withVersionGuard post-write checkForUpdates failure", () => {
  test("error propagates even though the write succeeded", async () => {
    const client = createPostWriteFailureClient({ preVersion: 5 });
    let writeExecuted = false;

    // The write function succeeds, but the post-write checkForUpdates
    // throws. The error propagates to the caller, meaning the write
    // result is lost even though the write itself completed.
    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedVersion: 5 },
        async () => {
          writeExecuted = true;
          return { result: "write-succeeded", apiCallCount: 1 };
        },
      ),
    ).rejects.toThrow(DynalistApiError);

    // Confirm the write did execute before the post-check failed.
    expect(writeExecuted).toBe(true);
  });

  test("the specific post-write error is preserved", async () => {
    const specificError = new DynalistApiError("TooManyRequests", "Rate limited on post-check.");
    const client = createPostWriteFailureClient({
      preVersion: 10,
      postError: specificError,
    });

    try {
      await withVersionGuard(
        { client, fileId: "test_doc", expectedVersion: 10 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );
      throw new Error("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DynalistApiError);
      expect((e as DynalistApiError).code).toBe("TooManyRequests");
    }
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

    try {
      await withVersionGuard(
        {
          client,
          fileId: "test_doc",
          expectedVersion: 5,
          store: mockStore as any,
        },
        async () => ({ result: "ok", apiCallCount: 1 }),
      );
    } catch {
      // Expected to throw from post-write check.
    }

    // The finally block in withVersionGuard should invalidate the
    // cache even when the post-write check throws.
    expect(invalidated).toBe(true);
  });

  test("non-DynalistApiError from post-write check also propagates", async () => {
    const client = createPostWriteFailureClient({
      preVersion: 5,
      postError: new Error("Network timeout"),
    });

    await expect(
      withVersionGuard(
        { client, fileId: "test_doc", expectedVersion: 5 },
        async () => ({ result: "ok", apiCallCount: 1 }),
      ),
    ).rejects.toThrow("Network timeout");
  });
});
