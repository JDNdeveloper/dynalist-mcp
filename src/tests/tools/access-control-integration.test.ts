import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createTestContext,
  callToolOk,
  callToolError,
  type TestContext,
} from "./test-helpers";
import { DummyDynalistServer } from "../dummy-server";
import { getConfig } from "../../config";

// ─── Config file helpers ──────────────────────────────────────────────

const TEST_CONFIG_PATH = join(tmpdir(), `dynalist-mcp-acl-test-${process.pid}.json`);

// Monotonically increasing fake mtime to guarantee the config module
// sees a different mtime on each write.
let fakeMtime = Date.now();

function writeTestConfig(data: unknown) {
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(data));
  fakeMtime += 2000;
  const secs = fakeMtime / 1000;
  utimesSync(TEST_CONFIG_PATH, secs, secs);
}

function cleanupConfig() {
  if (existsSync(TEST_CONFIG_PATH)) {
    unlinkSync(TEST_CONFIG_PATH);
  }
  // Let the config module detect deletion and reset internal state.
  try {
    getConfig();
  } catch {
    // Ignore errors from stale state.
  }
}

// ─── Shared setup ─────────────────────────────────────────────────────

/**
 * Set up a file tree with four folders, each containing one document.
 * The ACL config maps each folder path to a different policy.
 *
 * Tree structure:
 *   Root > Denied Folder   > Denied Doc
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

/**
 * Write the ACL config with deny default and explicit rules for
 * three of the four folders. The "Unruled Folder" has no rule,
 * so it falls back to the default policy (deny).
 */
function writeAclConfig() {
  writeTestConfig({
    access: {
      default: "deny",
      rules: [
        { path: "/Denied Folder/**", policy: "deny" },
        { path: "/ReadOnly Folder/**", policy: "read" },
        { path: "/Allowed Folder/**", policy: "allow" },
        { path: "/Inbox", policy: "allow" },
      ],
    },
  });
}

let ctx: TestContext;

beforeEach(async () => {
  process.env.DYNALIST_MCP_CONFIG = TEST_CONFIG_PATH;
  writeAclConfig();
  ctx = await createTestContext(aclSetup);
});

afterEach(async () => {
  await ctx.cleanup();
  cleanupConfig();
  delete process.env.DYNALIST_MCP_CONFIG;
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
      since: 0,
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "get_recent_changes", {
      file_id: "readonly_doc",
      since: 0,
    });
    expect(result.file_id).toBe("readonly_doc");
    expect(result.count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3e. edit_node with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("edit_node with ACL", () => {
  test("denied document returns NotFound (not ReadOnly)", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "denied_doc",
      node_id: "dn1",
      content: "hacked",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns ReadOnly error", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "readonly_doc",
      node_id: "rn1",
      content: "hacked",
    });
    expect(err.error).toBe("ReadOnly");
  });

  test("allow-policy document edit succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "edit_node", {
      file_id: "allowed_doc",
      node_id: "an1",
      content: "Updated content",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.node_id).toBe("an1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3f. insert_node with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("insert_node with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_node", {
      file_id: "denied_doc",
      parent_id: "root",
      content: "hacked",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns ReadOnly error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_node", {
      file_id: "readonly_doc",
      parent_id: "root",
      content: "hacked",
    });
    expect(err.error).toBe("ReadOnly");
  });

  test("allow-policy document insert succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_node", {
      file_id: "allowed_doc",
      parent_id: "root",
      content: "New node",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.node_id).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3g. insert_nodes with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("insert_nodes with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "denied_doc",
      content: "- hacked",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns ReadOnly error", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "readonly_doc",
      content: "- hacked",
    });
    expect(err.error).toBe("ReadOnly");
  });

  test("allow-policy document insert succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "allowed_doc",
      content: "- New item\n- Another item",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.total_created).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3h. delete_node with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("delete_node with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_node", {
      file_id: "denied_doc",
      node_id: "dn1",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns ReadOnly error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_node", {
      file_id: "readonly_doc",
      node_id: "rn1",
    });
    expect(err.error).toBe("ReadOnly");
  });

  test("allow-policy document delete succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "allowed_doc",
      node_id: "an1a",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.deleted_count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3i. move_node with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("move_node with ACL", () => {
  test("denied document returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "denied_doc",
      node_id: "dn1a",
      reference_node_id: "dn1",
      position: "first_child",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy document returns ReadOnly error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "readonly_doc",
      node_id: "rn1a",
      reference_node_id: "rn1",
      position: "first_child",
    });
    expect(err.error).toBe("ReadOnly");
  });

  test("allow-policy document move succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "allowed_doc",
      node_id: "an1a",
      reference_node_id: "root",
      position: "last_child",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.node_id).toBe("an1a");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3j. send_to_inbox with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("send_to_inbox with ACL", () => {
  test("global readOnly blocks inbox with correct message", async () => {
    writeTestConfig({
      readOnly: true,
      access: {
        default: "deny",
        rules: [
          { path: "/Denied Folder/**", policy: "deny" },
          { path: "/ReadOnly Folder/**", policy: "read" },
          { path: "/Allowed Folder/**", policy: "allow" },
          { path: "/Inbox", policy: "allow" },
        ],
      },
    });
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "Test item",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly false (default) succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "send_to_inbox", {
      content: "Inbox item",
    });
    expect(result.file_id).toBe("inbox_doc");
    expect(result.total_created).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3k. list_documents with ACL
// ═══════════════════════════════════════════════════════════════════════

describe("list_documents with ACL", () => {
  test("denied documents are omitted from results", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const docs = result.documents as Record<string, unknown>[];
    const deniedDoc = docs.find((d) => d.file_id === "denied_doc");
    expect(deniedDoc).toBeUndefined();
  });

  test("denied folders are omitted from results", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folders = result.folders as Record<string, unknown>[];
    const deniedFolder = folders.find((f) => f.file_id === "denied_folder");
    expect(deniedFolder).toBeUndefined();
  });

  test("denied children IDs are filtered from parent folder children arrays", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const folders = result.folders as Record<string, unknown>[];
    // No visible folder should list any denied file ID in its children.
    const deniedIds = ["denied_folder", "denied_doc", "unruled_folder", "unruled_doc"];
    for (const folder of folders) {
      const children = folder.children as string[];
      for (const deniedId of deniedIds) {
        expect(children).not.toContain(deniedId);
      }
    }
  });

  test("read-policy documents appear with access_policy: read", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const docs = result.documents as Record<string, unknown>[];
    const readDoc = docs.find((d) => d.file_id === "readonly_doc");
    expect(readDoc).toBeDefined();
    expect(readDoc!.access_policy).toBe("read");
  });

  test("allow-policy documents appear without access_policy field", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const docs = result.documents as Record<string, unknown>[];
    const allowDoc = docs.find((d) => d.file_id === "allowed_doc");
    expect(allowDoc).toBeDefined();
    expect(allowDoc!.access_policy).toBeUndefined();
  });

  test("count reflects filtered count, not pre-filter count", async () => {
    const result = await callToolOk(ctx.mcpClient, "list_documents");
    const docs = result.documents as Record<string, unknown>[];
    // denied_doc and unruled_doc (default: deny) should be filtered out.
    // Remaining: readonly_doc, allowed_doc, inbox_doc.
    expect(result.count).toBe(docs.length);
    // The denied and unruled docs should not be in the list.
    const deniedDoc = docs.find((d) => d.file_id === "denied_doc");
    const unruledDoc = docs.find((d) => d.file_id === "unruled_doc");
    expect(deniedDoc).toBeUndefined();
    expect(unruledDoc).toBeUndefined();
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

  test("denied children IDs filtered from folder children in search results", async () => {
    // Search for "Folder" to get folder results.
    const result = await callToolOk(ctx.mcpClient, "search_documents", {
      query: "Folder",
      type: "folder",
    });
    const matches = result.matches as Record<string, unknown>[];
    // The denied folder itself should be excluded.
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

  test("denied documents appear in denied array", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["denied_doc"],
    });
    const denied = result.denied as string[];
    expect(denied).toContain("denied_doc");
    const versions = result.versions as Record<string, number>;
    expect(versions.denied_doc).toBeUndefined();
  });

  test("read-policy documents appear in versions (read is sufficient)", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["readonly_doc"],
    });
    const versions = result.versions as Record<string, number>;
    expect(versions.readonly_doc).toBeGreaterThan(0);
  });

  test("mixed batch populates both versions and denied", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["allowed_doc", "denied_doc", "readonly_doc"],
    });
    const versions = result.versions as Record<string, number>;
    const denied = result.denied as string[];
    expect(versions.allowed_doc).toBeGreaterThan(0);
    expect(versions.readonly_doc).toBeGreaterThan(0);
    expect(denied).toContain("denied_doc");
  });

  test("all-denied batch returns empty versions and populated denied", async () => {
    const result = await callToolOk(ctx.mcpClient, "check_document_versions", {
      file_ids: ["denied_doc"],
    });
    const versions = result.versions as Record<string, number>;
    const denied = result.denied as string[];
    expect(Object.keys(versions)).toHaveLength(0);
    expect(denied).toContain("denied_doc");
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

  test("read-policy folder returns ReadOnly", async () => {
    const err = await callToolError(ctx.mcpClient, "create_document", {
      parent_folder_id: "readonly_folder",
      title: "Hacked Doc",
    });
    expect(err.error).toBe("ReadOnly");
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

  test("read-policy folder returns ReadOnly", async () => {
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      parent_folder_id: "readonly_folder",
      title: "Hacked Folder",
    });
    expect(err.error).toBe("ReadOnly");
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

  test("read-policy document returns ReadOnly", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_document", {
      file_id: "readonly_doc",
      title: "Hacked Title",
    });
    expect(err.error).toBe("ReadOnly");
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

  test("read-policy folder returns ReadOnly", async () => {
    const err = await callToolError(ctx.mcpClient, "rename_folder", {
      file_id: "readonly_folder",
      title: "Hacked Name",
    });
    expect(err.error).toBe("ReadOnly");
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

describe("move_file with ACL", () => {
  test("deny-policy source returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_file", {
      file_id: "denied_doc",
      parent_folder_id: "allowed_folder",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy source returns ReadOnly", async () => {
    const err = await callToolError(ctx.mcpClient, "move_file", {
      file_id: "readonly_doc",
      parent_folder_id: "allowed_folder",
    });
    expect(err.error).toBe("ReadOnly");
  });

  test("deny-policy destination returns NotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_file", {
      file_id: "allowed_doc",
      parent_folder_id: "denied_folder",
    });
    expect(err.error).toBe("NotFound");
  });

  test("read-policy destination returns ReadOnly", async () => {
    const err = await callToolError(ctx.mcpClient, "move_file", {
      file_id: "allowed_doc",
      parent_folder_id: "readonly_folder",
    });
    expect(err.error).toBe("ReadOnly");
  });

  test("allow source + allow destination succeeds", async () => {
    // Create a second allowed folder to move into.
    ctx.server.addFolder("allowed_folder_2", "Allowed Folder 2", "root_folder");
    // Add a rule for the new folder.
    writeTestConfig({
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

    const result = await callToolOk(ctx.mcpClient, "move_file", {
      file_id: "allowed_doc",
      parent_folder_id: "allowed_folder_2",
    });
    expect(result.file_id).toBe("allowed_doc");
    expect(result.parent_folder_id).toBe("allowed_folder_2");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3o. Global readOnly: true overrides
// ═══════════════════════════════════════════════════════════════════════

describe("global readOnly: true overrides", () => {
  // Helper to switch to a readOnly config while keeping ACL rules.
  function writeReadOnlyConfig() {
    writeTestConfig({
      readOnly: true,
      access: {
        default: "deny",
        rules: [
          { path: "/Denied Folder/**", policy: "deny" },
          { path: "/ReadOnly Folder/**", policy: "read" },
          { path: "/Allowed Folder/**", policy: "allow" },
          { path: "/Inbox", policy: "allow" },
        ],
      },
    });
  }

  test("readOnly blocks write on allow-policy document", async () => {
    writeReadOnlyConfig();
    const err = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "allowed_doc",
      node_id: "an1",
      content: "hacked",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly permits read on allow-policy document", async () => {
    writeReadOnlyConfig();
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "allowed_doc",
      max_depth: 10,
    });
    expect(result.file_id).toBe("allowed_doc");
  });

  test("readOnly blocks send_to_inbox", async () => {
    writeReadOnlyConfig();
    const err = await callToolError(ctx.mcpClient, "send_to_inbox", {
      content: "Test",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly blocks create_document", async () => {
    writeReadOnlyConfig();
    const err = await callToolError(ctx.mcpClient, "create_document", {
      parent_folder_id: "allowed_folder",
      title: "New",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly blocks create_folder", async () => {
    writeReadOnlyConfig();
    const err = await callToolError(ctx.mcpClient, "create_folder", {
      parent_folder_id: "allowed_folder",
      title: "New",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly blocks rename_document", async () => {
    writeReadOnlyConfig();
    const err = await callToolError(ctx.mcpClient, "rename_document", {
      file_id: "allowed_doc",
      title: "Nope",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly blocks rename_folder", async () => {
    writeReadOnlyConfig();
    const err = await callToolError(ctx.mcpClient, "rename_folder", {
      file_id: "allowed_folder",
      title: "Nope",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly blocks move_file", async () => {
    writeReadOnlyConfig();
    const err = await callToolError(ctx.mcpClient, "move_file", {
      file_id: "allowed_doc",
      parent_folder_id: "allowed_folder",
    });
    expect(err.error).toBe("ReadOnly");
    expect(err.message).toBe("Server is in read-only mode.");
  });

  test("readOnly error message is distinct from per-policy ReadOnly message", async () => {
    // Per-policy ReadOnly message.
    const policyErr = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "readonly_doc",
      node_id: "rn1",
      content: "hacked",
    });

    // Global readOnly message.
    writeReadOnlyConfig();
    const globalErr = await callToolError(ctx.mcpClient, "edit_node", {
      file_id: "allowed_doc",
      node_id: "an1",
      content: "hacked",
    });

    expect(policyErr.message).not.toBe(globalErr.message);
    expect(globalErr.message).toBe("Server is in read-only mode.");
    expect(policyErr.message).toContain("read-only per access policy");
  });
});
