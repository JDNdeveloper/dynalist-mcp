/**
 * PersistentStore backed by a Durable Object's synchronous SQLite KV
 * storage. Values survive hibernation and restarts, which wipe the
 * object's memory between tool calls.
 */

import type { BatchState, FileTreeCacheEntry, PersistentStore } from "../persistent-store";

const BATCH_STATE_PREFIX = "batch-state:";
export const FILE_TREE_CACHE_KEY = "file-tree-cache";

export class DurableObjectPersistentStore implements PersistentStore {
  private kv: SyncKvStorage;

  constructor(kv: SyncKvStorage) {
    this.kv = kv;
  }

  getBatchState(fileId: string): BatchState | undefined {
    return this.kv.get<BatchState>(BATCH_STATE_PREFIX + fileId);
  }

  setBatchState(fileId: string, state: BatchState): void {
    this.kv.put(BATCH_STATE_PREFIX + fileId, state);
  }

  clearBatchState(fileId: string): void {
    this.kv.delete(BATCH_STATE_PREFIX + fileId);
  }

  getFileTreeCache(): FileTreeCacheEntry | undefined {
    // Storage uses structured clone, which preserves the Map in pathMap.
    return this.kv.get<FileTreeCacheEntry>(FILE_TREE_CACHE_KEY);
  }

  setFileTreeCache(entry: FileTreeCacheEntry): void {
    this.kv.put(FILE_TREE_CACHE_KEY, entry);
  }

  clearFileTreeCache(): void {
    this.kv.delete(FILE_TREE_CACHE_KEY);
  }
}
