/**
 * Version guard for document writes. Wraps write operations with
 * pre-write and post-write version checks to detect race conditions.
 */

import { DynalistApiError, type DynalistClient } from "./dynalist-client";
import type { DocumentStore } from "./document-store";
import { makeSyncToken } from "./sync-token";
import { REREAD_GUIDANCE } from "./tools/descriptions";

export interface VersionGuardOptions {
  client: Pick<DynalistClient, "checkForUpdates">;
  fileId: string;
  expectedSyncToken: string;
  store?: DocumentStore;
}

export interface VersionGuardResult<T> {
  result: T;
  apiCallCount: number;
  preWriteVersion: number;
  // Undefined when the post-write version check failed (e.g. network
  // error). The write itself succeeded; the version is just unknown.
  postWriteVersion: number | undefined;
  syncWarning?: string;
}

/**
 * Execute a write operation with pre-write and post-write version checks.
 *
 * Pre-write: if the current document version differs from
 * expectedSyncToken, abort immediately with an error. This is the CAS
 * (compare-and-swap) mechanism for inter-turn race detection.
 *
 * Post-write: compare version delta against the number of API calls
 * made. A mismatch indicates a concurrent edit occurred during the
 * write window.
 */
export async function withVersionGuard<T>(
  options: VersionGuardOptions,
  guardedFn: () => Promise<{ result: T; apiCallCount: number }>,
): Promise<VersionGuardResult<T>> {
  const { client, fileId, expectedSyncToken, store } = options;

  // Pre-write: get current version.
  const preCheck = await client.checkForUpdates([fileId]);
  const preWriteVersion = preCheck.versions[fileId];
  if (preWriteVersion === undefined) {
    // checkForUpdates silently drops unknown file IDs. Surface this as
    // a NotFound error consistent with readDocument/editDocument behavior.
    throw new DynalistApiError("NotFound", "Document not found.");
  }

  // CAS check: abort if the document changed since the agent's last read.
  const currentToken = makeSyncToken(fileId, preWriteVersion);
  if (expectedSyncToken !== currentToken) {
    throw new SyncTokenMismatchError(
      "Sync token mismatch: the document has changed. " +
      "You MUST call read_document to get a fresh sync_token before retrying.",
    );
  }

  // Execute the guarded function (planning reads + write). The finally
  // block ensures the cache is invalidated even on partial failure (e.g.
  // PartialWriteError after some writes succeeded).
  try {
    const { result, apiCallCount } = await guardedFn();

    // Post-write: check for concurrent modifications. A failure here
    // must not discard the write result, since the write already succeeded.
    let postWriteVersion: number | undefined;
    let syncWarning: string | undefined;

    try {
      const postCheck = await client.checkForUpdates([fileId]);
      postWriteVersion = postCheck.versions[fileId] ?? preWriteVersion;

      const actualDelta = postWriteVersion - preWriteVersion;
      if (actualDelta !== apiCallCount) {
        syncWarning =
          "Write succeeded, but another edit may have occurred concurrently. " +
          REREAD_GUIDANCE;
      }
    } catch {
      // The write succeeded but the post-write version check failed.
      // Return the result with a warning instead of losing it.
      postWriteVersion = undefined;
      syncWarning =
        "Write succeeded, but the post-write check failed. " +
        REREAD_GUIDANCE;
    }

    return {
      result,
      apiCallCount,
      preWriteVersion,
      postWriteVersion,
      syncWarning,
    };
  } finally {
    // Invalidate cached document content. On success, the write changed
    // the document. On failure, partial writes may have occurred. Either
    // way, the cached version is potentially stale.
    if (store) {
      store.invalidate(fileId);
    }
  }
}

/**
 * Error thrown when the pre-write sync token check fails (stale expected_sync_token).
 */
export class SyncTokenMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncTokenMismatchError";
  }
}
