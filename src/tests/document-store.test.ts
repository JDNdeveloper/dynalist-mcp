/**
 * Unit tests for DocumentStore.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { DocumentStore } from "../document-store";
import type { ReadDocumentResponse, CheckForUpdatesResponse } from "../dynalist-client";

/**
 * Minimal mock client that tracks call counts for readDocument and
 * checkForUpdates. Documents are stored in a simple map.
 */
class SpyClient {
  readDocumentCount = 0;
  checkForUpdatesCount = 0;

  docs = new Map<string, { version: number; title: string }>();

  addDoc(fileId: string, version: number, title: string = "Doc"): void {
    this.docs.set(fileId, { version, title });
  }

  setVersion(fileId: string, version: number): void {
    const doc = this.docs.get(fileId);
    if (doc) doc.version = version;
  }

  async readDocument(fileId: string): Promise<ReadDocumentResponse> {
    this.readDocumentCount++;
    const doc = this.docs.get(fileId);
    if (!doc) throw new Error(`Not found: ${fileId}`);
    return {
      file_id: fileId,
      title: doc.title,
      version: doc.version,
      nodes: [],
    };
  }

  async checkForUpdates(fileIds: string[]): Promise<CheckForUpdatesResponse> {
    this.checkForUpdatesCount++;
    const versions: Record<string, number> = {};
    for (const id of fileIds) {
      const doc = this.docs.get(id);
      if (doc) versions[id] = doc.version;
    }
    return { versions };
  }
}

describe("DocumentStore", () => {
  let spy: SpyClient;
  let store: DocumentStore;

  beforeEach(() => {
    spy = new SpyClient();
    spy.addDoc("d1", 1, "Doc 1");
    spy.addDoc("d2", 1, "Doc 2");
    spy.addDoc("d3", 1, "Doc 3");
    store = new DocumentStore(spy);
  });

  test("cold miss calls readDocument, not checkForUpdates", async () => {
    const result = await store.read("d1");

    expect(result.file_id).toBe("d1");
    expect(result.version).toBe(1);
    expect(spy.readDocumentCount).toBe(1);
    expect(spy.checkForUpdatesCount).toBe(0);
  });

  test("cache hit returns cached response without readDocument", async () => {
    await store.read("d1");
    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    const result = await store.read("d1");

    expect(result.file_id).toBe("d1");
    expect(result.version).toBe(1);
    expect(spy.checkForUpdatesCount).toBe(1);
    expect(spy.readDocumentCount).toBe(0);
  });

  test("version change triggers fresh readDocument", async () => {
    await store.read("d1");
    spy.setVersion("d1", 2);
    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    const result = await store.read("d1");

    expect(result.version).toBe(2);
    expect(spy.checkForUpdatesCount).toBe(1);
    expect(spy.readDocumentCount).toBe(1);
  });

  test("explicit invalidate makes next read a cold miss", async () => {
    await store.read("d1");
    store.invalidate("d1");
    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    await store.read("d1");

    // Cold miss: readDocument called, no checkForUpdates.
    expect(spy.readDocumentCount).toBe(1);
    expect(spy.checkForUpdatesCount).toBe(0);
  });

  test("invalidateAll clears all entries", async () => {
    await store.read("d1");
    await store.read("d2");
    store.invalidateAll();
    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    await store.read("d1");
    await store.read("d2");

    // Both are cold misses.
    expect(spy.readDocumentCount).toBe(2);
    expect(spy.checkForUpdatesCount).toBe(0);
  });

  test("LRU eviction at capacity", async () => {
    // Capacity 3 for easy testing.
    store = new DocumentStore(spy, 3);

    await store.read("d1");
    await store.read("d2");
    await store.read("d3");

    // d1 is LRU. Adding d4 should evict it.
    spy.addDoc("d4", 1, "Doc 4");
    await store.read("d4");

    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    // d1 should be a cold miss (evicted).
    await store.read("d1");
    expect(spy.readDocumentCount).toBe(1);
    expect(spy.checkForUpdatesCount).toBe(0);
  });

  test("LRU eviction respects access recency", async () => {
    store = new DocumentStore(spy, 3);

    await store.read("d1");
    await store.read("d2");
    await store.read("d3");

    // Touch d1 to make it MRU.
    await store.read("d1");

    // Adding d4 should evict d2 (now LRU), not d1.
    spy.addDoc("d4", 1, "Doc 4");
    await store.read("d4");

    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    // d1 should be a cache hit.
    await store.read("d1");
    expect(spy.checkForUpdatesCount).toBe(1);
    expect(spy.readDocumentCount).toBe(0);

    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    // d2 should be a cold miss (evicted).
    await store.read("d2");
    expect(spy.readDocumentCount).toBe(1);
    expect(spy.checkForUpdatesCount).toBe(0);
  });

  test("invalidate on non-cached entry is a no-op", () => {
    // Should not throw.
    store.invalidate("nonexistent");
  });

  test("checkForUpdates missing file ID triggers fresh read", async () => {
    await store.read("d1");

    // Simulate the file being deleted from the API (checkForUpdates
    // silently drops unknown IDs).
    spy.docs.delete("d1");
    spy.addDoc("d1", 5, "Doc 1 Recreated");

    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    const result = await store.read("d1");

    expect(result.version).toBe(5);
    expect(spy.checkForUpdatesCount).toBe(1);
    expect(spy.readDocumentCount).toBe(1);
  });

  test("readDocument throw on cold miss leaves cache empty", async () => {
    spy.docs.delete("d1");

    await expect(store.read("d1")).rejects.toThrow();

    // Re-add the doc. Next read should be a cold miss (no stale entry).
    spy.addDoc("d1", 10, "Recovered");
    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    const result = await store.read("d1");
    expect(result.version).toBe(10);
    expect(spy.readDocumentCount).toBe(1);
    expect(spy.checkForUpdatesCount).toBe(0);
  });

  test("readDocument throw on warm miss evicts stale entry", async () => {
    await store.read("d1");

    // Bump version so warm path triggers a re-fetch.
    spy.setVersion("d1", 2);

    // Make the re-fetch throw.
    const originalRead = spy.readDocument.bind(spy);
    let throwOnNext = true;
    spy.readDocument = async (fileId: string) => {
      if (throwOnNext) {
        throwOnNext = false;
        throw new Error("Simulated failure");
      }
      return originalRead(fileId);
    };

    await expect(store.read("d1")).rejects.toThrow("Simulated failure");

    // The stale entry should have been evicted. Next read is a cold miss.
    spy.readDocumentCount = 0;
    spy.checkForUpdatesCount = 0;

    const result = await store.read("d1");
    expect(result.version).toBe(2);
    expect(spy.readDocumentCount).toBe(1);
    expect(spy.checkForUpdatesCount).toBe(0);
  });
});
