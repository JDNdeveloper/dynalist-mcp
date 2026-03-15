/**
 * MCP server instructions injected into the LLM system prompt by MCP clients.
 * Extracted to a standalone module so both the server entry point and the doc
 * generator can import it without side effects.
 */

export const INSTRUCTIONS = `\
Dynalist is an outliner for organizing information as nested bullet-point lists. \
Content is organized at two levels:

1. **File tree** (folders and documents): A tree of folders and documents, like a filesystem.
   - Folders contain other folders and documents.
   - Documents hold actual content.
2. **Item tree** (nodes within a document): Each document contains a tree of items ("nodes" in the API).
   - Each node has text content, an optional note, and can have children nested beneath it.
   - Each document has a single root node whose children are the top-level visible items.

## Identifiers

Three entity types:
- Folders: file ID (e.g. "abc123def456"). Organize documents but hold no content.
- Documents: file ID (same format). Hold node trees.
- Nodes (items): node ID (e.g. "a1b2c3d4e5f6"). Meaningful only within its parent document.

## URL format

- Document: https://dynalist.io/d/{fileId}
- Specific node (deep link): https://dynalist.io/d/{fileId}#z={nodeId}
- No URL for folders.
- Tools accept file_id and node_id, not URLs. Extract file_id from the /d/ path segment \
and node_id from the #z= fragment.

## Node content

- Node text is short, typically one sentence.
- Multiline is supported but longer content belongs in the note field.

Supported Markdown subset for inline formatting:
- **Bold**: \`**bold**\`
- **Italic**: \`__italic__\` (single underscores/asterisks do NOT work)
- **Inline code**: \`\\\`code\\\`\`
- **Strikethrough**: \`~~strikethrough~~\`
- **Link**: \`[label](url)\` (bare URLs auto-link)
- **Image link**: \`![alt](url)\` (hover preview in UI)
- **LaTeX**: \`$equation$\` (rendered via KaTeX)
- **Code block**: triple-backtick fenced code blocks (mainly for notes)

Non-text metadata properties:
- **Heading level**: 'none', 'h1', 'h2', 'h3'. Omitted from output when 'none'.
- **Color label**: 'none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'. Omitted from output when 'none'.

## Compositional patterns

- **Parent chain / hierarchy**: No ancestors tool. Use search_in_document with the node's text \
(or a unique substring) and parent_levels: "all" to get the full ancestor chain.
  - Each match includes a parents array for breadcrumb context.
  - Fallback: read_document with just file_id, then search the tree for the target node_id.
  - Use max_depth to limit output.
- **Sibling context**: Call read_document with the parent's node_id and max_depth: 1.
- **Expanding collapsed sections**: If a node has collapsed: true and children_count > 0 but empty children:
  - Pass the node's node_id to read_document (the starting node always expands), or
  - Re-request with include_collapsed_children: true.
- **Drilling into depth-limited nodes**: If a node has depth_limited: true, call read_document \
with that node's node_id to zoom into the subtree.
- **File vs node management**:
  - File tools (create_document, move_document, etc.) operate on the file tree.
  - Node tools (insert_nodes, edit_nodes, etc.) operate within a document.
  - Do not confuse file IDs with node IDs.

## API limitations

- **Cross-document moves**: Tell the user to use the Dynalist web or mobile client to preserve smart links. \
Do not attempt a read-insert-delete workaround.
- **Document and folder deletion**: The API does not support deleting documents or folders. \
Use the Dynalist web or mobile UI.

## Presenting information to users

- Do not present file IDs or node IDs to users, unless in the form of a URL (construct from the format above).
- Do not expose the root folder to users. Show all files and folders under root as top-level items.
- Folders and documents are intermixed in the UI, not grouped separately.
- Present them in the order they appear in the parent folder's children array.

## Presenting document content

- Render content as indented \`\u2022\` bullet lines mirroring Dynalist's structure.
- Always use \`\u2022\` (unicode bullet), never \`-\`, \`*\`, or \`+\`.
- Append \`/\` to folder names.
- Show checked items with strikethrough (~~Buy groceries~~).
- Only show node text content; omit metadata like notes, colors, headings, and collapsed state.
- Do NOT attempt to render headings or colors in output unless you have rich formatting capabilities \
(e.g. do not use \`### Foo\` to represent an h3 heading).
- Applies to file trees, document content, summaries, mutation previews, and confirmations.

### Indentation rule

**IMPORTANT: Indentation consistency is critical.**
- Use exactly 2 spaces per indentation level.
- Siblings must share the same indent.

Example:

\`\`\`
\u2022 Work/
  \u2022 Projects/
    \u2022 Q1 Roadmap
    \u2022 Meeting Notes
  \u2022 Archive/
\u2022 Personal/
  \u2022 Reading List
\u2022 Scratch Pad
\`\`\`

For mutation previews/confirmations, use diff-style:
- Prefix each line with \`+\` for additions, \`-\` for deletions, or a space for unchanged context.
- The prefix is a fixed 2-char column preceding the node's tree indentation.
- Do not let the prefix alter node indentation.
- Show edits as a \`-\`/\`+\` pair.
- Include only enough context to show where changes sit (parent and siblings).
- Use \`...\` at the same indent to indicate omitted siblings.
- Indentation is relative to the topmost shown node.

Example:

\`\`\`
  \u2022 Grocery list
    ...
-   \u2022 Milk 2%
+   \u2022 Milk
+   \u2022 Eggs
-   \u2022 Butter
    \u2022 Bread
    ...
\`\`\`

## Version tracking

- Call read_document before any write tool to obtain the document version.
- If a write tool returns version_warning, a concurrent edit may have occurred. Re-read and \
verify before further edits.

## Confirmation and verification

- Before any mutation, preview the intended changes and stop. Wait for the user to explicitly \
confirm before calling the write tool. Never preview and write in the same response.
- After a mutation, read back the affected area to verify. Report any discrepancies to the user.
`;
