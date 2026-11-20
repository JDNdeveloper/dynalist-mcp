/**
 * Storage for server state that must survive across requests. The stdio
 * server keeps it in process memory. The Cloudflare Worker keeps it in
 * Durable Object storage, because the object's memory is wiped whenever
 * it hibernates between tool calls.
 *
 * Every method is synchronous so the version guard and DocumentStore stay
 * synchronous on both platforms. Only state whose loss would change
 * behavior (batch state) or cost scarce API quota (the file tree cache)
 * belongs here.
 */

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

/**
 * Cached file ID to title-path map used by access control. The entry is
 * valid only while accessConfigHash matches the current access config
 * and fetchedAt is within the configured TTL.
 */
export interface FileTreeCacheEntry {
  fetchedAt: number;
  accessConfigHash: string;
  pathMap: Map<string, string>;
}

export interface PersistentStore {
  getBatchState(fileId: string): BatchState | undefined;
  setBatchState(fileId: string, state: BatchState): void;
  clearBatchState(fileId: string): void;
  getFileTreeCache(): FileTreeCacheEntry | undefined;
  setFileTreeCache(entry: FileTreeCacheEntry): void;
  clearFileTreeCache(): void;
}

/**
 * PersistentStore backed by process memory. State lives as long as the
 * process, which matches the stdio server's lifetime.
 */
export class InMemoryPersistentStore implements PersistentStore {
  private batchStates = new Map<string, BatchState>();
  private fileTreeCache: FileTreeCacheEntry | undefined;

  getBatchState(fileId: string): BatchState | undefined {
    return this.batchStates.get(fileId);
  }

  setBatchState(fileId: string, state: BatchState): void {
    this.batchStates.set(fileId, state);
  }

  clearBatchState(fileId: string): void {
    this.batchStates.delete(fileId);
  }

  getFileTreeCache(): FileTreeCacheEntry | undefined {
    return this.fileTreeCache;
  }

  setFileTreeCache(entry: FileTreeCacheEntry): void {
    this.fileTreeCache = entry;
  }

  clearFileTreeCache(): void {
    this.fileTreeCache = undefined;
  }
}
