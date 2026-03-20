# Agent UX

MCP servers communicate with AI agents through three layers of text: server-level instructions, tool descriptions, and parameter descriptions. This server uses all three layers to shape how agents present Dynalist content and interact with users, producing a UX that feels native to the outliner even though the agent has no built-in knowledge of Dynalist.

## Content rendering

Dynalist content is a tree of nested bullet points. Left to their own defaults, agents tend to render tree data as flat lists, numbered items, or markdown headings. The MCP instructions define a specific rendering format that mirrors what users see in the Dynalist UI:

- **Indented bullets.** Content is rendered as `• ` prefixed lines with exactly 2 spaces per indentation level. Siblings share the same indent. This is enforced in the instructions with an explicit "IMPORTANT" callout because misaligned indentation was the single most common agent mistake during development.
- **Checked items.** Completed items render with strikethrough (`~~text~~`) to match Dynalist's visual treatment.
- **Mutation previews.** Before any write, the agent shows a diff-style preview in a fenced code block. Lines are prefixed with `+` (addition), `-` (deletion), or a space (context). The prefix occupies a fixed 2-character column that does not shift the tree indentation. Edits appear as a `-`/`+` pair. Context is limited to the parent and siblings, with `...` indicating omitted siblings.

These rendering rules apply uniformly: read results, summaries, and mutation confirmations all use the same format, so the user sees a consistent visual language throughout the conversation.

### Bullet character choice

The instructions specify `•` (U+2022, unicode bullet) as the bullet character and explicitly forbid `-`, `*`, and `+`. This is a deliberate choice driven by weak-model compatibility testing with Haiku.

When the instructions used `-` (markdown dash) as the bullet character, Haiku consistently broke the specified formatting and fell back to its pre-trained markdown habits. The `-` character triggers strong associations with standard markdown list syntax, causing the model to ignore the custom indentation rules defined in the instructions. Typical failures included:

```
- Work/
    - Projects/
        - Q1 Roadmap
      - Meeting Notes
      - Design Docs
  - Archive/
      - 2024/
          - January
        - February
        - March
      - 2023/
          - December
        - November
```

Haiku would double-indent the first child of a parent (4 spaces instead of 2), while rendering subsequent siblings at the correct depth. This produced a jagged, inconsistent tree where every first child appeared one level too deep. The pattern was consistent and reproducible across runs.

Switching to `•` broke this pre-training association. Because `•` has no built-in connection to markdown list formatting, Haiku treated the rendering instructions as novel rules to follow rather than a cue to activate existing markdown behavior. The same content rendered correctly:

```
• Work/
  • Projects/
    • Q1 Roadmap
    • Meeting Notes
    • Design Docs
  • Archive/
    • 2024/
      • January
      • February
      • March
    • 2023/
      • December
      • November
```

The lesson generalizes: when instructing models to produce structured text output, avoid tokens that overlap with common markup syntax. Using a character outside the model's pre-trained formatting vocabulary gives the instructions authority over ingrained habits.

## Confirmation and verification

Every mutation tool shares a confirmation directive telling the agent to present a diff preview and wait for user approval before executing a write. The instructions further require the agent to read back the affected area after a mutation and report any discrepancies. Together, these create a confirm-then-verify loop for all writes.

## Size management

Large documents can overwhelm an agent's context window or produce responses too long for the user to read. The server manages this at multiple levels:

- **Size warnings.** Read and search tools estimate token count from the serialized output. If the result exceeds a configurable threshold, the tool returns a warning instead of the content, along with suggestions for narrowing the query. The agent can opt in to the full result on a subsequent call, but the parameter description prevents agents from preemptively bypassing the safety net.
- **Depth and visibility controls.** Document reads support limiting tree traversal depth and excluding collapsed children. These controls are orthogonal, and the tool descriptions explain how hidden children are signaled differently (depth-limited vs. collapsed) so the agent knows how to drill deeper when needed. The default depth is intentionally low (3) to keep initial reads token-efficient. Agents are expected to drill into depth-limited items as the primary exploration pattern, rather than requesting unlimited depth up front.
- **Configurable defaults.** Operators can tune default depth, note inclusion, and other payload-size knobs in the config file without requiring the agent to specify parameters on every call.
- **Sparse output.** Optional fields are omitted from output when at their default value, reducing payload size for typical documents. See the "Sparse output" section below for details.

## Sparse output

Tool responses omit properties at their default value to reduce token usage, unless the value provides helpful context. This reduces payload size without losing semantic content.

### Item metadata

- **`checked` and `show_checkbox`** use paired semantics: both present or both omitted. If either is true, both are included so agents see the full checkbox state. Omitted when both are `false`.
- **`collapsed`** is omitted when `false`.
- **`heading`** is omitted at its default value (`'none'`).
- **`color`** is omitted at its default value (`'none'`).
- **`note`** is omitted when empty.

### Document tree shapes (`read_document`)

`read_document` items include `child_count` and `children` based on two rules:

- `children` is included only when populated (not depth-limited, not collapsed, not fully filtered).
- `child_count` is included when children are present (inline or hidden), or when the item is collapsed. Collapsed items get `child_count` even when 0, so agents can tell whether a collapsed node has hidden children or genuinely has none. Items whose children are all filtered out (e.g. all checked with `include_checked: false`) appear as leaves with no `child_count`.

This produces three field combinations:

1. **No `child_count`, no `children`**: leaf item, or all children filtered out.
2. **`child_count` and `children`**: children are inline. `child_count` always matches `children` array length.
3. **`child_count`, no `children`**: children hidden by depth limit or collapsed state, or a collapsed leaf. `child_count` reflects the filtered count (how many children the agent would see if it expanded).

### File tree shapes (`list_documents`)

`list_documents` folders use a simpler scheme than document items. `child_count` is always present on folders (including empty folders with `child_count: 0`), because folders have no collapsed state or filtering that would make the count ambiguous.

- `children` is included only when non-empty and not depth-limited.

This produces three field combinations:

1. **`child_count: 0`, no `children`**: empty folder.
2. **`child_count` and `children`**: children are inline. `child_count` always matches `children` array length.
3. **`child_count`, no `children`**: children hidden by depth limit.

### Denormalized counts

Response arrays include a denormalized count field (e.g. `child_count` for `children`, `count` for `matches`) because LLMs cannot reliably count array elements. When both the count and the array are present, they always match.

### Write tool responses

Mutation success responses are minimal: `file_id`, a count of affected items (e.g. `edited_count`, `moved_count`, `deleted_count`), and an optional `sync_warning`. Input values like item IDs are not repeated in the response since the agent already knows them from its own request.

## Property ordering

Response objects place nested structures (`children`, `parents`) as the final property so that scalar metadata stays visually close to the item's primary content. This matters because agents consume serialized JSON, and property order determines what the agent "sees" near each item's identity.

When a recursive structure like `children` appears before metadata, deeply nested trees push metadata arbitrarily far from the item it describes:

```json
{
  "item_id": "abc",
  "content": "Project plan",
  "child_count": 1,
  "children": [
    {
      "item_id": "def",
      "content": "Phase 1",
      "child_count": 1,
      "children": [
        {
          "item_id": "ghi",
          "content": "Research"
        }
      ],
      "note": "Due next Friday",
      "color": "red"
    }
  ],
  "note": "Q2 initiative",
  "heading": "h1"
}
```

The root item's `note` and `heading` are 17 lines away from its `content`. An agent scanning the JSON may not associate them. With metadata before the nested structure:

```json
{
  "item_id": "abc",
  "content": "Project plan",
  "note": "Q2 initiative",
  "heading": "h1",
  "child_count": 1,
  "children": [
    {
      "item_id": "def",
      "content": "Phase 1",
      "note": "Due next Friday",
      "color": "red",
      "child_count": 1,
      "children": [
        {
          "item_id": "ghi",
          "content": "Research"
        }
      ]
    }
  ]
}
```

Every item's metadata is immediately adjacent to its content, regardless of tree depth. This applies to all recursive output schemas (`outputNodeSchema`, `fileTreeFolderSchema`) and flat schemas with nested arrays (`searchMatchSchema`, `changeMatchSchema`). Input schemas follow the same convention so agents see a consistent shape when constructing requests.

## Compositional patterns

The Dynalist API does not have an "ancestors" endpoint, and several common tasks require combining multiple tool calls. Rather than building monolithic tools, the instructions teach agents how to compose the existing primitives:

- **Parent chain.** Search within a document with full parent levels to get the ancestor chain without a separate read call.
- **Sibling context.** Read a document starting from the parent item with depth 1.
- **Expanding collapsed sections.** Read starting from the collapsed item (the starting item always expands), or re-request with collapsed children included.
- **Drilling into depth-limited items.** Read starting from the depth-limited item to zoom into the subtree.
- **File vs. item management.** The instructions distinguish file-tree tools from item-tree tools to prevent agents from confusing file IDs with item IDs.

## Sync token workflow

The instructions establish a mandatory workflow: read a document before any write to obtain the sync token, pass it to the write tool, and re-read if the tool returns a sync warning. This is reinforced at the parameter level, where the sync token field description tells the agent to re-read on staleness. The sync token design is covered in depth in [concurrency.md](concurrency.md).

### Why opaque tokens

Early versions exposed the numeric document version directly. Claude Opus 4.6 exploited this after a write: it called `insert_items`, incremented the version by 1, received a sync warning saying the version had actually advanced by 2 (the insert made two API calls under the hood), then used that leaked version number directly in the next mutation without re-reading the document. The arithmetic happened to be correct, but the behavior is unsafe because it bypasses the re-read that the version guard is designed to enforce. By hashing the version into a short opaque hex token, agents cannot predict the next value and are forced to re-read.

## Checkbox and checked state guidance

Dynalist's checkbox semantics are subtle: items can be checked with or without a visible checkbox, and checking a parent visually greys out descendants in the UI. Shared guidance constants teach agents to:

- Only add a visible checkbox when siblings use checkboxes or the user explicitly requests it.
- Not check children when checking a parent unless asked.
- Understand that checked state works independently of checkbox visibility.

## Partial write recovery

Any mutation that requires multiple API calls (multi-level inserts, large batched edits/deletes, child promotion) can partially succeed. If a later API call fails after earlier ones succeeded, the tool returns a `PartialWrite` error with a message telling the agent to re-read the document and verify the result. The error carries the `file_id` so the agent knows which document to re-read.

## Description architecture

The text that reaches agents is factored into three levels to avoid duplication and keep each piece of guidance where it belongs:

| Level | Location | Role | Example |
|---|---|---|---|
| MCP instructions | `instructions.ts` | Cross-tool workflow patterns, system concepts | "Read a document before writing to obtain the version." |
| Tool description | Each tool's `description` field | What the tool does and when to use it | "Edit one or more items in a document." |
| Parameter description | Zod `.describe()` strings | What a parameter means, valid values, edge cases | "Only set true after receiving a size warning." |

Commonly repeated strings are factored into `descriptions.ts` as shared constants so wording changes propagate to all tools at once. Inline value meanings (enum values, position options) are intentionally repeated at every usage site so agents do not need to cross-reference a central definition.
