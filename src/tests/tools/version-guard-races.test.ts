/**
 * Race simulation and edge case tests for the version guard. Uses
 * dummy server hooks to inject concurrent modifications at precise
 * points in the tool's execution.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  standardSetup,
  type TestContext,
} from "./test-helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ═════════════════════════════════════════════════════════════════════
// Race simulation: insert_nodes
// ═════════════════════════════════════════════════════════════════════
describe("insert_nodes race simulation", () => {
  test("as_last_child multi-item race: concurrent child added", async () => {
    // After insert_nodes reads the parent's child count but before the
    // write, another client adds a child. The version guard detects the
    // concurrent modification.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const n1 = doc.nodes.find(n => n.id === "n1")!;
      const intruder = ctx.server.makeNode("intruder", "Intruder", []);
      doc.nodes.push(intruder);
      n1.children!.push("intruder");
      doc.version++;
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{ content: "Item A" }, { content: "Item B" }],
    });

    expect(result.version_warning).toBeDefined();
    expect(result.total_created).toBe(2);
  });

  test("as_first_child multi-item race: concurrent insert at position 0", async () => {
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const n1 = doc.nodes.find(n => n.id === "n1")!;
      const intruder = ctx.server.makeNode("intruder", "Intruder", []);
      doc.nodes.push(intruder);
      n1.children!.unshift("intruder");
      doc.version++;
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{ content: "First A" }, { content: "First B" }],
      position: "as_first_child",
    });

    expect(result.version_warning).toBeDefined();
    expect(result.total_created).toBe(2);
  });

  test("after/before race: sibling reorder during position resolution", async () => {
    // After the tool reads to resolve the reference node's position but
    // before the write, another client reorders siblings.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const root = doc.nodes.find(n => n.id === "root")!;
      // Reverse the children order to simulate a reorder.
      root.children!.reverse();
      doc.version++;
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      reference_node_id: "n1",
      nodes: [{ content: "After n1" }],
      position: "after",
    });

    expect(result.version_warning).toBeDefined();
    expect(result.total_created).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Race simulation: delete_node
// ═════════════════════════════════════════════════════════════════════
describe("delete_node race simulation", () => {
  test("subtree race: new child added during subtree enumeration", async () => {
    // After delete_node reads to enumerate the subtree but before the
    // delete call, another client adds a child under the target.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const n2 = doc.nodes.find(n => n.id === "n2")!;
      const newChild = ctx.server.makeNode("n2_new", "New under n2", []);
      doc.nodes.push(newChild);
      n2.children!.push("n2_new");
      doc.version++;
    });

    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n2",
    });

    // The delete succeeded but missed the new child (orphaned).
    expect(result.version_warning).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Race simulation: move_node
// ═════════════════════════════════════════════════════════════════════
describe("move_node race simulation", () => {
  test("index race: sibling reorder during move computation", async () => {
    // After move_node reads and computes the target index but before
    // the move call, another client reorders siblings.
    ctx.server.onNextEdit((fileId) => {
      const doc = ctx.server.documents.get(fileId)!;
      const root = doc.nodes.find(n => n.id === "root")!;
      root.children!.reverse();
      doc.version++;
    });

    const result = await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1a",
      reference_node_id: "n2",
      position: "after",
    });

    expect(result.version_warning).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Edge cases
// ═════════════════════════════════════════════════════════════════════
describe("version guard edge cases", () => {
  test("version goes backwards (unexpected) produces warning", async () => {
    // Simulate a version that goes backwards between pre and post check.
    // This is abnormal but the guard should handle it gracefully.
    ctx.server.onNextEdit((fileId) => {
      // After the edit, manually set version to something lower.
      const doc = ctx.server.documents.get(fileId)!;
      // The edit will increment version. Set it so that post-check sees
      // a lower version than pre-check. We decrement by 5 to overcome
      // the +1 from the edit itself.
      doc.version -= 5;
    });

    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "test",
    });

    // Negative delta != 1, so a warning should be produced.
    expect(result.version_warning).toBeDefined();
  });

  test("operations on different documents have independent version tracking", async () => {
    // Edit doc1, verify its version changes independently of doc2.
    const doc1Before = ctx.server.documents.get("doc1")!.version;
    const doc2Before = ctx.server.documents.get("doc2")!.version;

    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated doc1",
    });

    const doc1After = ctx.server.documents.get("doc1")!.version;
    const doc2After = ctx.server.documents.get("doc2")!.version;

    expect(doc1After).toBe(doc1Before + 1);
    expect(doc2After).toBe(doc2Before);
  });

  test("insert_nodes with nested tree counts batches across levels", async () => {
    // A 3-level tree should produce 3 editDocument calls.
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{
        content: "Level 1",
        children: [{
          content: "Level 2",
          children: [{ content: "Level 3" }],
        }],
      }],
    });

    expect(result.total_created).toBe(3);
    expect(result.version_warning).toBeUndefined();
  });

  test("concurrent edit during multi-level insert produces warning", async () => {
    // Inject concurrent edit on first editDocument call. The insert
    // will make 3 API calls (3 levels), but version advances by 4.
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{
        content: "Level 1",
        children: [{
          content: "Level 2",
          children: [{ content: "Level 3" }],
        }],
      }],
    });

    expect(result.version_warning).toBeDefined();
    expect(result.version_warning).toContain("advanced by 4");
    expect(result.version_warning).toContain("expected 3");
  });

  test("expected_version with concurrent edit: abort before write", async () => {
    // Simulate a concurrent edit that happens between the agent's
    // read_document and the write tool call. The pre-write check
    // should detect the stale version and abort.
    const doc = ctx.server.documents.get("doc1")!;
    const staleVersion = doc.version;

    // Simulate someone else editing the document.
    ctx.server.simulateConcurrentEdit("doc1");

    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Should not apply",
      expected_version: staleVersion,
    });

    expect(err.error).toBe("VersionMismatch");
    expect(err.message).toContain(`expected ${staleVersion}`);
    expect(err.message).toContain(`current is ${staleVersion + 1}`);
  });
});
