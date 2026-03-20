# Testing

The test suite spans three layers: an automated unit/integration suite that runs against an in-memory mock, race simulation tests that inject concurrent edits at precise points in tool execution, and agent-driven validation that exercises the MCP tools end-to-end against a live Dynalist account.

## Dummy server

All automated tests run against `DummyDynalistServer`, an in-memory implementation of the `DynalistClient` interface. The dummy server replicates the real Dynalist API's behavioral quirks as documented in [dynalist-api-behavior.md](dynalist-api-behavior.md), including:

- **Non-cascading deletes.** Deleting a node orphans its children rather than cascade-deleting them, matching the real API's behavior. This is critical for testing the `delete_items` tool's bottom-up deletion strategy.
- **Batch insert snapshot semantics.** Index `-1` resolves against a snapshot taken before the batch, not the live state. Multiple inserts to the same parent with `-1` all resolve to the same position, reversing their order. The dummy server snapshots `children.length` at batch start.
- **Sequential batch move processing.** Each move in a batch sees the effects of prior moves, matching the real API.
- **Post-removal indexing for moves.** The API removes a node before inserting at the target index. Same-parent moves where the node is earlier than the target require index compensation.
- **Partial edit fields.** Edit actions are partial updates: omitted fields are left unchanged. The dummy server merges only the fields present in the change.
- **Version tracking.** Each `editDocument` call increments the document version by exactly 1, matching the real API's behavior that the version guard relies on.

The dummy server also provides fault injection hooks that the race simulation tests depend on:

- `failEditAfterNCalls(n)`: Makes the nth `editDocument` call throw, simulating a mid-batch network failure.
- `onNextEdit(hook)`: Runs a callback during the next `editDocument` call, used to inject concurrent edits between batches.
- `onNextRead(hook)`: Runs a callback during the next `readDocument` call, used to inject concurrent edits between the version guard's pre-check and the tool's planning read.
- `simulateConcurrentEdit(fileId)`: Increments a document's version without changing content, simulating an external edit.

### API behavior discovery

The behavioral rules the dummy server implements were discovered through exhaustive testing against a live Dynalist account. This brute-force testing uncovered two real API bugs:

1. **Orphaned children on delete.** The API's `action: "delete"` only removes the specified node. Children become orphaned: present in the `nodes` array but unreachable from the tree. The web UI does not have this problem because it uses a separate diff-based sync protocol that recursively removes all descendants. See the [Dynalist forum report](https://talk.dynalist.io/t/api-node-deletion-orphans-the-child-nodes/10071).

2. **Account corruption on root move.** Moving the root node via the API corrupts the entire account. The API does not reject the request; instead, all subsequent API calls across all documents return `LockFail`. The `move_items` tool now validates and rejects root-node moves on the client side. See the [Dynalist forum report](https://talk.dynalist.io/t/api-move-action-on-root-node-breaks-account/10074).

## Test architecture

Tests are organized in two directories:

- `src/tests/*.test.ts`: Unit tests for individual modules (access control, config, document store, version guard, client batching, helpers).
- `src/tests/tools/*.test.ts`: Integration tests that exercise tools through the full MCP protocol stack. Each test creates an MCP server with the dummy client, connects via in-memory transport, and calls tools through the MCP client interface.

The integration test setup (`test-helpers.ts`) wires together the full server stack: `DummyDynalistServer` backing a `DynalistClient`, connected to the real `DocumentStore`, `AccessController`, `VersionGuard`, and tool handlers. This means integration tests exercise the same code paths as production, with only the HTTP layer replaced.

Total test code as of 2026-03-14: ~800 tests and ~14,000 lines across ~20 test files.

## Race simulation testing

Concurrency testing is a first-class concern. The suite includes dedicated race condition tests across five files, using the dummy server's fault injection hooks to simulate concurrent edits at specific points in a tool's execution.

The general pattern:

1. Register a hook (e.g., `onNextRead`) that fires during a specific internal operation.
2. Inside the hook, call `simulateConcurrentEdit(fileId)` to bump the version.
3. Let the tool complete.
4. Assert that the version guard detected the delta mismatch and returned a `sync_warning`.

Specific scenarios tested:

- **Pre-write stale version.** Another client edits the document between the agent's `read_document` and the write tool call. The version guard's pre-check catches this and aborts before any mutation.
- **Mid-batch concurrent edit.** A concurrent edit occurs between batch calls during a multi-level tree insert. The post-write delta check detects the extra version increment.
- **TOCTOU races.** A concurrent edit between the version guard's pre-check and the planning read inside the guarded function. The document store's warm-path version check provides secondary defense.
- **Insert index races.** Another client adds a child between the count read and the insert, causing the append index to be stale.
- **Delete subtree races.** Another client adds a child under a target node after the subtree is enumerated but before deletion completes.
- **Move index races.** Another client reorders siblings after index computation.
- **Post-write check failures.** The version fetch after a write fails (network error, rate limit). The write result is still returned with a warning rather than discarded.
- **Version regression.** The version goes backwards between pre and post checks (abnormal edge case).

See [concurrency.md](concurrency.md) for the design rationale behind version guards and position resolution.

## Agent-driven live testing

Automated tests verify tool logic against the dummy server, but cannot catch issues in the MCP instructions, tool descriptions, or parameter definitions that guide agent behavior. Two layers of agent-driven testing fill this gap.

### Manual test plan

A [comprehensive test plan](live-test-plan.md) covers 13 areas across ~120 test cases, designed for an agent (typically Claude with Opus or Sonnet) connected to a live test Dynalist account via MCP. The test plan includes a "How to run" section describing how to execute the tests as isolated parallel subagents, each in its own sub-root folder under a single test root. Test areas include:

- `insert_items` positioning (child positions, sibling positions, explicit index, multi-item ordering, nested trees).
- String enum round-trips for heading and color across insert, edit, and inbox tools.
- `delete_items` edge cases (promote children, multi-item deduplication, root item rejection).
- `move_items` edge cases (all four positions, sequential move semantics, same-parent reordering, circular move prevention).
- Version guard behavior (stale version rejection, concurrent edit warnings).
- `read_document` depth and collapsed interaction, item filtering, size warnings.
- `search_in_document` with parent levels, note searching, child inclusion.
- File management (create, rename, move documents and folders).
- `edit_items` partial updates and multi-item edits.
- `send_to_inbox` edge cases.
- Error recovery (URL handling, invalid IDs).
- `check_document_versions` and `get_recent_changes` edge cases.

### Weak-model instruction validation

MCP instructions and tool descriptions must be clear enough for any model to follow, not just the most capable one. A [validation harness](../scripts/haiku-validation.ts) tests this by running the same tool workflows with Claude Haiku (the smallest model in the Claude family) against a live test account.

The harness spawns non-interactive Claude CLI sessions, each executing a natural-language prompt that requires the model to interpret tool descriptions, follow MCP instructions, and compose multi-step workflows. Tasks are organized into parallel pipelines, each operating in an isolated root folder to prevent cross-pipeline interference:

- **Positioning pipeline.** Tests all `insert_items` position values: `after`, `before`, `first_child`, `last_child`, with and without `reference_item_id`.
- **Enums pipeline.** Tests heading/color string enum values on insert, edit, clear, and inbox. Tests nested tree insertion with metadata.
- **Edit pipeline.** Tests content edits, note updates, checkbox toggling, and version guard compliance (passing `expected_sync_token` from a prior read).
- **Search pipeline.** Tests `search_in_document` with `parent_levels: "all"`, note searching, depth-limited item expansion, and URL-to-file-ID extraction.
- **Delete/move pipeline.** Tests `delete_items` with promote, multi-item delete, `move_items` with after and first_child positioning.
- **File management pipeline.** Tests create, rename, and move operations for both documents and folders.

A Sonnet coordinator creates the isolated root folders before the Haiku pipelines run and cleans up afterwards. Results are saved per-task with stdout, stderr, exit code, and elapsed time.

The initial validation run (16 tasks, round 1) and expanded run (6 pipelines, ~40 tasks, round 2) both achieved 100% pass rates, confirming the instructions are clear enough for the weakest model in the family. Any future instruction changes should be re-validated by running the harness against a test account.
