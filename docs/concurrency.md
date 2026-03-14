# Concurrency

MCP tool calls happen at agent-turn granularity: the agent reads a document, reasons about it, then issues a write. This gap can be seconds to minutes, far longer than a typical API round-trip. Another user (or another agent session) can edit the document during that window. The server uses a layered defense strategy to detect stale data, minimize race windows, and recover gracefully from partial failures.

## Version guards (compare-and-swap)

Every write tool (`edit_nodes`, `insert_nodes`, `delete_nodes`, `move_nodes`) is wrapped in `withVersionGuard()`, which performs a two-phase version check around the actual write.

### Pre-write check

Before the write executes, the guard calls `checkForUpdates()` to fetch the document's current version and compares it to the `expected_version` the agent passed in. If they differ, the write is aborted with a `VersionMismatchError` before any API mutation occurs. This is the CAS (compare-and-swap) gate: it catches the common case where the agent's cached read is stale because another client edited the document between the agent's `read_document` and the write tool call.

### Post-write check

After the write succeeds, the guard fetches the version again and compares the delta (`postWriteVersion - preWriteVersion`) against the number of API calls the write made (`apiCallCount`). Each `editDocument` call advances the version by exactly 1, so if the delta exceeds `apiCallCount`, another edit occurred concurrently during the write window. The tool returns a `version_warning` string in the response, and the MCP instructions tell the agent to re-read and verify before making further changes.

The post-write check is best-effort: if the version fetch itself fails (network error, rate limit), the write result is still returned with a warning. The write already succeeded; discarding its result would be worse than surfacing uncertainty.

### Multi-batch writes

Tree inserts and large change sets may require multiple `editDocument` calls (one per depth level for inserts, batches of 200 for bulk changes). The version guard tracks the total `apiCallCount` across all batches and validates the cumulative delta. A concurrent edit during any batch is detected.

## Relative positioning

Several tools must resolve a target position (parent + index) before issuing the write. The server computes explicit positions from the current document state rather than relying on ambiguous API defaults, reducing the chance that a concurrent edit shifts the intended target.

### Insert position resolution

The Dynalist API snapshots a node's children at the start of a batch. Sending `index: -1` (append) for every item in a multi-item insert causes them all to resolve to the same position, reversing their order. The `insert_nodes` tool handles this by reading the parent's current child count and assigning each item a distinct sequential index. For single-item inserts, `index: -1` is safe and avoids the read.

For `after`/`before` positioning, the tool reads the reference node's current index from the parent map and computes the target index explicitly.

### Move state simulation

`move_nodes` accepts an array of moves applied sequentially within a single tool call. Later moves must see the effects of earlier ones. The tool builds mutable copies of the document's `childrenMap` and `parentMap`, then for each move:

1. Resolves the target parent and index from the current mutable state.
2. Compensates for the API's post-removal indexing: the API removes the node first, then inserts at the given index. When moving within the same parent and the node is earlier than the target, the removal shifts the target down by 1.
3. Records the API change.
4. Updates the mutable state (removes node from old parent, inserts into new parent, rebuilds parent indices).

This simulation ensures that a sequence like "move A after B, then move C after A" computes correct indices even though A's position changed between the two moves.

The tool also checks for cyclic moves (moving a node into one of its own descendants) against the mutable state, with a depth cap of 1,000 as a safety guard against corrupted cyclic data.

### Deletion ordering

`delete_nodes` collects the full subtree via DFS, then reverses the list so children are deleted before parents. This makes partial failure recoverable: if batching is interrupted (rate limit, network error), only leaf nodes have been deleted and the remaining nodes are still connected to the tree. Retrying the tool re-reads the document, re-collects the surviving subtree, and deletes the rest. Parent-first ordering would orphan children with no way to recover them.

### Child promotion sequencing

When `delete_nodes` is called with `children: "promote"`, the tool first moves all children to be siblings of the target node (one `editDocument` call), then deletes the now-childless node (second call). The sequential ordering ensures the second call operates on the post-move state.

## Cache invalidation

The document store caches recent reads (see [performance.md](performance.md)). Write tools must invalidate the cache to prevent subsequent reads from returning stale data. The version guard's `finally` block calls `store.invalidate(fileId)` regardless of whether the write succeeded or failed. This handles partial failures (e.g., `PartialInsertError` after some nodes were created) where the cached version is stale even though the write did not fully succeed.

`send_to_inbox` also invalidates the inbox document's cache entry after a successful send, since the inbox document's content changed outside the normal version guard flow.

## Document store self-healing

The document store's warm-path version check acts as a secondary defense. When a tool reads a document for planning (e.g., `insert_nodes` reading to resolve the parent's child count), the store calls `checkForUpdates()` before returning the cached response. If the cached version is stale, it evicts the entry and fetches fresh. This means even if the cache was stale before planning started, it is detected and refreshed before the planning logic runs.

## Race simulation testing

The test suite includes dedicated race condition tests across five files:

| File | What it tests |
|---|---|
| `version-guard.test.ts` | Unit tests of the version guard in isolation. |
| `version-guard-post-write-failure.test.ts` | Behavior when the post-write version check itself fails. |
| `version-guard-integration.test.ts` | Every write tool uses the guard correctly; post-write concurrent detection works end-to-end. |
| `version-guard-toctou.test.ts` | TOCTOU races: concurrent edits between the version guard's pre-check and the planning read inside the guarded function. |
| `version-guard-races.test.ts` | Specific race window scenarios during write batches. |

The race tests use a dummy server that provides an `onNextRead(hook)` callback and a `simulateConcurrentEdit(fileId)` method. The hook injects a concurrent edit at a precise point in the tool's execution (e.g., during the planning read, between batch calls), then verifies that the post-write check detects the version delta mismatch and returns a `version_warning`.

Specific scenarios tested include:

- **Insert races.** Multi-item child count race (another client adds a child between the count read and the insert), first-child race, after/before sibling reordering race.
- **Delete races.** Subtree enumeration race (another client adds a child under a target node after enumeration), child promotion race.
- **Move races.** Index race (another client reorders siblings after index computation).
- **Multi-level insert races.** Concurrent edit during a multi-batch depth-level insert.
- **Version regression.** Abnormal case where the version goes backwards between pre and post checks.
- **Partial insert with stale cache.** Verifies that partial insert failures do not return stale cached data on subsequent reads.
