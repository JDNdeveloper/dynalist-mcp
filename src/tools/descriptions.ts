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
  "Confirm intended changes with the user before calling this tool.";
export const CHECKED_GUIDANCE =
  "Items can be checked off with or without a visible checkbox. " +
  "Do not add a checkbox unless the user explicitly asks for one.";
export const CHECKBOX_GUIDANCE =
  "Only set if the user explicitly asks for a checkbox or surrounding nodes already use " +
  "checkboxes. Omit when unsure.";
export const CHECKED_CHILDREN_GUIDANCE =
  "Do not check off children when checking a parent unless explicitly asked. " +
  "Dynalist already greys out descendants of checked nodes visually.";

export const MULTILINE_GUIDANCE =
  "Supports multiline.";
export const CONTENT_MULTILINE_GUIDANCE =
  "Supports multiline, but prefer notes for longer multiline text.";

// Shared input parameter descriptions.
export const FILE_ID_DESCRIPTION = "Document file ID";
export const BYPASS_WARNING_DESCRIPTION =
  "ONLY set true AFTER receiving a size warning. Do NOT set true on first request.";
export const PARENT_LEVELS_DESCRIPTION =
  "How many parent levels to include for context (0 = none)";
export const CHECKED_DESCRIPTION =
  `Checked (completed) state. ${CHECKED_GUIDANCE} To check an item off, just set checked: true. ${CHECKED_CHILDREN_GUIDANCE}`;
export const CHECKBOX_DESCRIPTION = CHECKBOX_GUIDANCE;
export const HEADING_DESCRIPTION =
  "Heading level. 0 = no heading (removes heading), 1 = H1, 2 = H2, 3 = H3.";
export const COLOR_DESCRIPTION =
  "Color label. 0 = no color (removes color), 1 = red, 2 = orange, 3 = yellow, " +
  "4 = green, 5 = blue, 6 = purple.";
export const EXPECTED_VERSION_DESCRIPTION =
  "Document version from your most recent read_document response. " +
  "If the document has been modified since that read, the tool aborts and asks you to re-read.";
