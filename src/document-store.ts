/**
 * Cached document reader. Wraps DynalistClient to avoid redundant
 * readDocument calls when the document version hasn't changed.
 *
 * LRU cache bounded to 5 entries. On read:
 *   - Cold miss (not cached): calls readDocument directly.
 *   - Warm hit (cached, version unchanged): calls checkForUpdates,
 *     returns cached response without a full read.
 *   - Warm miss (cached, version changed): calls checkForUpdates +
 *     readDocument, updates cache.
 */

import type { DynalistClient, ReadDocumentResponse } from "./dynalist-client";

const DEFAULT_CAPACITY = 5;

/**
 * Tracks the live version recorded after the most recently applied
 * member of a batch of writes sharing one expected_sync_token, so the
 * next member can be checked against the actual resulting version.
 */
export interface BatchState {
  expectedSyncToken: string;
  nextBatchIndex: number;
  expectedDocumentVersion: number;
}

export class DocumentStore {
  private client: Pick<DynalistClient, "readDocument" | "checkForUpdates">;
  private capacity: number;

  // Map preserves insertion order. MRU is at the end.
  private cache = new Map<string, ReadDocumentResponse>();

  // One in-flight batch per document at a time. A batch is superseded by
  // a fresh batch_index:0 call, cleared by a non-batch write, or left to
  // dangle harmlessly if the agent never finishes the sequence.
  private batchStates = new Map<string, BatchState>();

  constructor(client: Pick<DynalistClient, "readDocument" | "checkForUpdates">, capacity: number = DEFAULT_CAPACITY) {
    this.client = client;
    this.capacity = capacity;
  }

  /**
   * Read a document, returning a cached response when the version
   * hasn't changed. Callers should treat this as a drop-in replacement
   * for client.readDocument().
   */
  async read(fileId: string): Promise<ReadDocumentResponse> {
    const cached = this.cache.get(fileId);

    if (!cached) {
      // Cold miss: no checkForUpdates needed.
      const response = await this.client.readDocument(fileId);
      this.put(fileId, response);
      return structuredClone(response);
    }

    // Warm path: check if version changed.
    const check = await this.client.checkForUpdates([fileId]);
    const currentVersion = check.versions[fileId];

    if (currentVersion !== undefined && currentVersion === cached.version) {
      // Cache hit: promote to MRU and return.
      this.cache.delete(fileId);
      this.cache.set(fileId, cached);
      return structuredClone(cached);
    }

    // Version changed or file missing from response. Evict and fetch fresh.
    this.cache.delete(fileId);
    const response = await this.client.readDocument(fileId);
    this.put(fileId, response);
    return structuredClone(response);
  }

  /**
   * Invalidate a specific document's cache entry. Call after writes.
   */
  invalidate(fileId: string): void {
    this.cache.delete(fileId);
  }

  /**
   * Invalidate all cached entries.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Current batch state for a document, if a batch is in progress.
   */
  getBatchState(fileId: string): BatchState | undefined {
    return this.batchStates.get(fileId);
  }

  /**
   * Record the expected document version and next expected batch_index
   * after a batch member applies.
   */
  setBatchState(fileId: string, state: BatchState): void {
    this.batchStates.set(fileId, state);
  }

  /**
   * Clear batch state for a document. Called when a non-batch write
   * occurs or a new batch starts at batch_index:0.
   */
  clearBatchState(fileId: string): void {
    this.batchStates.delete(fileId);
  }

  private put(fileId: string, response: ReadDocumentResponse): void {
    // If the key already exists, delete and re-set to update LRU order
    // without triggering an unnecessary eviction.
    if (this.cache.has(fileId)) {
      this.cache.delete(fileId);
      this.cache.set(fileId, response);
      return;
    }

    // Evict LRU if at capacity.
    if (this.cache.size >= this.capacity) {
      const lruKey = this.cache.keys().next().value!;
      this.cache.delete(lruKey);
    }
    this.cache.set(fileId, response);
  }
}
