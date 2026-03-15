/**
 * Shared parameter descriptions and guidance for tool schemas. Descriptions
 * that appear in multiple tools live here so wording changes only need to
 * happen once.
 *
 * *_GUIDANCE constants hold the core policy wording. They are interpolated
 * into both per-parameter *_DESCRIPTION strings and the MCP system
 * instructions in index.ts.
 */

// Guidance strings (shared policy wording, reused across descriptions and MCP instructions).
export const CONFIRM_GUIDANCE =
  "ALWAYS preview intended changes and wait for explicit user confirmation before calling this tool. " +
  "NEVER call this tool in the same response as the preview.";
export const SHOW_CHECKBOX_GUIDANCE =
  "Controls whether a checkbox is rendered in the UI. Does not affect " +
  "checked state. Only set if siblings use checkboxes or the user asked.";
export const CHECKED_GUIDANCE =
  "Marks item as completed (greyed out). Works independently of " +
  "show_checkbox.";
export const CHECKED_CHILDREN_GUIDANCE =
  "Do not check children when checking a parent unless asked. " +
  "Dynalist greys out descendants visually.";

export const MULTILINE_GUIDANCE =
  "Supports multiline.";
export const CONTENT_MULTILINE_GUIDANCE =
  "Supports multiline, but prefer notes for longer multiline text.";

// Shared parameter descriptions. Used for fields that appear across multiple
// tools so that the same entity always has the same description.

// IDs.
export const FILE_ID_DESCRIPTION = "Document file ID";
export const FOLDER_ID_DESCRIPTION = "Folder file ID";
export const NODE_ID_DESCRIPTION = "Node ID";
export const PARENT_FOLDER_ID_DESCRIPTION = "Parent folder file ID";

// Common output fields.
export const DOCUMENT_TITLE_DESCRIPTION = "Document title";
export const FOLDER_TITLE_DESCRIPTION = "Folder title";
export const VERSION_DESCRIPTION =
  "Document version. Pass as expected_version to write tools.";
export const VERSION_WARNING_DESCRIPTION =
  "Warning if a concurrent edit was detected during the write.";
export const SIZE_WARNING_DESCRIPTION =
  "Size warning message when result exceeds token threshold";
export const MATCH_COUNT_DESCRIPTION = "Number of matches found";

// Common input fields.
export const EXPECTED_VERSION_DESCRIPTION =
  "Document version from your most recent read_document. " +
  "If stale, the tool aborts and requests a re-read.";
export const BYPASS_WARNING_DESCRIPTION =
  "ONLY set true AFTER receiving a size warning. Do NOT set true on first request.";
export const PARENT_LEVELS_DESCRIPTION =
  "Parent context depth: 'none' = no parents, 'immediate' = direct parent only, 'all' = full ancestor chain to root.";
export const FOLDER_INDEX_DESCRIPTION =
  "Position in folder. 0 = first, -1 = last (default).";

// Node metadata fields (input).
export const CHECKED_DESCRIPTION =
  `Checked (completed) state. ${CHECKED_GUIDANCE} ${CHECKED_CHILDREN_GUIDANCE}`;
export const CHECKED_DESCRIPTION_INBOX =
  `Checked (completed) state. ${CHECKED_GUIDANCE}`;
export const SHOW_CHECKBOX_DESCRIPTION = SHOW_CHECKBOX_GUIDANCE;
export const HEADING_DESCRIPTION =
  "Heading level. 'none' = no heading (removes heading), 'h1' = H1, 'h2' = H2, 'h3' = H3.";
export const COLOR_DESCRIPTION =
  "Color label. 'none' = no color (removes color), 'red', 'orange', 'yellow', " +
  "'green', 'blue', 'purple'.";
