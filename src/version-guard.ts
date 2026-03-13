/**
 * Version guard for document writes. Wraps write operations with
 * pre-write and post-write version checks to detect race conditions.
 */

import { DynalistApiError, type DynalistClient } from "./dynalist-client";
import type { DocumentStore } from "./document-store";

export interface VersionGuardOptions {
  client: DynalistClient;
  fileId: string;
  expectedVersion: number;
  store?: DocumentStore;
}

export interface VersionGuardResult<T> {
  result: T;
  apiCallCount: number;
  preWriteVersion: number;
  postWriteVersion: number;
  versionWarning?: string;
}

/**
 * Execute a write operation with pre-write and post-write version checks.
 *
 * Pre-write: if the current document version differs from
 * expectedVersion, abort immediately with an error. This is the CAS
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
  const { client, fileId, expectedVersion, store } = options;

  // Pre-write: get current version.
  const preCheck = await client.checkForUpdates([fileId]);
  const preWriteVersion = preCheck.versions[fileId];
  if (preWriteVersion === undefined) {
    // checkForUpdates silently drops unknown file IDs. Surface this as
    // a NotFound error consistent with readDocument/editDocument behavior.
    throw new DynalistApiError("NotFound", "Document not found.");
  }

  // CAS check: abort if the document changed since the agent's last read.
  if (expectedVersion !== preWriteVersion) {
    throw new VersionMismatchError(
      `Document version mismatch: expected ${expectedVersion}, current is ${preWriteVersion}. ` +
      `Re-read the document before retrying.`,
    );
  }

  // Execute the guarded function (planning reads + write). The finally
  // block ensures the cache is invalidated even on partial failure (e.g.
  // PartialInsertError after some writes succeeded).
  try {
    const { result, apiCallCount } = await guardedFn();

    // Post-write: check for concurrent modifications.
    const postCheck = await client.checkForUpdates([fileId]);
    const postWriteVersion = postCheck.versions[fileId] ?? preWriteVersion;

    const actualDelta = postWriteVersion - preWriteVersion;
    let versionWarning: string | undefined;

    if (actualDelta !== apiCallCount) {
      versionWarning =
        `Write succeeded, but document version advanced by ${actualDelta} ` +
        `(expected ${apiCallCount}). Another edit may have occurred concurrently. ` +
        `Re-read the document and verify the result before making further changes.`;
    }

    return {
      result,
      apiCallCount,
      preWriteVersion,
      postWriteVersion,
      versionWarning,
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
 * Error thrown when the pre-write version check fails (stale expected_version).
 */
export class VersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionMismatchError";
  }
}
