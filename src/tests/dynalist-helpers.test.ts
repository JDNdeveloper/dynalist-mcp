import { describe, test, expect } from "bun:test";
import {
  groupByLevel,
  buildNodeTree,
  wrapToolHandler,
  editDocumentWithPartialGuard,
  PartialWriteError,
  makeResponse,
  ToolInputError,
  checkContentSize,
  type ParsedNode,
} from "../utils/dynalist-helpers";
import { DynalistApiError, CHANGES_BATCH_SIZE, type DynalistClient, type EditDocumentChange, type DynalistNode } from "../dynalist-client";
import { ConfigError } from "../config";
import { parseErrorContent } from "./tools/test-helpers";

// ─── groupByLevel ─────────────────────────────────────────────────────

describe("groupByLevel", () => {
  test("single node with no children produces one level", () => {
    const roots: ParsedNode[] = [
      { content: "Solo", children: [] },
    ];
    const levels = groupByLevel(roots);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(1);
    expect(levels[0][0].content).toBe("Solo");
    expect(levels[0][0].parentLevelIndex).toBe(-1);
    expect(levels[0][0].localIndex).toBe(0);
  });

  test("flat list of roots produces one level with correct indices", () => {
    const roots: ParsedNode[] = [
      { content: "A", children: [] },
      { content: "B", children: [] },
      { content: "C", children: [] },
    ];
    const levels = groupByLevel(roots);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(3);
    expect(levels[0][0].content).toBe("A");
    expect(levels[0][1].content).toBe("B");
    expect(levels[0][2].content).toBe("C");
    // All roots have parentLevelIndex of -1.
    for (const node of levels[0]) {
      expect(node.parentLevelIndex).toBe(-1);
    }
  });

  test("nested tree groups nodes by depth", () => {
    const roots: ParsedNode[] = [
      {
        content: "Parent",
        children: [
          {
            content: "Child 1",
            children: [
              { content: "Grandchild", children: [] },
            ],
          },
          { content: "Child 2", children: [] },
        ],
      },
    ];
    const levels = groupByLevel(roots);

    // Three levels: root, children, grandchildren.
    expect(levels).toHaveLength(3);

    // Level 0: one root.
    expect(levels[0]).toHaveLength(1);
    expect(levels[0][0].content).toBe("Parent");

    // Level 1: two children, both referencing parent at index 0.
    expect(levels[1]).toHaveLength(2);
    expect(levels[1][0].content).toBe("Child 1");
    expect(levels[1][0].parentLevelIndex).toBe(0);
    expect(levels[1][1].content).toBe("Child 2");
    expect(levels[1][1].parentLevelIndex).toBe(0);

    // Level 2: one grandchild, referencing Child 1 at index 0.
    expect(levels[2]).toHaveLength(1);
    expect(levels[2][0].content).toBe("Grandchild");
    expect(levels[2][0].parentLevelIndex).toBe(0);
  });

  test("multiple roots with children track parent indices correctly", () => {
    const roots: ParsedNode[] = [
      {
        content: "Root A",
        children: [{ content: "A-child", children: [] }],
      },
      {
        content: "Root B",
        children: [{ content: "B-child", children: [] }],
      },
    ];
    const levels = groupByLevel(roots);

    expect(levels).toHaveLength(2);
    expect(levels[1]).toHaveLength(2);

    // A-child references Root A (index 0 in level 0).
    expect(levels[1][0].content).toBe("A-child");
    expect(levels[1][0].parentLevelIndex).toBe(0);

    // B-child references Root B (index 1 in level 0).
    expect(levels[1][1].content).toBe("B-child");
    expect(levels[1][1].parentLevelIndex).toBe(1);
  });

  test("optional fields are preserved on level nodes", () => {
    const roots: ParsedNode[] = [
      {
        content: "Styled node",
        note: "A note",
        show_checkbox: true,
        checked: false,
        heading: "h2",
        color: "yellow",
        children: [],
      },
    ];
    const levels = groupByLevel(roots);
    const node = levels[0][0];
    expect(node.note).toBe("A note");
    expect(node.show_checkbox).toBe(true);
    expect(node.checked).toBe(false);
    expect(node.heading).toBe("h2");
    expect(node.color).toBe("yellow");
  });

  test("empty roots array produces one empty level", () => {
    const levels = groupByLevel([]);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(0);
  });
});

// ─── buildNodeTree ────────────────────────────────────────────────────

function makeNode(id: string, children: string[] = [], content = ""): DynalistNode {
  return {
    id,
    content,
    note: "",
    created: 0,
    modified: 0,
    children,
    collapsed: false,
  };
}

const defaultOptions = {
  maxDepth: null,
  includeCollapsedChildren: true,
  includeNotes: true,
  includeChecked: true,
};

describe("buildNodeTree", () => {
  test("handles cyclic node data without infinite loop", () => {
    // Node A references B, B references A.
    const nodes = [
      makeNode("a", ["b"], "Node A"),
      makeNode("b", ["a"], "Node B"),
    ];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const tree = buildNodeTree(nodeMap, "a", defaultOptions);
    expect(tree).not.toBeNull();
    expect(tree!.item_id).toBe("a");

    // B should appear as child of A, but A should not appear again under B.
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children![0].item_id).toBe("b");
    // B declares A as a child, but A was already visited so the cycle is
    // broken. B appears as a leaf (no child_count, no children).
    expect(tree!.children![0].child_count).toBeUndefined();
    expect(tree!.children![0].children).toBeUndefined();
  });

  test("handles self-referencing node without infinite loop", () => {
    const nodes = [makeNode("a", ["a"], "Self ref")];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const tree = buildNodeTree(nodeMap, "a", defaultOptions);
    expect(tree).not.toBeNull();
    expect(tree!.item_id).toBe("a");
    // The self-reference should be skipped by the visited guard.
    // The node appears as a leaf (no child_count, no children).
    expect(tree!.child_count).toBeUndefined();
    expect(tree!.children).toBeUndefined();
  });
});

// ─── wrapToolHandler error paths ──────────────────────────────────────

describe("wrapToolHandler error paths", () => {
  test("ToolInputError is caught and returned as structured error", async () => {
    const handler = wrapToolHandler(async () => {
      throw new ToolInputError("ItemNotFound", "Item 'xyz' not found in document.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("ItemNotFound");
    expect(parsedError.message).toContain("Item 'xyz' not found");
  });

  test("DynalistApiError is caught and returned with its code", async () => {
    const handler = wrapToolHandler(async () => {
      throw new DynalistApiError("TooManyRequests", "Rate limited.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("TooManyRequests");
    expect(parsedError.message).toContain("Rate limited");
  });

  test("DynalistApiError with NodeNotFound code is remapped to ItemNotFound", async () => {
    const handler = wrapToolHandler(async () => {
      throw new DynalistApiError("NodeNotFound", "Node 'xyz' not found.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("ItemNotFound");
  });

  test("ConfigError is caught and returned with ConfigError code", async () => {
    const handler = wrapToolHandler(async () => {
      throw new ConfigError("Config file is invalid: bad field.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("ConfigError");
    expect(parsedError.message).toContain("Config file is invalid");
  });

  test("generic Error is caught and returned with Unknown code", async () => {
    const handler = wrapToolHandler(async () => {
      throw new Error("Something unexpected happened.");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("Unknown");
    expect(parsedError.message).toBe("Something unexpected happened.");
  });

  test("non-Error throwable is caught and stringified", async () => {
    const handler = wrapToolHandler(async () => {
      throw "string error";
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    const parsedError = parseErrorContent(result);
    expect(parsedError.error).toBe("Unknown");
    expect(parsedError.message).toBe("string error");
  });

  test("successful handler returns result without error flag", async () => {
    const handler = wrapToolHandler(async () => {
      return makeResponse({ status: "ok" });
    });
    const result = await handler();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("ok");
  });
});

// ─── checkContentSize boundary values ─────────────────────────────────

describe("checkContentSize boundary values", () => {
  // checkContentSize estimates tokens as Math.ceil(text.length / 4).

  test("content at exactly warning threshold returns null (no warning)", () => {
    // 5000 tokens = 20000 chars. estimateTokens(20000 chars) = 5000.
    const content = "x".repeat(20000);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).toBeNull();
  });

  test("content one token above warning threshold triggers warning", () => {
    // 5001 tokens = 20001..20004 chars. Ceil(20001/4) = 5001.
    const content = "x".repeat(20001);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain("LARGE RESULT WARNING");
    expect(result!.canBypass).toBe(true);
  });

  test("content at exactly max threshold with bypass returns null", () => {
    // 24500 tokens = 98000 chars. Ceil(98000/4) = 24500.
    const content = "x".repeat(98000);
    const result = checkContentSize(content, true, ["Narrow scope"], 5000, 24500);
    expect(result).toBeNull();
  });

  test("content one token above max threshold with bypass is NOT bypassed", () => {
    // 24501 tokens = 98001..98004 chars. Ceil(98001/4) = 24501.
    const content = "x".repeat(98001);
    const result = checkContentSize(content, true, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.canBypass).toBe(false);
    expect(result!.warning).toContain("too large");
  });

  test("content above warning but below max threshold is bypassable", () => {
    // 10000 tokens = 40000 chars.
    const content = "x".repeat(40000);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.canBypass).toBe(true);
    expect(result!.warning).toContain("bypass_warning: true");
  });

  test("content above max threshold is not bypassable even without bypass", () => {
    // 30000 tokens = 120000 chars.
    const content = "x".repeat(120000);
    const result = checkContentSize(content, false, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.canBypass).toBe(false);
    expect(result!.warning).toContain("too large");
  });

  test("bypass_warning on small content warns about incorrect usage", () => {
    // Content under warning threshold, but bypass is true.
    const content = "x".repeat(100);
    const result = checkContentSize(content, true, ["Narrow scope"], 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain("INCORRECT USAGE");
    expect(result!.canBypass).toBe(false);
  });

  test("empty content returns null", () => {
    const result = checkContentSize("", false, ["Narrow scope"], 5000, 24500);
    expect(result).toBeNull();
  });

  test("recommendations appear in warning text", () => {
    const content = "x".repeat(40000);
    const recs = ["Use max_depth", "Target an item_id"];
    const result = checkContentSize(content, false, recs, 5000, 24500);
    expect(result).not.toBeNull();
    expect(result!.warning).toContain("Use max_depth");
    expect(result!.warning).toContain("Target an item_id");
  });
});

// ─── editDocumentWithPartialGuard ─────────────────────────────────────

describe("editDocumentWithPartialGuard", () => {
  // Minimal mock that either succeeds or throws.
  function makeMockClient(shouldThrow: boolean): DynalistClient {
    return {
      editDocument: async () => {
        if (shouldThrow) throw new DynalistApiError("ServerError", "Boom");
        return { batches_sent: 1 };
      },
    } as unknown as DynalistClient;
  }

  function makeChanges(count: number): EditDocumentChange[] {
    return Array.from({ length: count }, () => ({ action: "delete" as const, node_id: "x" }));
  }

  test("success passes through the response", async () => {
    const client = makeMockClient(false);
    const result = await editDocumentWithPartialGuard(client, "f1", makeChanges(1));
    expect(result.batches_sent).toBe(1);
  });

  test("error with changes <= batch size rethrows original error", async () => {
    const client = makeMockClient(true);
    const changes = makeChanges(CHANGES_BATCH_SIZE);
    await expect(editDocumentWithPartialGuard(client, "f1", changes))
      .rejects.toThrow(DynalistApiError);
  });

  test("error with changes > batch size throws PartialWriteError", async () => {
    const client = makeMockClient(true);
    const changes = makeChanges(CHANGES_BATCH_SIZE + 1);
    await expect(editDocumentWithPartialGuard(client, "f1", changes))
      .rejects.toThrow(PartialWriteError);
  });

  test("PartialWriteError includes file_id and reread guidance", async () => {
    const client = makeMockClient(true);
    const changes = makeChanges(CHANGES_BATCH_SIZE + 1);
    try {
      await editDocumentWithPartialGuard(client, "f1", changes);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PartialWriteError);
      const pwe = error as PartialWriteError;
      expect(pwe.fileId).toBe("f1");
      expect(pwe.message).toContain("read_document");
    }
  });

  test("PartialWriteError preserves original error as cause", async () => {
    const client = makeMockClient(true);
    const changes = makeChanges(CHANGES_BATCH_SIZE + 1);
    try {
      await editDocumentWithPartialGuard(client, "f1", changes);
      expect.unreachable("should have thrown");
    } catch (error) {
      const pwe = error as PartialWriteError;
      expect(pwe.cause).toBeInstanceOf(DynalistApiError);
    }
  });
});
