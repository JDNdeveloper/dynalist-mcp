/**
 * String enum types and bidirectional translation maps for heading and color
 * values. The Dynalist API uses numbers internally; these maps translate
 * between the human-readable string enums exposed by MCP tools and the
 * numeric values sent to the API.
 */

export const HEADING_VALUES = ["none", "h1", "h2", "h3"] as const;
export type HeadingValue = (typeof HEADING_VALUES)[number];

export const HEADING_TO_NUMBER: Record<HeadingValue, number> = {
  none: 0, h1: 1, h2: 2, h3: 3,
};
export const NUMBER_TO_HEADING: Record<number, HeadingValue> = {
  0: "none", 1: "h1", 2: "h2", 3: "h3",
};

export const COLOR_VALUES = ["none", "red", "orange", "yellow", "green", "blue", "purple"] as const;
export type ColorValue = (typeof COLOR_VALUES)[number];

export const COLOR_TO_NUMBER: Record<ColorValue, number> = {
  none: 0, red: 1, orange: 2, yellow: 3, green: 4, blue: 5, purple: 6,
};
export const NUMBER_TO_COLOR: Record<number, ColorValue> = {
  0: "none", 1: "red", 2: "orange", 3: "yellow", 4: "green", 5: "blue", 6: "purple",
};
