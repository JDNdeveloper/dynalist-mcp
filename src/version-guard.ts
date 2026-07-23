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
  batchIndex?: number;
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
 *
 * batchIndex generalizes the CAS check across a sequence of calls that
 * share one expected_sync_token (see BATCH_INDEX_DESCRIPTION). A single
 * batch member's write can advance the live version by more than 1 (see
 * CHANGES_BATCH_SIZE in dynalist-client.ts and insertTreeUnderParent in
 * dynalist-helpers.ts), so later members are validated against actual
 * state (DocumentStore.getBatchState/setBatchState) rather than
 * arithmetic on batchIndex. batchIndex:0 or an omitted batchIndex resets
 * that state to start or bypass a batch.
 */
export async function withVersionGuard<T>(
  options: VersionGuardOptions,
  guardedFn: () => Promise<{ result: T; apiCallCount: number }>,
): Promise<VersionGuardResult<T>> {
  const { client, fileId, expectedSyncToken, batchIndex, store } = options;

  // Pre-write: get current version.
  const preCheck = await client.checkForUpdates([fileId]);
  const preWriteVersion = preCheck.versions[fileId];
  if (preWriteVersion === undefined) {
    // checkForUpdates silently drops unknown file IDs. Surface this as
    // a NotFound error consistent with readDocument/editDocument behavior.
    throw new DynalistApiError("NotFound", "Document not found.");
  }

  // Non-batch write, or the first member of a new batch: starting fresh
  // supersedes any stale in-progress batch for this document, so the old
  // state is cleared regardless of whether this call itself conflicts.
  const startingFresh = batchIndex === undefined || batchIndex === 0;
  if (startingFresh && store) store.clearBatchState(fileId);

  const state = startingFresh ? undefined : store?.getBatchState(fileId);
  const conflict = startingFresh
    ? expectedSyncToken !== makeSyncToken(fileId, preWriteVersion)
    // A later batch member must match the state recorded by the previous
    // member's call. Batch state is keyed by file_id, so this also catches
    // a batch_index reused against a different document (that document's
    // state simply never matches this file_id's lookup).
    : !state ||
      state.expectedSyncToken !== expectedSyncToken ||
      state.nextBatchIndex !== batchIndex ||
      state.expectedDocumentVersion !== preWriteVersion;

  if (conflict) {
    // Poison the batch: drop the state so no later call can resume it,
    // even one presenting a checkpoint that would otherwise still match.
    // No-op if there was nothing to drop.
    if (store) store.clearBatchState(fileId);

    throw new SyncTokenMismatchError(
      startingFresh
        ? "Sync token mismatch: the document has changed since your last read. " +
          "Re-read the document, check what changed, then retry."
        : "Sync token mismatch: batch_index " + batchIndex + " does not follow the " +
          "prior batch member for this document. Re-read the document, check what " +
          "changed, then retry.",
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

    // Record batch state for the next member, keyed off the actual
    // resulting version. Fall back to preWriteVersion + apiCallCount when
    // the post-write check failed, on the assumption no concurrent edit
    // occurred (the same assumption the syncWarning-less path above makes).
    if (store && batchIndex !== undefined) {
      store.setBatchState(fileId, {
        expectedSyncToken,
        nextBatchIndex: batchIndex + 1,
        expectedDocumentVersion: postWriteVersion ?? preWriteVersion + apiCallCount,
      });
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
