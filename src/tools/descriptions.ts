/**
 * Shared parameter descriptions for tool schemas. Descriptions that appear
 * in multiple tools live here so wording changes only need to happen once.
 */

// Shared input parameter descriptions.
export const FILE_ID_DESCRIPTION = "Document file ID";
export const BYPASS_WARNING_DESCRIPTION =
  "ONLY set true AFTER receiving a size warning. Do NOT set true on first request.";
export const PARENT_LEVELS_DESCRIPTION =
  "How many parent levels to include for context (0 = none)";
export const CHECKBOX_DESCRIPTION =
  "Only set this if surrounding nodes already use checkboxes. Omit when unsure.";
export const HEADING_DESCRIPTION =
  "Heading level. 0 = no heading (removes heading), 1 = H1, 2 = H2, 3 = H3.";
export const COLOR_DESCRIPTION =
  "Color label. 0 = no color (removes color), 1 = red, 2 = orange, 3 = yellow, " +
  "4 = green, 5 = blue, 6 = purple.";
