/**
 * Unit tests for DynalistClient.editDocument batching logic.
 * Mocks the protected `request` method to avoid HTTP calls and verify
 * that large change sets are split into correct batches.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { DynalistClient, type EditDocumentChange, type EditDocumentResponse } from "../dynalist-client";

/**
 * Create a DynalistClient with the internal `request` method replaced
 * by a spy. The spy records each call and returns a canned response.
 */
function createClientWithMockedRequest() {
  const client = new DynalistClient("fake-token");

  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let nodeCounter = 0;

  // Replace the protected `request` method with a controlled fake.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).request = async (endpoint: string, body: Record<string, unknown>) => {
    calls.push({ endpoint, body });

    // Count inserts in this batch to generate the right number of new_node_ids.
    const changes = (body.changes ?? []) as EditDocumentChange[];
    const insertCount = changes.filter((c) => c.action === "insert").length;

    const ids = [];
    for (let i = 0; i < insertCount; i++) {
      ids.push(`generated_${++nodeCounter}`);
    }

    return {
      _code: "ok",
      new_node_ids: ids,
    } as Pick<EditDocumentResponse, "new_node_ids">;
  };

  return { client, calls };
}

/**
 * Generate N edit changes for testing batch splitting.
 */
function makeChanges(n: number, action: "edit" | "insert" = "edit"): EditDocumentChange[] {
  const changes: EditDocumentChange[] = [];
  for (let i = 0; i < n; i++) {
    if (action === "edit") {
      changes.push({ action: "edit", node_id: `node_${i}`, content: `content ${i}` });
    } else {
      changes.push({ action: "insert", parent_id: "root", content: `item ${i}` });
    }
  }
  return changes;
}

describe("DynalistClient.editDocument batching", () => {
  let client: DynalistClient;
  let calls: Array<{ endpoint: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    const setup = createClientWithMockedRequest();
    client = setup.client;
    calls = setup.calls;
  });

  test("sends a single request when changes fit within batch size", async () => {
    const changes = makeChanges(100);
    const result = await client.editDocument("doc_1", changes);

    expect(calls).toHaveLength(1);
    expect(result.batches_sent).toBe(1);

    // The single request should contain all 100 changes.
    const sentChanges = calls[0].body.changes as EditDocumentChange[];
    expect(sentChanges).toHaveLength(100);
  });

  test("sends a single request for exactly 200 changes", async () => {
    const changes = makeChanges(200);
    const result = await client.editDocument("doc_1", changes);

    expect(calls).toHaveLength(1);
    expect(result.batches_sent).toBe(1);
  });

  test("splits 201 changes into 2 batches", async () => {
    const changes = makeChanges(201);
    const result = await client.editDocument("doc_1", changes);

    expect(calls).toHaveLength(2);
    expect(result.batches_sent).toBe(2);

    // First batch should have 200 changes, second should have 1.
    const batch1 = calls[0].body.changes as EditDocumentChange[];
    const batch2 = calls[1].body.changes as EditDocumentChange[];
    expect(batch1).toHaveLength(200);
    expect(batch2).toHaveLength(1);
  });

  test("splits 450 changes into 3 batches", async () => {
    const changes = makeChanges(450);
    const result = await client.editDocument("doc_1", changes);

    expect(calls).toHaveLength(3);
    expect(result.batches_sent).toBe(3);

    // Verify batch sizes: 200, 200, 50.
    const sizes = calls.map((c) => (c.body.changes as EditDocumentChange[]).length);
    expect(sizes).toEqual([200, 200, 50]);
  });

  test("splits exactly 400 changes into 2 batches", async () => {
    const changes = makeChanges(400);
    const result = await client.editDocument("doc_1", changes);

    expect(calls).toHaveLength(2);
    expect(result.batches_sent).toBe(2);

    const sizes = calls.map((c) => (c.body.changes as EditDocumentChange[]).length);
    expect(sizes).toEqual([200, 200]);
  });

  test("merges new_node_ids across multiple batches", async () => {
    // Use insert changes so each batch generates new_node_ids.
    const changes = makeChanges(450, "insert");
    const result = await client.editDocument("doc_1", changes);

    expect(result.batches_sent).toBe(3);

    // Each batch generates IDs for its inserts: 200 + 200 + 50 = 450 total.
    expect(result.new_node_ids).toBeDefined();
    expect(result.new_node_ids).toHaveLength(450);

    // Verify IDs are sequential and unique.
    const idSet = new Set(result.new_node_ids);
    expect(idSet.size).toBe(450);
  });

  test("returns undefined new_node_ids when no inserts exist across batches", async () => {
    // All edit changes, no inserts.
    const changes = makeChanges(300, "edit");
    const result = await client.editDocument("doc_1", changes);

    expect(result.batches_sent).toBe(2);
    expect(result.new_node_ids).toBeUndefined();
  });

  test("passes file_id in every batch request", async () => {
    const changes = makeChanges(450);
    await client.editDocument("my_doc", changes);

    for (const call of calls) {
      expect(call.endpoint).toBe("/doc/edit");
      expect(call.body.file_id).toBe("my_doc");
    }
  });
});
