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

export class DocumentStore {
  private client: DynalistClient;
  private capacity: number;

  // Map preserves insertion order. MRU is at the end.
  private cache = new Map<string, ReadDocumentResponse>();

  constructor(client: DynalistClient, capacity: number = DEFAULT_CAPACITY) {
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

  private put(fileId: string, response: ReadDocumentResponse): void {
    // Evict LRU if at capacity.
    if (this.cache.size >= this.capacity) {
      const lruKey = this.cache.keys().next().value!;
      this.cache.delete(lruKey);
    }
    this.cache.set(fileId, response);
  }
}
