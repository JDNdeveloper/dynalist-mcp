# Agent UX

MCP servers communicate with AI agents through three layers of text: server-level instructions, tool descriptions, and parameter descriptions. This server uses all three layers to shape how agents present Dynalist content and interact with users, producing a UX that feels native to the outliner even though the agent has no built-in knowledge of Dynalist.

## Content rendering

Dynalist content is a tree of nested bullet points. Left to their own defaults, agents tend to render tree data as flat lists, numbered items, or markdown headings. The MCP instructions define a specific rendering format that mirrors what users see in the Dynalist UI:

- **Indented bullets.** Content is rendered as `- ` prefixed lines with exactly 4 spaces per indentation level. Siblings share the same indent. This is enforced in the instructions with an explicit "IMPORTANT" callout because misaligned indentation was the single most common agent mistake during development.
- **Checked items.** Completed items render with strikethrough (`~~text~~`) to match Dynalist's visual treatment.
- **Mutation previews.** Before any write, the agent shows a diff-style preview in a fenced code block. Lines are prefixed with `+` (addition), `-` (deletion), or a space (context). The prefix occupies a fixed 2-character column that does not shift the tree indentation. Edits appear as a `-`/`+` pair. Context is limited to the parent and siblings, with `...` indicating omitted siblings.

These rendering rules apply uniformly: read results, summaries, and mutation confirmations all use the same format, so the user sees a consistent visual language throughout the conversation.

## Confirmation and verification

Every mutation tool's description begins with a shared `CONFIRM_GUIDANCE` constant: "Confirm intended changes with the user before calling this tool." This means the agent always presents a diff preview and waits for approval before executing a write. The instructions further require the agent to read back the affected area after a mutation and report any discrepancies. Together, these create a confirm-then-verify loop for all writes.

## Size management

Large documents can overwhelm an agent's context window or produce responses too long for the user to read. The server manages this at multiple levels:

- **Size warnings.** Read and search tools estimate token count from the serialized JSON output. If the result exceeds a configurable threshold, the tool returns a warning message instead of the content, along with tool-specific suggestions for narrowing the query (e.g., "Use max_depth to limit traversal depth", "Use a more specific query to reduce matches"). The agent can retry with `bypass_warning: true` to override, but the parameter description explicitly states: "ONLY set true AFTER receiving a size warning. Do NOT set true on first request." This two-step pattern prevents agents from preemptively bypassing the safety net.
- **Depth controls.** `read_document` has two independent size controls: `max_depth` (limits tree traversal depth, default 5) and `include_collapsed_children` (default false). The tool description explains that these are orthogonal and describes how hidden children are signaled differently (`depth_limited` vs `collapsed`) so the agent knows how to drill deeper when needed.
- **Configurable defaults.** Operators can set default values for `max_depth`, `include_collapsed_children`, `include_notes`, and `include_checked` in the config file, tuning the baseline payload size without requiring the agent to specify parameters on every call.
- **Sparse output.** Optional fields (notes, heading, color) are omitted from output when empty or at their default value, reducing JSON size for typical documents where most nodes have no heading or color label.

## Compositional patterns

The Dynalist API does not have an "ancestors" endpoint, and several common tasks require combining multiple tool calls. Rather than building monolithic tools, the instructions teach agents how to compose the existing tools:

- **Parent chain.** Use `search_in_document` with `parent_levels: "all"` to get the full ancestor chain for a node without a separate `read_document` call.
- **Sibling context.** Call `read_document` with the parent's `node_id` and `max_depth: 1`.
- **Expanding collapsed sections.** If a node has `collapsed: true` and `children_count > 0` but empty `children`, pass the node's `node_id` to `read_document` (the starting node always expands) or re-request with `include_collapsed_children: true`.
- **Drilling into depth-limited nodes.** If a node has `depth_limited: true`, call `read_document` with that node's `node_id` to zoom into the subtree.
- **File vs. node management.** The instructions distinguish file tree tools (`create_document`, `move_document`, etc.) from node tools (`insert_nodes`, `edit_nodes`, etc.) to prevent agents from confusing file IDs with node IDs.

## Version tracking workflow

The instructions establish a mandatory workflow: call `read_document` before any write to obtain the document version, pass it as `expected_version` to the write tool, and re-read if the tool returns a `version_warning`. This is reinforced at the parameter level: `expected_version` is described as "Document version from your most recent read_document. If stale, the tool aborts and requests a re-read." The version tracking is covered in depth in [concurrency.md](concurrency.md).

## Checkbox and checked state guidance

Dynalist's checkbox semantics are subtle: items can be checked with or without a visible checkbox, and checking a parent visually greys out descendants in the UI. The shared guidance constants (`CHECKED_GUIDANCE`, `SHOW_CHECKBOX_GUIDANCE`, `CHECKED_CHILDREN_GUIDANCE`) teach agents to:

- Only set `show_checkbox` when siblings use checkboxes or the user explicitly requests it.
- Not check children when checking a parent unless asked.
- Understand that `checked` works independently of `show_checkbox`.

## Partial insert recovery

Large tree inserts are batched by depth level. If a batch fails mid-way, some nodes exist but not all. The instructions explain that the error response includes `inserted_count`, `total_count`, and `first_node_id` so the agent can inspect the partial result and help the user recover rather than silently failing.

## Description architecture

The text that reaches agents is factored into three levels to avoid duplication and keep each piece of guidance where it belongs:

| Level | Location | Role | Example |
|---|---|---|---|
| MCP instructions | `index.ts` | Cross-tool workflow patterns, system concepts | "Read a document before writing to obtain the version." |
| Tool description | Each tool's `description` field | What the tool does and when to use it | "Edit one or more nodes in a document." |
| Parameter description | Zod `.describe()` strings | What a parameter means, valid values, edge cases | "ONLY set true AFTER receiving a size warning." |

Commonly repeated strings are factored into `descriptions.ts` as shared constants (`CONFIRM_GUIDANCE`, `BYPASS_WARNING_DESCRIPTION`, `EXPECTED_VERSION_DESCRIPTION`, etc.) so wording changes propagate to all tools at once. Inline value meanings (enum values, position options) are intentionally repeated at every usage site so agents do not need to cross-reference a central definition.
