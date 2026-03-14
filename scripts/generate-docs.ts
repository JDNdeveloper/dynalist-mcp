/**
 * Generate docs/tools.md, docs/configuration.md, and docs/api-coverage.md
 * from source schemas. Run with: bun scripts/generate-docs.ts
 */

import type { ZodTypeAny } from "zod";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Zod internal type helpers ──────────────────────────────────────

/**
 * Minimal type for Zod's internal `_def` property. Zod does not export
 * this shape, so we declare just enough to introspect schemas without
 * resorting to `any`.
 */
interface ZodInternalDef {
  typeName?: string;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  defaultValue?: () => unknown;
  value?: unknown;
  values?: string[];
  type?: ZodTypeAny;
  valueType?: ZodTypeAny;
  options?: ZodTypeAny[];
  getter?: () => ZodTypeAny;
  shape?: () => Record<string, ZodTypeAny>;
}

/** Access Zod's internal `_def` in a type-safe way. */
function zodDef(schema: ZodTypeAny): ZodInternalDef {
  return (schema as unknown as { _def: ZodInternalDef })._def;
}

// ─── Zod introspection ──────────────────────────────────────────────

interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  default_: string | undefined;
  description: string;
  children?: FieldInfo[];
}

/**
 * Unwrap optional/default/nullable wrappers, collecting metadata along the way.
 */
function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean; default_: string | undefined; nullable: boolean } {
  let optional = false;
  let default_: string | undefined;
  let nullable = false;
  let current = schema;

  // Peel layers iteratively.
  let changed = true;
  while (changed) {
    changed = false;
    const def = zodDef(current);

    if (def?.typeName === "ZodOptional") {
      optional = true;
      current = def.innerType;
      changed = true;
    } else if (def?.typeName === "ZodDefault") {
      optional = true;
      const val = def.defaultValue();
      default_ = JSON.stringify(val);
      current = def.innerType;
      changed = true;
    } else if (def?.typeName === "ZodNullable") {
      nullable = true;
      current = def.innerType;
      changed = true;
    } else if (def?.typeName === "ZodEffects") {
      // .refine() / .transform() wrappers. Peel through to the inner schema.
      current = def.schema;
      changed = true;
    }
  }

  return { inner: current, optional, default_, nullable };
}

/**
 * Search all layers of a Zod schema chain for a .describe() string.
 * Descriptions can live on any wrapper (ZodOptional, ZodDefault, ZodEffects, etc.).
 */
function findDescription(schema: ZodTypeAny): string {
  let current: ZodTypeAny | null = schema;
  while (current) {
    if (current.description) return current.description;
    const def = zodDef(current);
    if (!def) break;
    // Try innerType (ZodOptional, ZodDefault, ZodNullable) then schema (ZodEffects).
    current = def.innerType ?? def.schema ?? null;
  }
  return "";
}

/**
 * Get a human-readable type string from a Zod schema.
 */
function zodTypeString(schema: ZodTypeAny, depth: number = 0): string {
  const { inner, nullable } = unwrap(schema);
  const def = zodDef(inner);
  const typeName: string = def?.typeName ?? "unknown";

  let result: string;

  switch (typeName) {
    case "ZodString":
      result = "string";
      break;
    case "ZodNumber":
      result = "number";
      break;
    case "ZodBoolean":
      result = "boolean";
      break;
    case "ZodLiteral":
      result = JSON.stringify(def.value);
      break;
    case "ZodEnum":
      result = (def.values as string[]).map(v => `\`"${v}"\``).join(", ");
      break;
    case "ZodArray": {
      const elemType = zodTypeString(def.type, depth + 1);
      result = `${elemType}[]`;
      break;
    }
    case "ZodObject":
      result = "object";
      break;
    case "ZodRecord":
      result = `Record<string, ${zodTypeString(def.valueType, depth + 1)}>`;
      break;
    case "ZodUnion": {
      const options = (def.options as ZodTypeAny[]).map(o => zodTypeString(o, depth + 1));
      result = options.join(" \\| ");
      break;
    }
    case "ZodLazy":
      // Recursive schema. Resolve once to get the type name.
      if (depth < 2) {
        result = zodTypeString(def.getter(), depth + 1);
      } else {
        result = "object (recursive)";
      }
      break;
    default:
      throw new Error(`Unknown Zod type '${typeName}'. Add a case to zodTypeString().`);
  }

  if (nullable) result += " \\| null";
  return result;
}

/**
 * Extract fields from a Zod object schema (the Record<string, ZodType> format
 * used by MCP's inputSchema/outputSchema).
 */
function extractFields(schemaMap: Record<string, ZodTypeAny>): FieldInfo[] {
  return Object.entries(schemaMap).map(([name, schema]) => {
    const { inner, optional, default_ } = unwrap(schema);
    const description = findDescription(schema);

    const field: FieldInfo = {
      name: `\`${name}\``,
      type: zodTypeString(schema),
      required: !optional,
      default_,
      description,
    };

    // Extract nested object fields for array-of-objects or inline objects.
    const innerDef = zodDef(inner);
    if (innerDef?.typeName === "ZodArray") {
      const elemSchema = innerDef.type;
      const elemUnwrapped = unwrap(elemSchema);
      const elemDef = zodDef(elemUnwrapped.inner);
      if (elemDef?.typeName === "ZodObject") {
        field.children = extractObjectFields(elemUnwrapped.inner);
      } else if (elemDef?.typeName === "ZodLazy") {
        // Recursive schema (e.g. outputNodeSchema, jsonInputNodeSchema).
        const resolved = elemDef.getter();
        const resolvedDef = zodDef(resolved);
        if (resolvedDef?.typeName === "ZodObject") {
          field.children = extractObjectFields(resolved);
        }
      }
    }

    return field;
  });
}

/**
 * Extract fields from a ZodObject (not the MCP Record format).
 */
function extractObjectFields(schema: ZodTypeAny): FieldInfo[] {
  const def = zodDef(schema);
  if (def?.typeName !== "ZodObject") return [];
  const shape = def.shape();
  return Object.entries(shape).map(([name, fieldSchema]) => {
    const s = fieldSchema as ZodTypeAny;
    const { optional, default_ } = unwrap(s);
    return {
      name: `\`${name}\``,
      type: zodTypeString(s),
      required: !optional,
      default_,
      description: findDescription(s),
    };
  });
}

// ─── Example generation ─────────────────────────────────────────────

/**
 * Generate a plausible example value for a Zod schema.
 */
function generateExample(name: string, schema: ZodTypeAny, depth: number = 0): unknown {
  const { inner, default_ } = unwrap(schema);
  const def = zodDef(inner);
  const typeName: string = def?.typeName ?? "unknown";

  // Use default if available.
  if (default_ !== undefined) {
    try { return JSON.parse(default_); } catch { /* fall through */ }
  }

  switch (typeName) {
    case "ZodString":
      return exampleString(name);
    case "ZodNumber":
      return exampleNumber(name);
    case "ZodBoolean":
      return exampleBoolean(name);
    case "ZodLiteral":
      return def.value;
    case "ZodEnum": {
      const vals = def.values as string[];
      // Pick a non-"none" value if possible.
      return vals.find(v => v !== "none" && v !== "all") ?? vals[0];
    }
    case "ZodArray": {
      if (depth > 1) return [];
      const elem = generateExample(name, def.type, depth + 1);
      return [elem];
    }
    case "ZodObject": {
      const shape = def.shape();
      const obj: Record<string, unknown> = {};
      for (const [key, fieldSchema] of Object.entries(shape)) {
        const { optional } = unwrap(fieldSchema as ZodTypeAny);
        // Skip some optional fields in examples for brevity.
        if (optional && depth > 0 && !["content", "node_id", "position", "reference_node_id"].includes(key)) continue;
        obj[key] = generateExample(key, fieldSchema as ZodTypeAny, depth + 1);
      }
      return obj;
    }
    case "ZodRecord": {
      return { "f_abc123": generateExample("value", def.valueType, depth + 1) };
    }
    case "ZodUnion": {
      // Pick the first option.
      const options = def.options as ZodTypeAny[];
      return generateExample(name, options[0], depth + 1);
    }
    case "ZodLazy": {
      if (depth < 2) {
        return generateExample(name, def.getter(), depth + 1);
      }
      return {};
    }
    default:
      throw new Error(`No example generator for Zod type '${typeName}' (field '${name}'). Add a case to generateExample().`);
  }
}

function exampleString(name: string): string {
  // IDs.
  if (name === "file_id" || name === "file_ids") return "f_abc123";
  if (name === "folder_id") return "f_folder456";
  if (name === "parent_folder_id") return "f_folder456";
  if (name === "node_id" || name === "node_ids") return "n_item789";
  if (name === "reference_node_id") return "n_sibling012";
  if (name === "root_file_id") return "f_root000";
  if (name === "deleted_ids") return "n_item789";
  if (name === "root_node_ids") return "n_new001";
  // Content fields.
  if (name === "url") return "https://dynalist.io/d/f_abc123#z=n_item789";
  if (name === "title") return "Project Notes";
  if (name === "content") return "Buy groceries";
  if (name === "note") return "Milk, eggs, bread";
  if (name === "query") return "groceries";
  if (name === "since") return "2025-03-01";
  if (name === "until") return "2025-03-14";
  // Metadata strings.
  if (name === "version_warning") return "Document was modified by another client during write.";
  if (name === "warning") return "Response exceeds size threshold. Retry with bypass_warning: true.";
  if (name === "created") return "2025-03-11T12:00:00.000Z";
  if (name === "modified") return "2025-03-11T14:30:00.000Z";
  if (name === "change_type") return "modified";
  if (name === "type") return "document";
  if (name === "permission") return "owner";
  if (name === "access_policy") return "read";
  throw new Error(`No example string for field '${name}'. Add it to exampleString() in generate-docs.ts.`);
}

function exampleNumber(name: string): number {
  if (name === "version" || name === "expected_version" || name === "value") return 42;
  // Counts match auto-generated array lengths (1 element each).
  if (name === "count" || name === "edited_count" || name === "moved_count" || name === "deleted_count" || name === "total_created") return 1;
  if (name === "promoted_children") return 1;
  if (name === "children_count") return 3;
  if (name === "max_depth") return 3;
  if (name === "index") return 0;
  throw new Error(`No example number for field '${name}'. Add it to exampleNumber() in generate-docs.ts.`);
}

function exampleBoolean(name: string): boolean {
  if (name === "checked" || name === "bypass_warning" || name === "depth_limited") return true;
  if (name === "collapsed") return false;
  if (name === "show_checkbox" || name === "search_notes") return true;
  if (name === "include_collapsed_children") return false;
  if (name === "include_notes" || name === "include_checked") return true;
  throw new Error(`No example boolean for field '${name}'. Add it to exampleBoolean() in generate-docs.ts.`);
}

// No tool-specific overrides. All examples are auto-generated from schemas.
// The example value maps (exampleString, exampleNumber, exampleBoolean) throw
// on unknown field names, so any new schema field forces an explicit update.

// ─── Mock MCP server ────────────────────────────────────────────────

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  outputSchema: Record<string, ZodTypeAny>;
}

const capturedTools: CapturedTool[] = [];

const mockServer = {
  registerTool(name: string, options: { description?: string; inputSchema?: Record<string, ZodTypeAny>; outputSchema?: Record<string, ZodTypeAny> }) {
    capturedTools.push({
      name,
      description: options.description ?? "",
      inputSchema: options.inputSchema ?? {},
      outputSchema: options.outputSchema ?? {},
    });
  },
  setRequestHandler() {},
  registerResource() {},
  registerPrompt() {},
};

// ─── Import and capture tool registrations ──────────────────────────

// The register functions only use server.registerTool in the registration
// phase. The client/ac/store are only needed inside handlers (never called).
const { registerReadTools } = await import("../src/tools/read");
const { registerWriteTools } = await import("../src/tools/write");
const { registerStructureTools } = await import("../src/tools/structure");
const { registerFileTools } = await import("../src/tools/files");

import type { DynalistClient } from "../src/dynalist-client";
import type { AccessController } from "../src/access-control";
import type { DocumentStore } from "../src/document-store";

const dummyClient = {} as unknown as DynalistClient;
const dummyAc = {} as unknown as AccessController;
const dummyStore = {} as unknown as DocumentStore;

// Categories are derived automatically by tracking which tools each register
// function adds. Adding/removing/renaming tools in the source requires zero
// changes here.
function captureGroup(title: string, registerFn: (...args: never[]) => void, ...args: unknown[]): { title: string; tools: string[] } {
  const before = capturedTools.length;
  registerFn(mockServer, ...args);
  return { title, tools: capturedTools.slice(before).map(t => t.name) };
}

const CATEGORIES = [
  captureGroup("Read tools", registerReadTools, dummyClient, dummyAc, dummyStore),
  captureGroup("Write tools", registerWriteTools, dummyClient, dummyAc, dummyStore),
  captureGroup("Structure tools", registerStructureTools, dummyClient, dummyAc, dummyStore),
  captureGroup("File management tools", registerFileTools, dummyClient, dummyAc),
];

// ─── Markdown generation: tools.md ──────────────────────────────────

function renderFieldTable(fields: FieldInfo[], includeDefault: boolean): string {
  const hasDefault = includeDefault && fields.some(f => f.default_ !== undefined);

  const headers = ["Parameter", "Type", "Required"];
  if (hasDefault) headers.push("Default");
  headers.push("Description");

  const dividers = headers.map(() => "---");
  const rows = [
    `| ${headers.join(" | ")} |`,
    `| ${dividers.join(" | ")} |`,
  ];

  for (const f of fields) {
    const cols = [f.name, f.type, f.required ? "yes" : "no"];
    if (hasDefault) cols.push(f.default_ ?? "");
    cols.push(f.description);
    rows.push(`| ${cols.join(" | ")} |`);
  }

  return rows.join("\n");
}

function renderOutputTable(fields: FieldInfo[]): string {
  const headers = ["Field", "Type", "Always present", "Description"];
  const dividers = headers.map(() => "---");
  const rows = [
    `| ${headers.join(" | ")} |`,
    `| ${dividers.join(" | ")} |`,
  ];

  for (const f of fields) {
    const cols = [f.name, f.type, f.required ? "yes" : "no", f.description];
    rows.push(`| ${cols.join(" | ")} |`);
  }

  return rows.join("\n");
}

function generateToolsMarkdown(): string {
  const toolMap = new Map(capturedTools.map(t => [t.name, t]));
  const lines: string[] = [];

  lines.push("<!-- Generated by scripts/generate-docs.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push("# Tools Reference");

  for (const category of CATEGORIES) {
    lines.push("");
    lines.push(`## ${category.title}`);

    for (const toolName of category.tools) {
      const tool = toolMap.get(toolName)!;

      lines.push("");
      lines.push(`### \`${toolName}\``);
      lines.push("");

      // Tool description as intro text.
      // Strip the confirmation guidance prefix since it's an agent instruction, not doc content.
      const desc = tool.description.replace(/^Confirm intended changes with the user before calling this tool\.\s*/, "");
      lines.push(desc);

      // Input parameters.
      const inputFields = extractFields(tool.inputSchema);
      lines.push("");
      if (inputFields.length === 0) {
        lines.push("**Parameters**: none.");
      } else {
        lines.push("**Parameters:**");
        lines.push("");
        lines.push(renderFieldTable(inputFields, true));

        // Render sub-object tables.
        for (const f of inputFields) {
          if (f.children && f.children.length > 0) {
            lines.push("");
            const label = f.name.replace(/`/g, "");
            lines.push(`**\`${label}\` element fields:**`);
            lines.push("");
            lines.push(renderFieldTable(f.children, false));
          }
        }
      }

      // Example input.
      if (inputFields.length > 0) {
        const exampleInput: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(tool.inputSchema)) {
          const { optional, default_ } = unwrap(schema);
          // Skip optional params with defaults to keep examples minimal.
          if (optional && default_ !== undefined) continue;
          exampleInput[key] = generateExample(key, schema);
        }
        lines.push("");
        lines.push("**Example input:**");
        lines.push("```json");
        lines.push(JSON.stringify(exampleInput, null, 2));
        lines.push("```");
      }

      // Output schema table.
      const outputFields = extractFields(tool.outputSchema);
      lines.push("");
      lines.push("**Response:**");
      lines.push("");
      lines.push(renderOutputTable(outputFields));

      // Render nested output sub-tables.
      for (const f of outputFields) {
        if (f.children && f.children.length > 0) {
          const label = f.name.replace(/`/g, "");
          lines.push("");
          lines.push(`**\`${label}\` element fields:**`);
          lines.push("");
          lines.push(renderOutputTable(f.children));
        }
      }

      // Example output. Skip warning/version_warning since they represent
      // error-path responses, not the normal success shape.
      const exampleOutput: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(tool.outputSchema)) {
        if (key === "warning" || key === "version_warning") continue;
        exampleOutput[key] = generateExample(key, schema);
      }
      lines.push("");
      lines.push("**Example response:**");
      lines.push("```json");
      lines.push(JSON.stringify(exampleOutput, null, 2));
      lines.push("```");
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ─── Markdown generation: configuration.md ──────────────────────────

import {
  ConfigSchema,
  ENV_VARS,
  LOG_LEVEL_DESCRIPTIONS,
  CONFIG_FILE_DESCRIPTION,
  LOGGING_DESCRIPTION,
  LOG_FILE_HINT,
} from "../src/config";

interface ConfigFieldRow {
  path: string;
  type: string;
  default_: string;
  description: string;
}

/**
 * Recursively walk a Zod object schema and flatten to dot-notation field rows.
 * Nested ZodObject fields are recursed into; all other types are leaf rows.
 */
function walkConfigSchema(schema: ZodTypeAny, prefix: string = ""): ConfigFieldRow[] {
  const { inner } = unwrap(schema);
  const innerDef = zodDef(inner);
  if (innerDef?.typeName !== "ZodObject") return [];

  const shape = innerDef.shape();
  const rows: ConfigFieldRow[] = [];

  for (const [name, fieldSchema] of Object.entries(shape)) {
    const s = fieldSchema as ZodTypeAny;
    const unwrapped = unwrap(s);
    const leafDef = zodDef(unwrapped.inner);
    const path = prefix ? `${prefix}.${name}` : name;

    if (leafDef?.typeName === "ZodObject") {
      // Recurse into nested objects.
      rows.push(...walkConfigSchema(unwrapped.inner, path));
    } else {
      // Leaf field.
      const description = findDescription(s);
      let default_ = unwrapped.default_ ?? (unwrapped.optional ? "none" : "");

      // Format default values for display.
      if (default_ !== "" && default_ !== "none") {
        default_ = `\`${default_}\``;
      }

      rows.push({
        path: `\`${path}\``,
        type: zodTypeString(s),
        default_,
        description,
      });
    }
  }

  return rows;
}

/**
 * Generate a full example config JSON from schema defaults, with sample
 * access rules overlaid to show a populated example.
 */
function generateExampleConfig(): Record<string, unknown> {
  // Start from schema defaults.
  const defaults = ConfigSchema.parse({});

  // Overlay illustrative access rules (the only section that defaults to
  // absent and needs sample data to be useful as an example).
  return {
    access: {
      default: "allow",
      rules: [
        { path: "/Private/**", policy: "deny" },
        { path: "/Private/Shopping List", policy: "allow" },
        { path: "/Archive/**", policy: "read" },
      ],
    },
    readDefaults: defaults.readDefaults,
    sizeWarning: defaults.sizeWarning,
    readOnly: defaults.readOnly,
    cache: defaults.cache,
    logLevel: defaults.logLevel,
    logFile: "/tmp/dynalist-mcp.log",
  };
}

function generateConfigurationMarkdown(): string {
  const lines: string[] = [];

  lines.push("<!-- Generated by scripts/generate-docs.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push("# Configuration");
  lines.push("");
  lines.push("## Environment variables");
  lines.push("");
  lines.push("| Variable | Required | Description |");
  lines.push("| --- | --- | --- |");
  for (const env of ENV_VARS) {
    lines.push(`| \`${env.name}\` | ${env.required ? "Yes" : "No"} | ${env.description} |`);
  }
  lines.push("");
  lines.push("## Config file");
  lines.push("");
  lines.push(CONFIG_FILE_DESCRIPTION);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(generateExampleConfig(), null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Field reference");
  lines.push("");
  lines.push("| Field | Type | Default | Description |");
  lines.push("| --- | --- | --- | --- |");

  const configFields = walkConfigSchema(ConfigSchema);
  for (const f of configFields) {
    lines.push(`| ${f.path} | ${f.type} | ${f.default_} | ${f.description} |`);
  }

  lines.push("");
  lines.push("## Logging");
  lines.push("");
  lines.push(`${LOGGING_DESCRIPTION} The \`logLevel\` setting controls verbosity:`);
  lines.push("");

  // Find the default log level from the schema.
  const logLevelDefault = unwrap(
    zodDef(ConfigSchema).shape!().logLevel
  ).default_;
  const defaultLevel = logLevelDefault ? JSON.parse(logLevelDefault) : "warn";

  for (const [level, desc] of Object.entries(LOG_LEVEL_DESCRIPTIONS)) {
    const suffix = level === defaultLevel ? " (default)" : "";
    lines.push(`- **${level}**${suffix}: ${desc}.`);
  }
  lines.push("");
  lines.push(LOG_FILE_HINT);
  lines.push("");

  return lines.join("\n");
}

// ─── Markdown generation: api-coverage.md ───────────────────────────

import { API_ENDPOINTS, UNSUPPORTED_ENDPOINTS } from "../src/dynalist-client";

// Patterns that map source code identifiers to DynalistClient method names.
// Used to determine which API endpoint each tool calls.
const CLIENT_CALL_PATTERNS: Record<string, string> = {
  "client.listFiles": "listFiles",
  "client.editFiles": "editFiles",
  "client.editDocument": "editDocument",
  "client.sendToInbox": "sendToInbox",
  "client.checkForUpdates": "checkForUpdates",
  // store.read() wraps client.readDocument().
  "store.read": "readDocument",
  // insertTreeUnderParent() wraps client.editDocument().
  "insertTreeUnderParent": "editDocument",
};

/**
 * Parse tool source files to determine which API endpoint each tool primarily
 * uses. Splits files by the `// TOOL: <name>` comment markers and greps each
 * section for client method call patterns.
 */
function parseToolEndpoints(): Map<string, string> {
  // Validate that all CLIENT_CALL_PATTERNS method names exist in API_ENDPOINTS.
  const knownMethods = new Set(Object.keys(API_ENDPOINTS));
  for (const [pattern, method] of Object.entries(CLIENT_CALL_PATTERNS)) {
    if (!knownMethods.has(method)) {
      throw new Error(`CLIENT_CALL_PATTERNS maps '${pattern}' to '${method}' which is not in API_ENDPOINTS.`);
    }
  }

  const srcDir = join(import.meta.dir, "..", "src");
  const toolDir = join(srcDir, "tools");
  const toolFiles = readdirSync(toolDir)
    .filter(f => f.endsWith(".ts") && !f.startsWith("index") && !f.includes(".test."))
    .map(f => `tools/${f}`);
  const toolEndpoints = new Map<string, string>();

  for (const relPath of toolFiles) {
    const source = readFileSync(join(srcDir, relPath), "utf-8");
    // Split on TOOL marker comments.
    const sections = source.split(/\/\/\s*TOOL:\s*/);

    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const toolName = section.match(/^(\w+)/)?.[1];
      if (!toolName) continue;

      // Find the primary client method called in this section.
      for (const [pattern, method] of Object.entries(CLIENT_CALL_PATTERNS)) {
        if (section.includes(pattern)) {
          // Use the first match as the primary endpoint. Write/mutate methods
          // take priority over read methods (e.g. move_document calls both
          // listFiles for validation and editFiles for the actual move).
          const existing = toolEndpoints.get(toolName);
          if (!existing || isWriteMethod(method)) {
            toolEndpoints.set(toolName, method);
          }
        }
      }
    }
  }

  return toolEndpoints;
}

function isWriteMethod(method: string): boolean {
  return method === "editDocument" || method === "editFiles" || method === "sendToInbox";
}

function generateApiCoverageMarkdown(): string {
  const toolEndpoints = parseToolEndpoints();

  // Validate every registered tool has a detected endpoint.
  for (const tool of capturedTools) {
    if (!toolEndpoints.has(tool.name)) {
      throw new Error(
        `Tool '${tool.name}' has no detected API endpoint. ` +
        `Update CLIENT_CALL_PATTERNS in generate-docs.ts or add a TOOL marker comment.`
      );
    }
  }

  // Group tools by endpoint method name.
  const endpointToTools = new Map<string, string[]>();
  for (const [toolName, method] of toolEndpoints) {
    if (!endpointToTools.has(method)) endpointToTools.set(method, []);
    endpointToTools.get(method)!.push(toolName);
  }

  const lines: string[] = [];
  lines.push("<!-- Generated by scripts/generate-docs.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push("# Dynalist API Coverage");
  lines.push("");
  lines.push("| API Endpoint | MCP Tool(s) | Docs |");
  lines.push("| --- | --- | --- |");

  for (const [method, endpoint] of Object.entries(API_ENDPOINTS)) {
    const tools = endpointToTools.get(method) ?? [];
    const toolList = tools.length > 0
      ? tools.map(t => `\`${t}\``).join(", ")
      : "Not used";
    const docsLink = `[${endpoint.path}](${endpoint.docs})`;
    lines.push(`| \`POST ${endpoint.path}\` | ${toolList} | ${docsLink} |`);
  }

  for (const ep of UNSUPPORTED_ENDPOINTS) {
    lines.push(`| \`POST ${ep.path}\` | Not supported | ${ep.reason} |`);
  }

  lines.push("");
  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────

const docsDir = join(import.meta.dir, "..", "docs");

const toolsMd = generateToolsMarkdown();
const configMd = generateConfigurationMarkdown();
const apiCoverageMd = generateApiCoverageMarkdown();

writeFileSync(join(docsDir, "tools.md"), toolsMd);
writeFileSync(join(docsDir, "configuration.md"), configMd);
writeFileSync(join(docsDir, "api-coverage.md"), apiCoverageMd);

console.log(`Generated:`);
console.log(`  docs/tools.md (${toolsMd.length} bytes, ${capturedTools.length} tools)`);
console.log(`  docs/configuration.md (${configMd.length} bytes)`);
console.log(`  docs/api-coverage.md (${apiCoverageMd.length} bytes)`);
