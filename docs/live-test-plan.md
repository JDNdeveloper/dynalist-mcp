# Live Agent Test Plan

Happy-path verification that the MCP server works against the real Dynalist API. Edge cases, error handling, and exhaustive enum coverage belong in the automated unit/integration tests against the dummy server. The live test catches API behavior mismatches, not server logic bugs.

**Prerequisites:**

- Dynalist MCP server running and connected to an MCP client (e.g. Claude Code).
- `DYNALIST_API_TOKEN` pointing to a **test account**, not a real one.
- Inbox document set in the test account (Settings > Inbox location in the Dynalist web UI). Required for `send_to_inbox` tests.

## How to run

Tests are designed to run as parallel subagents, each in an isolated folder to prevent cross-contamination. The operator (you) acts as coordinator.

### Step 0: Set up working directory with pre-allowed permissions

Subagents cannot interactively approve MCP tool permissions. To avoid agents blocking on permission prompts, the coordinator must run from a temporary working directory with a `.claude/settings.local.json` that pre-allows all Dynalist MCP tools. Claude Code resolves `.claude/settings.local.json` from the **project directory**, not the shell cwd, so the coordinator must be launched from this directory (not just `cd` into it mid-session).

Run `pwd` to verify the working directory is `/tmp/dynalist-live-test`. If it is, confirm that `.claude/settings.local.json` exists and contains the expected permissions listed below. If the file is missing or incomplete, create or fix it before proceeding. If the working directory is not `/tmp/dynalist-live-test`:

1. Create `/tmp/dynalist-live-test/.claude/` and write the following `settings.local.json`, replacing `<project-dir>` with the **absolute path** to the dynalist-mcp repo, with the leading `/` doubled to `//`. Derive the path from the path the user gave you for this test plan file (e.g. if they said `~/dynalist-mcp/docs/live-test-plan.md`, resolve `~` to get `/Users/alice/dynalist-mcp`, then double the leading slash to get `//Users/alice/dynalist-mcp`). The `//` prefix is required because Claude Code interprets a single leading `/` as relative to the project root, not the filesystem root. Do NOT prepend `//` to the absolute path (that would produce `///Users/...`); replace the existing leading `/` so the result has exactly two slashes:

```json
{
  "permissions": {
    "allow": [
      "mcp__dynalist__list_documents",
      "mcp__dynalist__read_document",
      "mcp__dynalist__search_documents",
      "mcp__dynalist__search_in_document",
      "mcp__dynalist__check_document_versions",
      "mcp__dynalist__get_recent_changes",
      "mcp__dynalist__insert_items",
      "mcp__dynalist__edit_items",
      "mcp__dynalist__delete_items",
      "mcp__dynalist__move_items",
      "mcp__dynalist__send_to_inbox",
      "mcp__dynalist__create_document",
      "mcp__dynalist__create_folder",
      "mcp__dynalist__rename_document",
      "mcp__dynalist__rename_folder",
      "mcp__dynalist__move_document",
      "mcp__dynalist__move_folder",
      "Read(<project-dir>/docs/**)"
    ]
  }
}
```

See `scripts/haiku-validation.ts` (`writeWorkDirSettings`) for the reference implementation.

2. Tell the user to run `cd /tmp/dynalist-live-test` in their terminal and re-launch Claude Code from there.

### Step 0.5: Verify test account

Before any mutations, the agent MUST:

1. Ask the user to confirm this is a test account (not their real Dynalist).
2. Call `list_documents` and verify the results look like a test account (few documents, no real personal data). If the account looks like a real account with substantial content, abort and alert the user.

### Step 1: Create a test root and sub-roots

Use `list_documents` (from step 0.5) to find the account root folder, then create a single **test root** folder (e.g. "Live Test 2026-03-14 (a3f)"). The name includes today's date and a short random suffix to avoid collisions across runs. Inside it, create one **sub-root** per test group. Create the sub-root folders in parallel (multiple `create_folder` calls in a single message) to speed up setup:

| Sub-root       | Tests |
|----------------|-------|
| 01-insert      | ~6    |
| 02-edit        | ~3    |
| 03-delete      | ~2    |
| 04-move        | ~4    |
| 05-read-search | ~4    |
| 06-inbox       | ~2    |
| 07-file-mgmt   | ~8    |

Agent 06 (inbox) does not use its sub-root folder since it only sends to the account inbox. Create the folder anyway for naming consistency.

### Step 2: Spawn subagents

Launch one subagent per sub-root (7 total, all in parallel). Each subagent prompt should:

1. Reference this test plan file so the agent can read its assigned section.
2. Specify the sub-root folder file_id to work within.
3. Instruct the agent to create its own test document(s) inside that folder.
4. Instruct the agent to read back after every write and report PASS/FAIL per test case.
5. Instruct the agent to move on quickly if a test case fails or behaves unexpectedly. Mark it FAIL (or SKIP if untestable) and proceed to the next test. Do not retry in a loop or spend time debugging.
6. Instruct the agent to grade each test case from 1 to 5 stars based on how easy it was to complete using the MCP tools and instructions. 5 stars means it worked smoothly with no friction. 4 stars means it worked but hit minor snags (e.g. unclear parameter semantics, needed an extra read). 3 stars means it required significant effort or workarounds. 2 stars means it barely worked. 1 star means it failed or was essentially unusable. Include the star rating next to each PASS/FAIL result.
7. Include the confirmation override (see below).

**Confirmation override:** This test runs against a verified test account. The Dynalist MCP instruction to "preview changes and stop" and "wait for the user to explicitly confirm" does NOT apply during live testing. Subagent prompts must include the following override so agents are not blocked waiting for human confirmation:

> **IMPORTANT**: This is an automated test running against a test Dynalist account. There is no human to confirm or approve changes. OVERRIDE: The Dynalist MCP instruction to "preview changes and stop" and "wait for the user to explicitly confirm" does NOT apply here. That rule is suspended for this session. You MUST call mutating Dynalist tools directly without previewing, confirming, or asking for approval.

All subagents run in parallel. Since each operates in its own sub-root with its own documents, there is no risk of version conflicts or cross-contamination.

### Step 3: Aggregate results

After all subagents return, collect results into a single summary table:

| Agent | Test | Result | Stars | Notes |
|-------|------|--------|-------|-------|

For each failure, read the agent's detailed output to determine whether the issue is in the MCP server, the tool descriptions, or the test setup. Review star ratings to identify usability pain points: any test case rated below 5 stars warrants investigation into whether tool descriptions, MCP instructions, or parameter semantics can be improved.

### Cleanup

The Dynalist API cannot delete documents or folders. After all subagents complete, prompt the user to delete the test root folder in the Dynalist web UI. Since every sub-root and test document lives under the single test root, deleting it removes all test artifacts in one action. Also clean up the temporary working directory created in step 0 (`rm -rf /tmp/dynalist-live-test`).

---

## Agent 01: insert_items

Create a test document "Insert Tests" in the sub-root folder.

### Setup

Call `read_document` on the new document to get the initial `sync_token`. Then call `insert_items` once to create the following structure:

```
• Existing Parent
  • Child A
  • Child B
  • Child C
```

Extract the `item_id` for each item from the response. Read back the document to get the updated `sync_token`.

### Test 1a: Insert at root as first_child

Call `insert_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "content": "Root First" }]`
- (no `reference_item_id`)
- `position`: `"first_child"`

Read back the document. **PASS** if `Root First` is the first top-level item. **FAIL** otherwise.

### Test 1b: Insert at root as last_child

Call `insert_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "content": "Root Last" }]`
- (no `reference_item_id`)
- `position`: `"last_child"`

Read back the document. **PASS** if `Root Last` is the last top-level item. **FAIL** otherwise.

### Test 1c: Insert under a parent as last_child

Call `insert_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "content": "New Sibling" }]`
- `reference_item_id`: item_id of `Existing Parent`
- `position`: `"last_child"`

Read back the document. **PASS** if children of `Existing Parent` are `[Child A, Child B, Child C, New Sibling]` in that order. **FAIL** otherwise.

### Test 1d: Insert after a sibling

Call `insert_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "content": "After Child A" }]`
- `reference_item_id`: item_id of `Child A`
- `position`: `"after"`

Read back. **PASS** if children of `Existing Parent` are `[Child A, After Child A, Child B, Child C, New Sibling]` in that order. **FAIL** otherwise.

### Test 1e: Insert before a sibling

Call `insert_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "content": "Before Child C" }]`
- `reference_item_id`: item_id of `Child C`
- `position`: `"before"`

Read back. **PASS** if children of `Existing Parent` include `[..., Before Child C, Child C, ...]` with `Before Child C` immediately before `Child C`. **FAIL** otherwise.

### Test 1f: Insert with nested tree and metadata

Call `insert_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`:
  ```json
  [{
    "content": "H1 Parent",
    "heading": "h1",
    "color": "blue",
    "note": "Parent note",
    "children": [{
      "content": "Checkbox Child",
      "show_checkbox": true,
      "checked": true,
      "color": "green"
    }]
  }]
  ```
- `position`: `"last_child"`

Read back the document. **PASS** if all of the following are true:
- `H1 Parent` exists with `heading: "h1"`, `color: "blue"`, `note: "Parent note"`.
- `H1 Parent` has one child `Checkbox Child` with `show_checkbox: true`, `checked: true`, `color: "green"`.

**FAIL** if any metadata value is missing or incorrect.

---

## Agent 02: edit_items

Create a test document "Edit Tests" in the sub-root folder.

### Setup

Call `read_document` on the new document to get the initial `sync_token`. Then call `insert_items` once to create:

```
• Edit Target A
• Edit Target B
```

Include metadata on `Edit Target A` in the same insert call: `note: "Original note"`, `heading: "h1"`, `color: "red"`. Read back to get item_ids and the updated sync_token.

### Test 2a: Edit content

Call `edit_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "item_id": <Edit Target A>, "content": "Renamed A" }]`

Read back. **PASS** if the item's content is `Renamed A` and `heading`, `color`, and `note` are all unchanged (`heading: "h1"`, `color: "red"`, `note: "Original note"`). **FAIL** otherwise.

### Test 2b: Edit metadata (heading + color)

Call `edit_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "item_id": <Edit Target B>, "heading": "h2", "color": "purple" }]`

Read back. **PASS** if `Edit Target B` has `heading: "h2"` and `color: "purple"`, and content is unchanged. **FAIL** otherwise.

### Test 2c: Clear a note

Call `edit_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `items`: `[{ "item_id": <Edit Target A>, "note": "" }]`

Read back. **PASS** if the `note` field is absent (cleared) on `Edit Target A`, and all other fields (`content`, `heading`, `color`) are unchanged. **FAIL** otherwise.

---

## Agent 03: delete_items

Create a test document "Delete Tests" in the sub-root folder.

### Setup

Call `read_document` on the new document to get the initial `sync_token`. Then call `insert_items` once to create:

```
• Keep A
• Delete Me 1
• Delete Me 2
• Delete Me 3
• Keep B
```

Read back to get item_ids and the updated sync_token.

### Test 3a: Delete a single item

Call `delete_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `item_ids`: `[<Delete Me 1>]`

Read back. **PASS** if `Delete Me 1` is gone and `Keep A`, `Delete Me 2`, `Delete Me 3`, `Keep B` remain in order. **FAIL** otherwise.

### Test 3b: Delete multiple items in one call

Call `delete_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `item_ids`: `[<Delete Me 2>, <Delete Me 3>]`

Read back. **PASS** if only `Keep A` and `Keep B` remain. **FAIL** otherwise.

---

## Agent 04: move_items

Create a test document "Move Tests" in the sub-root folder.

### Setup

Call `read_document` on the new document to get the initial `sync_token`. Then call `insert_items` once to create:

```
• Move Source
• Target Parent
  • Target Child A
  • Target Child B
```

Read back to get item_ids and the updated sync_token.

Tests 4a, 4b, and 4c are sequential: each depends on the prior move's final state. If a test fails, SKIP all subsequent tests in this agent.

### Test 4a: Move as first_child

Call `move_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `moves`: `[{ "item_id": <Move Source>, "reference_item_id": <Target Parent>, "position": "first_child" }]`

Read back. **PASS** if children of `Target Parent` are `[Move Source, Target Child A, Target Child B]` in that order. **FAIL** otherwise.

### Test 4b: Move as last_child

Call `move_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `moves`: `[{ "item_id": <Move Source>, "reference_item_id": <Target Parent>, "position": "last_child" }]`

(Note: `Move Source` is currently `first_child` of `Target Parent` from test 4a.)

Read back. **PASS** if children of `Target Parent` are `[Target Child A, Target Child B, Move Source]` in that order. **FAIL** otherwise.

### Test 4c: Move after a sibling

Call `move_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `moves`: `[{ "item_id": <Move Source>, "reference_item_id": <Target Child A>, "position": "after" }]`

(Note: `Move Source` is currently `last_child` of `Target Parent` from test 4b.)

Read back. **PASS** if children of `Target Parent` are `[Target Child A, Move Source, Target Child B]` in that order. **FAIL** otherwise.

### Test 4d: Move before a sibling

Call `move_items` with:
- `file_id`: test document
- `expected_sync_token`: current sync token
- `moves`: `[{ "item_id": <Move Source>, "reference_item_id": <Target Child B>, "position": "before" }]`

(Note: `Move Source` is currently between `Target Child A` and `Target Child B` from test 4c.)

Read back. **PASS** if children of `Target Parent` are `[Target Child A, Move Source, Target Child B]` in that order (unchanged, since "before Target Child B" is the same position). **FAIL** otherwise.

---

## Agent 05: read_document and search_in_document

Create a test document "Read Search Tests" in the sub-root folder.

### Setup

Call `read_document` on the new document to get the initial `sync_token`. Then call `insert_items` once to create:

```
• Level 1 Alpha
  • Level 2 Beta
    • Level 3 Gamma
      • Level 4 Delta
• Searchable Item
• Note Holder
```

Include metadata in the same insert call: set `Note Holder` with `note: "secret keyword hydra"` and `Searchable Item` with `note: "visible text"`. Read back to get item_ids and the updated sync_token.

### Test 5a: Read with max_depth

Call `read_document` with:
- `file_id`: test document
- `max_depth`: `1`

**PASS** if all of the following are true:
- `Level 1 Alpha` is present with `depth_limited: true` and `child_count: 1`.
- `Searchable Item` is present without `depth_limited`.
- `Level 2 Beta` is NOT in the output (depth limited).

**FAIL** otherwise.

### Test 5b: Read from a specific item_id

Call `read_document` with:
- `file_id`: test document
- `item_id`: item_id of `Level 2 Beta`
- `max_depth`: `null` (unlimited)

**PASS** if the returned tree is rooted at `Level 2 Beta` and contains `Level 3 Gamma` and `Level 4 Delta` as descendants. `Level 1 Alpha` must NOT appear. **FAIL** otherwise.

### Test 5c: Search with parent_levels

Call `search_in_document` with:
- `file_id`: test document
- `query`: `"Gamma"`
- `parent_levels`: `"all"`

**PASS** if the match for `Level 3 Gamma` includes a `parents` array containing `Level 2 Beta` and `Level 1 Alpha` (in ancestor order). **FAIL** otherwise.

### Test 5d: Search in notes

Call `search_in_document` with:
- `file_id`: test document
- `query`: `"hydra"`
- `search_notes`: `true`

**PASS** if `Note Holder` is found. **FAIL** if no match.

Then call `search_in_document` with:
- `file_id`: test document
- `query`: `"hydra"`
- `search_notes`: `false`

**PASS** if no match is returned (the keyword is only in the note). **FAIL** if a match is found.

---

## Agent 06: send_to_inbox

No test document creation needed. This agent sends items to the inbox and reads them back. The inbox `file_id` is not known in advance; extract it from the `send_to_inbox` response.

### Test 6a: Send with metadata

Call `send_to_inbox` with:
- `content`: `"Inbox Test With Metadata"`
- `heading`: `"h1"`
- `color`: `"red"`
- `note`: `"Inbox note"`

Extract `file_id` from the response. Call `read_document` with that `file_id`. Find the item matching `Inbox Test With Metadata`. **PASS** if the item exists with `heading: "h1"`, `color: "red"`, `note: "Inbox note"`. **FAIL** otherwise.

### Test 6b: Send plain item

Call `send_to_inbox` with:
- `content`: `"Plain Inbox Item"`

Call `read_document` with the inbox `file_id` from test 6a. Find the item matching `Plain Inbox Item`. **PASS** if the item exists with no heading, no color, no note. **FAIL** otherwise.

---

## Agent 07: File management, check_document_versions, get_recent_changes

This agent tests file-level operations. It works within the sub-root folder. Tests 7a-7c are sequential: each depends on the prior test's result. If a test fails, SKIP all subsequent tests through 7c.

### Test 7a: Create a document

Call `create_document` with:
- `title`: `"File Mgmt Doc"`
- `reference_file_id`: sub-root folder file_id

Extract the `file_id` from the response. Call `list_documents`. **PASS** if a document named `File Mgmt Doc` exists under the sub-root folder. **FAIL** otherwise.

### Test 7b: Rename the document

Call `rename_document` with:
- `file_id`: file_id of `File Mgmt Doc`
- `title`: `"Renamed Doc"`

Call `list_documents`. **PASS** if the document is now named `Renamed Doc`. **FAIL** otherwise.

### Test 7c: Move document between folders

Call `create_folder` with:
- `title`: `"Destination Folder"`
- `reference_file_id`: sub-root folder file_id

Call `move_document` with:
- `file_id`: file_id of `Renamed Doc`
- `reference_file_id`: file_id of `Destination Folder`

Call `list_documents`. **PASS** if `Renamed Doc` is now under `Destination Folder` and no longer directly under the sub-root. **FAIL** otherwise.

### Test 7d: Create document with position: first_child

Call `create_document` with:
- `title`: `"First Doc"`
- `reference_file_id`: sub-root folder file_id
- `position`: `"first_child"`

Call `list_documents`. **PASS** if `First Doc` is the first child of the sub-root folder. **FAIL** otherwise.

### Test 7e: Create document with position: after

Call `create_document` with:
- `title`: `"After First"`
- `reference_file_id`: file_id of `First Doc`
- `position`: `"after"`

Call `list_documents`. **PASS** if `After First` appears immediately after `First Doc` in the sub-root folder. **FAIL** otherwise.

### Test 7f: Move folder with position: before

Call `move_folder` with:
- `file_id`: file_id of `Destination Folder`
- `reference_file_id`: file_id of `First Doc`
- `position`: `"before"`

Call `list_documents`. **PASS** if `Destination Folder` appears immediately before `First Doc` in the sub-root folder. **FAIL** otherwise.

### Test 7g: Check document versions

Call `create_document` with `title: "Version Check Doc"` and `reference_file_id: <sub-root folder file_id>`. Call `check_document_versions` with:
- `file_ids`: `[<Renamed Doc file_id>, <Version Check Doc file_id>]`

**PASS** if the response contains a `sync_tokens` map with entries for both file_ids. **FAIL** otherwise.

### Test 7h: Get recent changes

Call `get_recent_changes` with:
- `file_id`: file_id of `Renamed Doc`
- `since`: today's date in ISO 8601 format (e.g. `"2026-03-20"`)

**PASS** if the response includes at least one match. **FAIL** if the response is empty or contains no matches.
