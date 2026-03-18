# Live Agent Test Plan

Manual test plan for exercising the Dynalist MCP server against a live test account. Focuses on edge cases, parameter combinations, and behaviors that are hard to cover with the automated dummy server tests.

**Prerequisites:**

- Dynalist MCP server running and connected to an MCP client (e.g. Claude Code).
- `DYNALIST_API_TOKEN` pointing to a **test account**, not a real one.
- At least one document with nested content (e.g. the default "Getting started with Dynalist").

## How to run

Tests are designed to run as parallel subagents, each in an isolated folder to prevent cross-contamination. The operator (you) acts as coordinator.

### Step 0: Verify test account

Before any mutations, the agent MUST:

1. Ask the user to confirm this is a test account (not their real Dynalist).
2. Call `list_documents` and verify the results look like a test account (few documents, no real personal data). If the account looks like a real account with substantial content, abort and alert the user.

### Step 1: Create a test root and sub-roots

Use `list_documents` (from step 0) to find the account root folder, then create a single **test root** folder (e.g. "Manual Test 2026-03-14 (a3f)"). The name includes today's date and a short random suffix to avoid collisions across runs. Inside it, create one **sub-root** per test group. Create the sub-root folders in parallel (multiple `create_folder` calls in a single message) to speed up setup:

| Sub-root                | Sections            | Tests |
|-------------------------|---------------------|-------|
| 01-pos-child            | 1a                  | 5     |
| 02-pos-sibling          | 1b                  | 6     |
| 03-pos-index-multi-nest | 1c, 1d, 1e          | 9     |
| 04-enum-heading         | 2a                  | 5     |
| 05-enum-color           | 2b                  | 8     |
| 06-enum-edit            | 2c                  | 6     |
| 07-inbox-invalid        | 2d, 2e, 10          | 7     |
| 08-delete-promote-multi | 3a, 3b              | 5     |
| 09-delete-errors        | 3c, 3d, 3e          | 3     |
| 10-move-positions       | 4a, 4b              | 5     |
| 11-move-reorder-errors  | 4c, 4d, 4e          | 6     |
| 12-version-edit         | 5, 9                | 7     |
| 13-read                 | 6                   | 8     |
| 14-search               | 7                   | 7     |
| 15-file-mgmt-misc       | 8, 11, 12, 13      | 17    |

### Step 2: Spawn subagents

Launch one subagent per sub-root. Each subagent prompt should:

1. Reference this test plan file so the agent can read its assigned sections.
2. Specify the sub-root folder file_id to work within.
3. Instruct the agent to create its own test document(s) inside that folder.
4. Instruct the agent to read back after every write and report PASS/FAIL per test case.
5. Instruct the agent to move on quickly if a test case fails or behaves unexpectedly. Mark it FAIL (or SKIP if untestable) and proceed to the next test. Do not retry in a loop or spend time debugging.

All subagents run in parallel. Since each operates in its own sub-root with its own documents, there is no risk of version conflicts or cross-contamination.

**Note:** Sections 12 (check_document_versions) and 13 (get_recent_changes) read across documents. If other subagents are writing concurrently, these results may be noisy, but this is acceptable. Run all subagents in parallel to keep total execution time down.

### Step 3: Review results

Each subagent returns a PASS/FAIL summary. Collect all summaries and note any failures. For failures, read the agent's detailed output to determine whether the issue is in the MCP server, the tool descriptions, or the test setup.

### Cleanup

The Dynalist API cannot delete documents or folders. After all subagents complete, prompt the user to delete the test root folder in the Dynalist web UI. Since every sub-root and test document lives under the single test root, deleting it removes all test artifacts in one action.

---

## 1. insert_nodes positioning

The `insert_nodes` tool uses a `position` enum with a single `reference_node_id` whose meaning changes depending on the position value.

### 1a. Child positions (first_child / last_child)

- **Append to root (omit reference_node_id):** Insert with `position: "last_child"` and no `reference_node_id`. Verify new nodes appear at the bottom of the document's top-level items.
- **Prepend to root:** Insert with `position: "first_child"` and no `reference_node_id`. Verify new nodes appear at the top.
- **Append under a specific parent:** Insert with `position: "last_child"` and `reference_node_id` set to an existing node that has children. Verify new nodes appear after the last existing child.
- **Prepend under a specific parent:** Insert with `position: "first_child"` and `reference_node_id` set to a node with children. Verify new nodes appear before the first existing child.
- **Insert under a leaf node:** Insert with `position: "last_child"` and `reference_node_id` set to a leaf (no children). Verify the leaf now has children.

### 1b. Sibling positions (after / before)

- **After a specific sibling:** Insert with `position: "after"` and `reference_node_id` set to a non-last sibling. Verify new nodes appear immediately after the reference.
- **Before a specific sibling:** Insert with `position: "before"` and `reference_node_id` set to a non-first sibling. Verify new nodes appear immediately before the reference.
- **After the last sibling:** Insert `position: "after"` on the last child of a parent. Verify new nodes appear at the end.
- **Before the first sibling:** Insert `position: "before"` on the first child. Verify new nodes appear at the start.
- **Root node as sibling reference (error):** Insert with `position: "after"` and `reference_node_id` set to the root node ID. Expect error: root has no parent.
- **Missing reference_node_id for sibling (error):** Insert with `position: "after"` but omit `reference_node_id`. Expect error.

### 1c. Index parameter

- **Explicit index with last_child:** Insert with `position: "last_child"`, `reference_node_id` pointing to a parent with 3 children, `index: 1`. Verify new node appears at index 1 (between first and second existing child).
- **Index 0 with last_child:** Equivalent to first_child. Verify node appears at start.
- **Index -1 with last_child:** Equivalent to appending at end (default behavior).
- **Index with after/before (error):** Insert with `position: "after"` and `index: 0`. Expect error about incompatible parameters.

### 1d. Multi-item ordering

- **Multiple items with last_child:** Insert 3 items with `position: "last_child"`. Verify they appear in input order (not reversed).
- **Multiple items with first_child:** Insert 3 items with `position: "first_child"`. Verify they appear in input order at the start.
- **Multiple items with after:** Insert 3 items with `position: "after"` a reference sibling. Verify they appear in input order after the reference.

### 1e. Nested trees

- **Two-level tree:** Insert a node with children. Verify parent-child relationship in readback.
- **Three-level tree with metadata:** Insert a tree where nodes have heading, color, checkbox, note values. Verify all metadata round-trips correctly.

## 2. String enums: heading and color

All tools that accept heading/color use string enums. Verify the full value space works on insert, edit, and inbox.

### 2a. Heading values on insert_nodes

- Insert a node with `heading: "h1"`. Read back, verify heading is `"h1"`.
- Insert a node with `heading: "h2"`. Read back, verify.
- Insert a node with `heading: "h3"`. Read back, verify.
- Insert a node with `heading: "none"`. Read back, verify heading field is absent (omitted when none).
- Insert a node with no heading field at all. Read back, verify heading field is absent.

### 2b. Color values on insert_nodes

- Insert a node with each color value: `"red"`, `"orange"`, `"yellow"`, `"green"`, `"blue"`, `"purple"`. Read back each, verify correct color.
- Insert a node with `color: "none"`. Read back, verify color field is absent.
- Insert a node with no color field. Read back, verify color field is absent.

### 2c. Heading/color on edit_nodes

- Edit an existing node to set `heading: "h2"`. Read back, verify.
- Edit the same node to set `heading: "none"`. Read back, verify heading is absent.
- Edit a node to set `color: "green"`. Read back, verify.
- Edit the same node to set `color: "none"`. Read back, verify color is absent.
- Edit heading without touching color (and vice versa). Verify the untouched field is preserved.

### 2d. Heading/color on send_to_inbox

- Send to inbox with `heading: "h1"` and `color: "red"`. Read the inbox document, find the new node, verify both values.

### 2e. Invalid values (if not caught by schema)

- Attempt to insert with `heading: "h4"`. Expect schema validation error.
- Attempt to insert with `color: "pink"`. Expect schema validation error.
- Attempt to insert with `heading: 1` (numeric). Expect schema validation error (string required).

## 3. delete_nodes edge cases

### 3a. Promote children

- Create a parent with 3 children. Delete the parent with `children: "promote"`. Verify the 3 children are now siblings of where the parent was.
- Delete a leaf node with `children: "promote"`. Verify `promoted_children: 0` in response.
- Attempt `children: "promote"` with 2 node_ids. Expect error.

### 3b. Multi-node delete

- Create a flat list of 5 siblings. Delete 3 of them in a single call. Verify only the 2 remaining siblings exist.
- Delete a parent and one of its children in the same call. Verify deduplication: child is subsumed by parent deletion, `deleted_count` reflects the full subtree.

### 3c. Root node

- Attempt to delete with `node_ids: ["root"]`. Expect error. (The root node ID is always the literal string `"root"`, so this single test covers the case.)

### 3d. Duplicate node_ids

- Attempt to delete with `node_ids: ["abc", "abc"]`. Expect error about duplicates.

### 3e. Nonexistent node

- Attempt to delete a node_id that does not exist. Expect NodeNotFound error.

## 4. move_nodes edge cases

### 4a. All four positions

- Move a node with `position: "first_child"` of a reference parent. Verify it is now the first child.
- Move a node with `position: "last_child"`. Verify it is now the last child.
- Move a node with `position: "after"` a sibling. Verify placement.
- Move a node with `position: "before"` a sibling. Verify placement.

### 4b. Sequential move semantics

- Move node A after node B, then move node C after node A, in a single `moves` array. Verify final order is B, A, C (second move sees the effect of the first).

### 4c. Same-parent reordering

- Parent has children [A, B, C, D]. Move A to `position: "after"` D. Verify order becomes [B, C, D, A]. This exercises the post-removal index compensation logic.
- Move D to `position: "before"` A. Verify order becomes [D, A, B, C] (moving later node before earlier).

### 4d. Circular move prevention

- Attempt to move a parent node as first_child of one of its own children. Expect error.
- Attempt to move a node as first_child of a grandchild. Expect error.
- Attempt to move a node relative to itself. Expect error about self-reference.

### 4e. Root node

- Attempt to move with `node_id: "root"`. Expect error.

## 5. Version guard

### 5a. Stale version

- Read a document (get sync token T). Make an edit (sync token changes). Attempt another edit with `expected_sync_token: T`. Verify the tool aborts with a stale sync token error and requests a re-read.

### 5b. Version warning

- Two rapid edits where the second uses the sync token from the first read. If a concurrent edit happened between, verify the response includes `sync_warning`.

**Note:** This test requires a concurrent writer and cannot be exercised in a single-agent setup. Mark as SKIP if no concurrent writer is available.

## 6. read_document edge cases

### 6a. Depth limiting

The MCP API cannot set the collapsed state on nodes (it is UI-only), so collapsed-specific behavior cannot be tested here. These tests focus on `max_depth` behavior with non-collapsed nodes.

- Read with `max_depth: 1`. Verify depth-1 nodes show `depth_limited: true`, `child_count` populated, `children: []`.
- Read with `max_depth: null` (unlimited). Verify full depth traversal, no `depth_limited` flags.
- Read with `max_depth: 0`. Only the target node, no children at all.

### 6b. Starting from a specific node

- Read from a node_id that is 3 levels deep. Verify the returned tree is rooted at that node, not the document root.
- Read from a nonexistent node_id. Expect NodeNotFound error.

### 6c. include_checked filtering

- Insert some checked items. Read with `include_checked: false`. Verify checked items and their subtrees are excluded.
- Read with `include_checked: true` (default). Verify checked items are present.

### 6d. include_notes filtering

- Insert items with notes. Read with `include_notes: false`. Verify `note` field is absent on all nodes.
- Read with `include_notes: true` (default). Verify notes are present.

### 6e. Size warnings

To trigger a size warning, first create a document with at least 100 top-level nodes (insert in batches).

- Read the large document without `bypass_warning`. Verify a size warning is returned with narrowing suggestions.
- Re-read with `bypass_warning: true`. Verify content is returned.
- Attempt `bypass_warning: true` on a small document that would not trigger a warning. Expect rejection.

## 7. search_in_document edge cases

### 7a. parent_levels enum

- Search with `parent_levels: "none"`. Verify no `parents` array in matches.
- Search with `parent_levels: "immediate"`. Verify one parent per match.
- Search with `parent_levels: "all"`. Verify full ancestor chain to root.

### 7b. Match in note only

- Create a node with a keyword only in the note, not the content. Search with `search_notes: true`. Verify it is found.
- Search the same keyword with `search_notes: false`. Verify it is NOT found.

## 8. File management edge cases

### 8a. create_document

- Create a document with `index: 0` in a folder with existing documents. Verify it appears first.
- Create a document with default index (-1). Verify it appears last.
- Create a document in a nonexistent folder. Expect error.

### 8b. move_document / move_folder

- Move a document between folders. Verify it disappears from source and appears in destination.
- Attempt to move a document using a folder's file_id (type mismatch for move_document). Expect error.
- Attempt to move a folder using a document's file_id (type mismatch for move_folder). Expect error.

## 9. edit_nodes edge cases

### 9a. Partial updates

- Edit only the `note` field of a node. Verify content, heading, color, show_checkbox, checked are all unchanged.
- Edit only `checked: true` without specifying `show_checkbox`. Verify the node auto-enables checkbox.
- Edit a node with no mutable fields specified. Expect error.

### 9b. Multi-node edit

- Edit 3 nodes in a single call: change content on first, color on second, heading on third. Verify each change applied independently.

### 9c. Clear note

- Set a note on a node. Then edit with `note: ""`. Verify the note is cleared (field absent on readback).

## 10. send_to_inbox edge cases

- Send with empty content (whitespace only). Expect error.
- Send with `checked: true` and no `show_checkbox`. Verify both checked and checkbox are true on readback.
- Send with all metadata: heading, color, show_checkbox, checked, note. Verify full round-trip.

## 11. Error recovery and URL handling

- Pass a Dynalist URL instead of a file_id (e.g. `https://dynalist.io/d/abc123`). Expect schema validation error or the agent should extract the file_id from the URL (per MCP instructions).
- Pass a completely invalid file_id. Expect NotFound error.
- Pass a valid file_id but invalid node_id. Expect NodeNotFound error.

## 12. check_document_versions

- Check versions for multiple documents in one call. Verify each gets a version number.
- Include a nonexistent file_id. Verify it gets version -1.
- Check an empty file_ids array. Verify empty response.

## 13. get_recent_changes edge cases

- Query with `since` as an ISO date string (e.g. "2026-03-01"). Verify date-only treated as start of day.
- Query with `until` as an ISO date string. Verify treated as end of day.
- Query with `since` after `until`. Verify empty results (no error).
- Query with `type: "created"` vs `type: "modified"`. Verify filtering.
- Query with `sort: "oldest_first"`. Verify ascending order.
