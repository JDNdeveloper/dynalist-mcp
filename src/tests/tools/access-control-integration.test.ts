import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  getVersion,
  type TestContext,
} from "./test-helpers";
import { setTestConfig } from "../../config";
import { DummyDynalistServer } from "../dummy-server";

// ─── Shared setup ─────────────────────────────────────────────────────

/**
 * Set up a file tree with several folders and documents under various
 * ACL policies (deny, read, allow, and default-deny).
 *
 * Tree structure:
 *   Root > Denied Folder   > Denied Doc
 *                          > Allowed In Denied Doc
 *                          > Denied Subfolder    > Deep Allowed Doc
 *                          > Allowed Empty Folder  (empty, allowed via /**)
 *                          > Glob Target Folder    (empty, denied; has /* rule targeting children)
 *        > ReadOnly Folder > ReadOnly Doc
 *        > Allowed Folder  > Allowed Doc
 *        > Unruled Folder  > Unruled Doc   (no explicit rule, uses default)
 *        > Inbox
 */
function aclSetup(server: DummyDynalistServer): void {
  server.addFolder("denied_folder", "Denied Folder", "root_folder");
  server.addFolder("readonly_folder", "ReadOnly Folder", "root_folder");
  server.addFolder("allowed_folder", "Allowed Folder", "root_folder");
  server.addFolder("unruled_folder", "Unruled Folder", "root_folder");

  server.addDocument("denied_doc", "Denied Doc", "denied_folder", [
    server.makeNode("root", "Denied Doc", ["dn1"]),
    server.makeNode("dn1", "Denied content", ["dn1a"]),
    server.makeNode("dn1a", "Denied child", []),
  ]);

  // Document inside the denied folder that has an explicit allow override.
  server.addDocument("allowed_in_denied_doc", "Allowed In Denied Doc", "denied_folder", [
    server.makeNode("root", "Allowed In Denied Doc", ["aidn1"]),
    server.makeNode("aidn1", "Override content", []),
  ]);

  // Nested denied subfolder inside the denied folder, containing an
  // allowed document. Tests that the full folder path is exposed
  // through multiple levels of denied ancestors.
  server.addFolder("denied_subfolder", "Denied Subfolder", "denied_folder");
  server.addDocument("deep_allowed_doc", "Deep Allowed Doc", "denied_subfolder", [
    server.makeNode("root", "Deep Allowed Doc", ["dadn1"]),
    server.makeNode("dadn1", "Deep override content", []),
  ]);

  // Empty folder with an explicit allow override (via /**). The folder
  // itself has allow policy, so it appears through the normal non-deny path.
  server.addFolder("allowed_empty_folder", "Allowed Empty Folder", "denied_folder");

  // Empty folder targeted by a /* rule. The folder itself stays denied
  // (/* only matches children, not the folder), but it should still be
  // visible because a non-deny rule references it as a path segment.
  server.addFolder("glob_target_folder", "Glob Target Folder", "denied_folder");

  server.addDocument("readonly_doc", "ReadOnly Doc", "readonly_folder", [
    server.makeNode("root", "ReadOnly Doc", ["rn1"]),
    server.makeNode("rn1", "ReadOnly content", ["rn1a"]),
    server.makeNode("rn1a", "ReadOnly child", []),
  ]);

  server.addDocument("allowed_doc", "Allowed Doc", "allowed_folder", [
    server.makeNode("root", "Allowed Doc", ["an1"]),
    server.makeNode("an1", "Allowed content", ["an1a"]),
    server.makeNode("an1a", "Allowed child", []),
  ]);

  server.addDocument("unruled_doc", "Unruled Doc", "unruled_folder", [
    server.makeNode("root", "Unruled Doc", ["un1"]),
    server.makeNode("un1", "Unruled content", []),
  ]);

  server.addDocument("inbox_doc", "Inbox", "root_folder", [
    server.makeNode("inbox_root", "Inbox", []),
  ]);
  server.setInbox("inbox_doc", "inbox_root");
}

/** Build a full config with overrides applied on top of test defaults. */
function updateTestConfig(overrides: Record<string, unknown>) {
  setTestConfig({
    readDefaults: { maxDepth: 5, includeCollapsedChildren: false, includeNotes: true, includeChecked: true },
    sizeWarning: { warningTokenThreshold: 5000, maxTokenThreshold: 24500 },
    cache: { ttlSeconds: 300 },
    logLevel: "warn",
    ...ACL_CONFIG,
    ...overrides,
  });
}

const ACL_CONFIG = {
  access: {
    default: "deny" as const,
    rules: [
      { path: "/Denied Folder/**", policy: "deny" as const },
      { path: "/Denied Folder/Allowed In Denied Doc", policy: "allow" as const },
      { path: "/Denied Folder/Denied Subfolder/Deep Allowed Doc", policy: "allow" as const },
      { path: "/Denied Folder/Allowed Empty Folder/**", policy: "allow" as const },
      { path: "/Denied Folder/Glob Target Folder/*", policy: "allow" as const },
      { path: "/ReadOnly Folder/**", policy: "read" as const },
      { path: "/Allowed Folder/**", policy: "allow" as const },
      { path: "/Inbox", policy: "allow" as const },
    ],
  },
};

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(aclSetup, ACL_CONFIG);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════
// 3b. read_document with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("read_document with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "read_document", {
      file_id: "denied_doc",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns content successfully", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "readonly_doc",
      max_depth: 10,
    });
    expect(result.file_id).toBe("readonly_doc");
    expect(result.title).toBe("ReadOnly Doc");
  });

  test("allow-policy document returns content successfully", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "allowed_doc",
      max_depth: 10,
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.title).toBe("Allowed Doc");
  });

  test("denied error is indistinguishable from non-existent document", async () => {
    const deniedErr = await callToolError(ctx.mcpClient, "read_document", {
      file_id: "denied_doc",
    });
    const missingErr = await callToolError(ctx.mcpClient, "read_document", {
      file_id: "totally_fake_id",
    });
    expect(deniedErr.error).toBe(missingErr.error);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3c. search_in_document with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("search_in_document with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "search_in_document", {
      file_id: "denied_doc",
      query: "content",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document search succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "readonly_doc",
      query: "ReadOnly",
    });
    expect(result.count).toBeGreaterThan(0);
  });

  test("allow-policy document search succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_in_document", {
      file_id: "allowed_doc",
      query: "Allowed",
    });
    expect(result.count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3d. get_recent_changes with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("get_recent_changes with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "get_recent_changes", {
      file_id: "denied_doc",
      since: "1970-01-01",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "readonly_doc",
      since: "1970-01-01",
    });
    expect(result.file_id).toBe("readonly_doc");
    expect(result.count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3e. edit_nodes with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("edit_nodes with ACL", () => {
  test("denied document returns NotFound (not Forbidden)", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "denied_doc",
      expected_version: 1,
      nodes: [{ node_id: "dn1", content: "hacked" }],
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns Forbidden error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "readonly_doc",
      expected_version: 1,
      nodes: [{ node_id: "rn1", content: "hacked" }],
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy document edit succeeds", async () => {
    const version = await getVersion(ctx.mcpClient, "allowed_doc");
    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "allowed_doc",
      expected_version: version,
      nodes: [{ node_id: "an1", content: "Updated content" }],
    });
    expect(result.file_id).toBe("allowed_doc");
    expect((result.node_ids as string[])).toEqual(["an1"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3f. insert_nodes with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("insert_nodes with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "denied_doc",
      expected_version: 1,
      nodes: [{ content: "hacked" }],
      position: "last_child",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns Forbidden error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "readonly_doc",
      expected_version: 1,
      nodes: [{ content: "hacked" }],
      position: "last_child",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy document insert succeeds", async () => {
    const version = await getVersion(ctx.mcpClient, "allowed_doc");
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "allowed_doc",
      expected_version: version,
      nodes: [{ content: "New item" }, { content: "Another item" }],
      position: "last_child",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.total_created).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3h. delete_nodes with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("delete_nodes with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "denied_doc",
      expected_version: 1,
      node_ids: ["dn1"],
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns Forbidden error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "readonly_doc",
      expected_version: 1,
      node_ids: ["rn1"],
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy document delete succeeds", async () => {
    const version = await getVersion(ctx.mcpClient, "allowed_doc");
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "allowed_doc",
      expected_version: version,
      node_ids: ["an1a"],
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.deleted_count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3i. move_nodes with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("move_nodes with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "denied_doc",
      expected_version: 1,
      moves: [{ node_id: "dn1a", reference_node_id: "dn1", position: "first_child" }],
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns Forbidden error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "readonly_doc",
      expected_version: 1,
      moves: [{ node_id: "rn1a", reference_node_id: "rn1", position: "first_child" }],
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy document move succeeds", async () => {
    const version = await getVersion(ctx.mcpClient, "allowed_doc");
    const result = await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "allowed_doc",
      expected_version: version,
      moves: [{ node_id: "an1a", reference_node_id: "root", position: "last_child" }],
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.node_ids).toEqual(["an1a"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3j. send_to_inbox with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("send_to_inbox with ACL", () => {
  test("default access policy succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Inbox item",
    });
    expect(result.file_id).toBe("inbox_doc");
    expect(result.node_id).toBeDefined();
  });

  test("deny-all default blocks inbox when no explicit inbox rule", async () => {
    updateTestConfig({
      access: {
        default: "deny",
        rules: [],
      },
    });
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "Should be blocked",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-all default blocks inbox when no explicit inbox rule", async () => {
    updateTestConfig({
      access: {
        default: "read",
        rules: [],
      },
    });
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "Should be blocked",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("global read rule blocks inbox even with allow default", async () => {
    updateTestConfig({
      access: {
        default: "allow",
        rules: [
          { path: "/**", policy: "read" },
        ],
      },
    });
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "Should be blocked",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("explicit inbox allow overrides global read rule", async () => {
    updateTestConfig({
      access: {
        default: "read",
        rules: [
          { path: "/Inbox", policy: "allow" },
        ],
      },
    });
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Should succeed",
    });
    expect(result.file_id).toBe("inbox_doc");
    expect(result.node_id).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3k. list_documents with ACL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find a file entry by file_id in a recursive files tree.
 */
function findFileInTree(files: Record<string, unknown>[], fileId: string): Record<string, unknown> | undefined {
  for (const f of files) {
    if (f.file_id === fileId) return f;
    if (Array.isArray(f.children)) {
      const found = findFileInTree(f.children as Record<string, unknown>[], fileId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Collect all file entries from a recursive files tree into a flat array.
 */
function flattenTree(files: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const f of files) {
    result.push(f);
    if (Array.isArray(f.children)) {
      result.push(...flattenTree(f.children as Record<string, unknown>[]));
    }
  }
  return result;
}

describe("list_documents with ACL", () => {
  test("denied documents are omitted from results", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    expect(findFileInTree(files, "denied_doc")).toBeUndefined();
  });

  test("denied folders without allowed descendants are omitted", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    // unruled_folder has no allowed descendants, so it should not appear.
    expect(findFileInTree(files, "unruled_folder")).toBeUndefined();
  });

  test("denied folders with allowed descendants appear in the tree", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    // denied_folder contains allowed_in_denied_doc and deep_allowed_doc
    // (via denied_subfolder), so it should appear.
    const deniedFolder = findFileInTree(files, "denied_folder");
    expect(deniedFolder).toBeDefined();
  });

  test("denied documents and folders without allowed descendants do not appear", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    const hiddenIds = ["denied_doc", "unruled_folder", "unruled_doc"];
    for (const entry of all) {
      for (const hiddenId of hiddenIds) {
        expect(entry.file_id).not.toBe(hiddenId);
      }
    }
  });

  test("read-policy documents appear with access_policy: read", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const readDoc = findFileInTree(result.files as Record<string, unknown>[], "readonly_doc");
    expect(readDoc).toBeDefined();
    expect(readDoc!.access_policy).toBe("read");
  });

  test("allow-policy documents appear without access_policy field", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const allowDoc = findFileInTree(result.files as Record<string, unknown>[], "allowed_doc");
    expect(allowDoc).toBeDefined();
    expect(allowDoc!.access_policy).toBeUndefined();
  });

  test("count reflects filtered count, not pre-filter count", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    const docs = all.filter((f) => f.type === "document");
    // denied_doc and unruled_doc (default: deny) should be filtered out.
    // Remaining: readonly_doc, allowed_doc, allowed_in_denied_doc, deep_allowed_doc, inbox_doc.
    expect(result.count).toBe(docs.length);
    expect(findFileInTree(result.files as Record<string, unknown>[], "denied_doc")).toBeUndefined();
    expect(findFileInTree(result.files as Record<string, unknown>[], "unruled_doc")).toBeUndefined();
  });

  test("allow-override inside deny-parent: document nested under denied folder", async () => {
    // The "Allowed In Denied Doc" has an explicit allow rule even though
    // its parent "Denied Folder" matches /Denied Folder/** with deny policy.
    // The denied folder should appear as a path container.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];

    // The document should be nested under Denied Folder, not at top level.
    const topLevel = files.find((f) => f.file_id === "allowed_in_denied_doc");
    expect(topLevel).toBeUndefined();

    const deniedFolder = findFileInTree(files, "denied_folder");
    expect(deniedFolder).toBeDefined();
    const children = deniedFolder!.children as Record<string, unknown>[];
    const overrideDoc = children.find((f) => f.file_id === "allowed_in_denied_doc");
    expect(overrideDoc).toBeDefined();
    expect(overrideDoc!.title).toBe("Allowed In Denied Doc");
    expect(overrideDoc!.access_policy).toBeUndefined();
  });

  test("allow-override through multiple denied ancestors: full folder path shown", async () => {
    // "Deep Allowed Doc" sits inside "Denied Subfolder" which is inside
    // "Denied Folder". Both ancestor folders are denied, but they should
    // appear as path containers so the full hierarchy is visible.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];

    // The document should NOT appear at the top level.
    const topLevelDoc = files.find((f) => f.file_id === "deep_allowed_doc");
    expect(topLevelDoc).toBeUndefined();

    // Both denied folders should appear as path containers.
    const deniedFolder = files.find((f) => f.file_id === "denied_folder");
    expect(deniedFolder).toBeDefined();

    const deniedChildren = deniedFolder!.children as Record<string, unknown>[];
    const deniedSubfolder = deniedChildren.find((f) => f.file_id === "denied_subfolder");
    expect(deniedSubfolder).toBeDefined();

    const subChildren = deniedSubfolder!.children as Record<string, unknown>[];
    const deepDoc = subChildren.find((f) => f.file_id === "deep_allowed_doc");
    expect(deepDoc).toBeDefined();
    expect(deepDoc!.title).toBe("Deep Allowed Doc");
  });

  test("denied folder shown as path container does not include denied children", async () => {
    // Denied Folder contains denied_doc (denied) and allowed_in_denied_doc (allowed).
    // Only the allowed doc should appear as a child of the denied folder.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    const deniedFolder = findFileInTree(files, "denied_folder");
    expect(deniedFolder).toBeDefined();
    const children = deniedFolder!.children as Record<string, unknown>[];
    expect(children.find((f) => f.file_id === "denied_doc")).toBeUndefined();
  });

  test("allowed folders do not have access_policy field", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    const allowedFolder = findFileInTree(files, "allowed_folder");
    expect(allowedFolder).toBeDefined();
    expect(allowedFolder!.access_policy).toBeUndefined();
  });

  test("empty allowed folder inside denied parent: both visible", async () => {
    // Allowed Empty Folder has allow policy (from /** rule) and is
    // empty. It should appear inside Denied Folder.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    const deniedFolder = findFileInTree(files, "denied_folder");
    expect(deniedFolder).toBeDefined();
    const children = deniedFolder!.children as Record<string, unknown>[];
    const emptyFolder = children.find((f) => f.file_id === "allowed_empty_folder");
    expect(emptyFolder).toBeDefined();
    expect(emptyFolder!.title).toBe("Allowed Empty Folder");
    expect(emptyFolder!.children).toEqual([]);
  });

  test("empty denied folder with /* rule: visible because rule references its path", async () => {
    // Glob Target Folder is denied (/* does not match the folder itself),
    // but it has a non-deny /* rule, making it rule-visible.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const files = result.files as Record<string, unknown>[];
    const deniedFolder = findFileInTree(files, "denied_folder");
    expect(deniedFolder).toBeDefined();
    const children = deniedFolder!.children as Record<string, unknown>[];
    const globFolder = children.find((f) => f.file_id === "glob_target_folder");
    expect(globFolder).toBeDefined();
    expect(globFolder!.title).toBe("Glob Target Folder");
    expect(globFolder!.children).toEqual([]);
  });

  test("rule-visible denied folder appears even at max_depth: 1", async () => {
    // denied_folder is rule-visible (non-deny rules reference paths
    // through it). At max_depth: 1, it should appear with empty children.
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 1,
    });
    const files = result.files as Record<string, unknown>[];
    const deniedFolder = files.find((f) => f.file_id === "denied_folder");
    expect(deniedFolder).toBeDefined();
    expect(deniedFolder!.children).toEqual([]);
  });

  test("rule-visible denied folders at max_depth: 2 show their visible children", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents", {
      max_depth: 2,
    });
    const files = result.files as Record<string, unknown>[];
    const deniedFolder = files.find((f) => f.file_id === "denied_folder");
    expect(deniedFolder).toBeDefined();
    const children = deniedFolder!.children as Record<string, unknown>[];

    // Allowed documents and folders should be visible at depth 2.
    expect(children.find((f) => f.file_id === "allowed_in_denied_doc")).toBeDefined();
    expect(children.find((f) => f.file_id === "allowed_empty_folder")).toBeDefined();
    expect(children.find((f) => f.file_id === "glob_target_folder")).toBeDefined();

    // Denied subfolder should appear (it has allowed descendants) but
    // its children are beyond the depth limit.
    const subfolder = children.find((f) => f.file_id === "denied_subfolder");
    expect(subfolder).toBeDefined();
    expect(subfolder!.children).toEqual([]);

    // Denied documents should NOT appear.
    expect(children.find((f) => f.file_id === "denied_doc")).toBeUndefined();
  });

  test("denied folder without any rule reference is still omitted", async () => {
    // unruled_folder uses default deny and has no non-deny rule
    // referencing its path. It should not appear.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    expect(all.find((f) => f.file_id === "unruled_folder")).toBeUndefined();
  });

  test("denied doc inside rule-visible folder is not exposed", async () => {
    // denied_doc is inside denied_folder (which is rule-visible), but
    // denied_doc itself has deny policy and should NOT appear.
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    expect(all.find((f) => f.file_id === "denied_doc")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3l. search_documents with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("search_documents with ACL", () => {
  test("denied documents excluded from search results", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "Doc",
    });
    const matches = result.matches as Record<string, unknown>[];
    const deniedMatch = matches.find((m) => m.file_id === "denied_doc");
    expect(deniedMatch).toBeUndefined();
  });

  test("read-policy documents included with access_policy: read", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "ReadOnly",
    });
    const matches = result.matches as Record<string, unknown>[];
    const readMatch = matches.find((m) => m.file_id === "readonly_doc");
    expect(readMatch).toBeDefined();
    expect(readMatch!.access_policy).toBe("read");
  });

  test("denied folders excluded from search results", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "Folder",
      type: "folder",
    });
    const matches = result.matches as Record<string, unknown>[];
    const deniedFolder = matches.find((m) => m.file_id === "denied_folder");
    expect(deniedFolder).toBeUndefined();
  });

  test("count reflects filtered count", async () => {
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "Doc",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(result.count).toBe(matches.length);
    // Neither denied nor unruled (default: deny) should appear.
    for (const m of matches) {
      expect(m.file_id).not.toBe("denied_doc");
      expect(m.file_id).not.toBe("unruled_doc");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3m. check_document_versions with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("check_document_versions with ACL", () => {
  test("allowed documents appear in versions map", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.allowed_doc).toBeGreaterThan(0);
  });

  test("denied documents get version -1 (indistinguishable from not-found)", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["denied_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.denied_doc).toBe(-1);
    expect(result.denied).toBeUndefined();
  });

  test("read-policy documents appear in versions (read is sufficient)", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["readonly_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.readonly_doc).toBeGreaterThan(0);
  });

  test("mixed batch: denied gets -1, allowed and read get real versions", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc", "denied_doc", "readonly_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.allowed_doc).toBeGreaterThan(0);
    expect(versions.readonly_doc).toBeGreaterThan(0);
    expect(versions.denied_doc).toBe(-1);
    expect(result.denied).toBeUndefined();
  });

  test("all-denied batch returns all versions as -1", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["denied_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.denied_doc).toBe(-1);
    expect(result.denied).toBeUndefined();
  });

  test("all-allowed batch returns populated versions without denied field", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc", "readonly_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.allowed_doc).toBeGreaterThan(0);
    expect(versions.readonly_doc).toBeGreaterThan(0);
    expect(result.denied).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3n. File management tools with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("create_document with ACL", () => {
  test("deny-policy folder returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      parent_folder_id: "denied_folder",
      title: "Hacked Doc",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy folder returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      parent_folder_id: "readonly_folder",
      title: "Hacked Doc",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy folder succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_document", {
      parent_folder_id: "allowed_folder",
      title: "New Doc",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("New Doc");
  });
});

describe("create_folder with ACL", () => {
  test("deny-policy folder returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      parent_folder_id: "denied_folder",
      title: "Hacked Folder",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy folder returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      parent_folder_id: "readonly_folder",
      title: "Hacked Folder",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy folder succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "create_folder", {
      parent_folder_id: "allowed_folder",
      title: "New Folder",
    });
    expect(result.file_id).toBeDefined();
    expect(result.title).toBe("New Folder");
  });
});

describe("rename_document with ACL", () => {
  test("deny-policy document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_document", {
      file_id: "denied_doc",
      title: "Hacked Title",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_document", {
      file_id: "readonly_doc",
      title: "Hacked Title",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy document succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "rename_document", {
      file_id: "allowed_doc",
      title: "Renamed Doc",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.title).toBe("Renamed Doc");
  });
});

describe("rename_folder with ACL", () => {
  test("deny-policy folder returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_folder", {
      file_id: "denied_folder",
      title: "Hacked Name",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy folder returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_folder", {
      file_id: "readonly_folder",
      title: "Hacked Name",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow-policy folder succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "rename_folder", {
      file_id: "allowed_folder",
      title: "Renamed Folder",
    });
    expect(result.file_id).toBe("allowed_folder");
    expect(result.title).toBe("Renamed Folder");
  });
});

describe("move_document with ACL", () => {
  test("deny-policy source returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "denied_doc",
      parent_folder_id: "allowed_folder",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy source returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "readonly_doc",
      parent_folder_id: "allowed_folder",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("deny-policy destination returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "allowed_doc",
      parent_folder_id: "denied_folder",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy destination returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "move_document", {
      file_id: "allowed_doc",
      parent_folder_id: "readonly_folder",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow source + allow destination succeeds", async () => {
    // Create a second allowed folder to move into.
    ctx.server.addFolder("allowed_folder_2", "Allowed Folder 2", "root_folder");
    // Add a rule for the new folder.
    updateTestConfig({
      access: {
        default: "deny",
        rules: [
          { path: "/Denied Folder/**", policy: "deny" },
          { path: "/ReadOnly Folder/**", policy: "read" },
          { path: "/Allowed Folder/**", policy: "allow" },
          { path: "/Allowed Folder 2/**", policy: "allow" },
          { path: "/Inbox", policy: "allow" },
        ],
      },
    });
    // Invalidate cache so the new config is picked up.
    ctx.ac.invalidateCache();

    const result = await callToolOk(ctx.mcpClient, "move_document", {
      file_id: "allowed_doc",
      parent_folder_id: "allowed_folder_2",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.parent_folder_id).toBe("allowed_folder_2");
  });
});

describe("move_folder with ACL", () => {
  test("deny-policy source returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "denied_folder",
      parent_folder_id: "allowed_folder",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy source returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "readonly_folder",
      parent_folder_id: "allowed_folder",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("deny-policy destination returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "allowed_folder",
      parent_folder_id: "denied_folder",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy destination returns Forbidden", async () => {
    const err = await callToolError(ctx.mcpClient, "move_folder", {
      file_id: "allowed_folder",
      parent_folder_id: "readonly_folder",
    });
    expect(err.error).toBe("Forbidden");
  });

  test("allow source + allow destination succeeds", async () => {
    // Create a second allowed folder to move into.
    ctx.server.addFolder("allowed_folder_2", "Allowed Folder 2", "root_folder");
    updateTestConfig({
      access: {
        default: "deny",
        rules: [
          { path: "/Denied Folder/**", policy: "deny" },
          { path: "/ReadOnly Folder/**", policy: "read" },
          { path: "/Allowed Folder/**", policy: "allow" },
          { path: "/Allowed Folder 2/**", policy: "allow" },
          { path: "/Inbox", policy: "allow" },
        ],
      },
    });
    ctx.ac.invalidateCache();

    const result = await callToolOk(ctx.mcpClient, "move_folder", {
      file_id: "allowed_folder",
      parent_folder_id: "allowed_folder_2",
    });
    expect(result.file_id).toBe("allowed_folder");
    expect(result.parent_folder_id).toBe("allowed_folder_2");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3o. access.default: "read" blocks all writes
// ═══════════════════════════════════════════════════════════════════════

describe("access.default 'read' blocks all writes", () => {
  // Helper to switch to a read-only-equivalent config.
  function writeReadDefaultConfig() {
    updateTestConfig({
      access: {
        default: "read",
        rules: [],
      },
    });
  }

  test("blocks write on any document", async () => {
    writeReadDefaultConfig();
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "allowed_doc",
      expected_version: 1,
      nodes: [{ node_id: "an1", content: "hacked" }],
    });
    expect(err.error).toBe("Forbidden");
    expect(err.message).toBe("Document is read-only per access policy.");
  });

  test("permits read on any document", async () => {
    writeReadDefaultConfig();
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "allowed_doc",
      max_depth: 10,
    });
    expect(result.file_id).toBe("allowed_doc");
  });

  test("blocks send_to_inbox", async () => {
    writeReadDefaultConfig();
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "Test",
    });
    expect(err.error).toBe("Forbidden");
    expect(err.message).toBe("Document is read-only per access policy.");
  });

  test("blocks create_document", async () => {
    writeReadDefaultConfig();
    const err = await callToolError(ctx.mcpClient, "create_document", {
      parent_folder_id: "allowed_folder",
      title: "New",
    });
    expect(err.error).toBe("Forbidden");
    expect(err.message).toBe("Document is read-only per access policy.");
  });

  test("blocks create_folder", async () => {
    writeReadDefaultConfig();
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      parent_folder_id: "allowed_folder",
      title: "New",
    });
    expect(err.error).toBe("Forbidden");
    expect(err.message).toBe("Document is read-only per access policy.");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3p. Batch denial-retry: getPolicies handles stale cache on renames
// ═══════════════════════════════════════════════════════════════════════

describe("getPolicies denial-retry on stale cache", () => {
  test("list_documents shows doc after it is moved out of denied folder", async () => {
    // Step 1: Prime the cache by calling list_documents.
    const before = await callToolOk(ctx.mcpClient, "list_documents");
    expect(findFileInTree(before.files as Record<string, unknown>[], "denied_doc")).toBeUndefined();

    // Step 2: Move the denied doc to the allowed folder directly on the
    // server, bypassing MCP tools (so the AC cache is NOT invalidated).
    const deniedFolder = ctx.server.files.get("denied_folder")!;
    const idx = deniedFolder.children!.indexOf("denied_doc");
    deniedFolder.children!.splice(idx, 1);
    const allowedFolder = ctx.server.files.get("allowed_folder")!;
    allowedFolder.children!.push("denied_doc");

    // Step 3: list_documents uses getPolicies (batch). With the fix,
    // the denial retry should refresh the cache and show the doc.
    const after = await callToolOk(ctx.mcpClient, "list_documents");
    expect(findFileInTree(after.files as Record<string, unknown>[], "denied_doc")).toBeDefined();
  });
});

// ─── check_document_versions mixed allowed/denied IDs ─────────────────

describe("check_document_versions mixed allowed/denied IDs", () => {
  let vCtx: TestContext;

  const VERSION_ACL_CONFIG = {
    access: {
      default: "deny" as const,
      rules: [
        { path: "/Allowed Folder/**", policy: "allow" as const },
        { path: "/Inbox", policy: "allow" as const },
      ],
    },
  };

  function versionAclSetup(server: DummyDynalistServer): void {
    server.addFolder("allowed_folder", "Allowed Folder", "root_folder");
    server.addFolder("denied_folder", "Denied Folder", "root_folder");

    server.addDocument("allowed_doc", "Allowed Doc", "allowed_folder", [
      server.makeNode("root", "Allowed Doc", ["x1"]),
      server.makeNode("x1", "Item", []),
    ]);

    server.addDocument("denied_doc", "Denied Doc", "denied_folder", [
      server.makeNode("root", "Denied Doc", ["y1"]),
      server.makeNode("y1", "Secret", []),
    ]);

    server.addDocument("inbox_doc", "Inbox", "root_folder", [
      server.makeNode("inbox_root", "Inbox", []),
    ]);
    server.setInbox("inbox_doc", "inbox_root");
  }

  beforeEach(async () => {
    vCtx = await createTestContext(versionAclSetup, VERSION_ACL_CONFIG);
  });

  afterEach(async () => {
    await vCtx.cleanup();
  });

  test("mixed batch returns real versions for allowed and -1 for denied", async () => {
    const result = await callToolOk(vCtx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc", "denied_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.allowed_doc).toBeGreaterThan(0);
    expect(versions.denied_doc).toBe(-1);
  });

  test("all denied IDs return version -1", async () => {
    const result = await callToolOk(vCtx.mcpClient, "check_document_versions", {
      file_ids: ["denied_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.denied_doc).toBe(-1);
  });

  test("nonexistent ID returns -1 same as denied", async () => {
    const result = await callToolOk(vCtx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc", "denied_doc", "fake_id"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.allowed_doc).toBeGreaterThan(0);
    expect(versions.denied_doc).toBe(-1);
    expect(versions.fake_id).toBe(-1);
  });

  test("empty file_ids array returns empty versions map", async () => {
    const result = await callToolOk(vCtx.mcpClient, "check_document_versions", {
      file_ids: [],
    });
    const versions = result.versions as Record<string, number>;
    expect(Object.keys(versions)).toHaveLength(0);
  });
});

// ─── Denied-content filtering in list and search ──────────────────────

describe("denied-content filtering in list and search", () => {
  let fCtx: TestContext;

  const FILTER_ACL_CONFIG = {
    access: {
      default: "allow" as const,
      rules: [
        { path: "/Secret Folder/**", policy: "deny" as const },
      ],
    },
  };

  function filterSetup(server: DummyDynalistServer): void {
    server.addFolder("public_folder", "Public Folder", "root_folder");
    server.addFolder("secret_folder", "Secret Folder", "root_folder");

    server.addDocument("public_doc", "Public Doc", "public_folder", [
      server.makeNode("root", "Public Doc", []),
    ]);

    server.addDocument("secret_doc", "Secret Doc", "secret_folder", [
      server.makeNode("root", "Secret Doc", []),
    ]);

    server.addDocument("inbox_doc", "Inbox", "root_folder", [
      server.makeNode("inbox_root", "Inbox", []),
    ]);
    server.setInbox("inbox_doc", "inbox_root");
  }

  beforeEach(async () => {
    fCtx = await createTestContext(filterSetup, FILTER_ACL_CONFIG);
  });

  afterEach(async () => {
    await fCtx.cleanup();
  });

  test("list_documents excludes denied documents", async () => {
    const result = await callToolOk(fCtx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    expect(all.find((d) => d.file_id === "secret_doc")).toBeUndefined();
    // Public doc should still be present.
    expect(all.find((d) => d.file_id === "public_doc")).toBeDefined();
  });

  test("list_documents excludes denied folders", async () => {
    const result = await callToolOk(fCtx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    expect(all.find((f) => f.file_id === "secret_folder")).toBeUndefined();
  });

  test("list_documents filters denied items from recursive tree", async () => {
    const result = await callToolOk(fCtx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    const allIds = all.map((f) => f.file_id);
    expect(allIds).not.toContain("secret_folder");
    expect(allIds).not.toContain("secret_doc");
  });

  test("list_documents count reflects filtered count", async () => {
    const result = await callToolOk(fCtx.mcpClient, "list_documents");
    const all = flattenTree(result.files as Record<string, unknown>[]);
    const docs = all.filter((f) => f.type === "document");
    expect(result.count).toBe(docs.length);
    // secret_doc should not be included.
    expect(docs.every((d) => d.file_id !== "secret_doc")).toBe(true);
  });

  test("search_documents excludes denied documents", async () => {
    const result = await callToolOk(fCtx.mcpClient, "search_documents", {
      query: "Doc",
    });
    const matches = result.matches as Record<string, unknown>[];
    const secretMatch = matches.find((m) => m.file_id === "secret_doc");
    expect(secretMatch).toBeUndefined();
    const publicMatch = matches.find((m) => m.file_id === "public_doc");
    expect(publicMatch).toBeDefined();
  });

  test("search_documents excludes denied folders", async () => {
    const result = await callToolOk(fCtx.mcpClient, "search_documents", {
      query: "Folder",
      type: "folder",
    });
    const matches = result.matches as Record<string, unknown>[];
    const secretFolder = matches.find((m) => m.file_id === "secret_folder");
    expect(secretFolder).toBeUndefined();
    const publicFolder = matches.find((m) => m.file_id === "public_folder");
    expect(publicFolder).toBeDefined();
  });

  test("search_documents count reflects filtered count", async () => {
    const result = await callToolOk(fCtx.mcpClient, "search_documents", {
      query: "Doc",
    });
    const matches = result.matches as Record<string, unknown>[];
    expect(result.count).toBe(matches.length);
    for (const m of matches) {
      expect(m.file_id).not.toBe("secret_doc");
    }
  });
});
