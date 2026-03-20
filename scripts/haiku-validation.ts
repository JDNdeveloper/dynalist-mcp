/**
 * Weak-model instruction validation harness.
 *
 * Tests whether Claude Haiku can correctly follow MCP instructions and tool
 * descriptions for string enums, positioning, nested inserts, deletes, moves,
 * search, and file management.
 *
 * Architecture:
 *   1. A Sonnet coordinator creates one global root folder in Dynalist,
 *      then N sub-folders and documents inside it. File IDs are passed
 *      directly to pipeline tasks to avoid rate-limited list_documents calls.
 *   2. Haiku pipelines run in parallel, each working exclusively within
 *      its own sub-folder. Each pipeline is internally sequential.
 *   3. Sonnet reviews each pipeline's results against live Dynalist state,
 *      rating each task pass/fail and 1-5 stars.
 *   4. A Sonnet aggregator produces a final human-readable summary.
 *   5. The user manually deletes the global root folder (API limitation).
 *
 * Usage:
 *   bun scripts/haiku-validation.ts
 *
 * Prerequisites:
 *   - Claude CLI (`claude`) installed and authenticated.
 *   - Dynalist MCP server configured in the project's .mcp.json.
 *   - DYNALIST_API_TOKEN pointing to a **test account**.
 *
 * Configuration:
 *   Override defaults with environment variables:
 *     COORDINATOR_MODEL  Model for setup/cleanup (default: sonnet)
 *     VALIDATION_MODEL   Model under test (default: haiku)
 *     OUTPUT_DIR          Output directory (default: /tmp/haiku-validation)
 *     MAX_TURNS           Max agent turns per task (default: 25)
 *     TASK_TIMEOUT_MS     Per-task timeout in ms (default: 180000)
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const COORDINATOR_MODEL = process.env.COORDINATOR_MODEL ?? "sonnet";
const VALIDATION_MODEL = process.env.VALIDATION_MODEL ?? "haiku";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/tmp/haiku-validation";
const WORK_DIR = "/tmp/haiku-validation-work";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 25);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 180_000);

// Short random suffix so repeated runs do not collide on folder names.
const RUN_ID = Math.random().toString(36).slice(2, 6);

// System prompt override that prevents the model from following the MCP
// instruction to preview changes and wait for user confirmation. Without this,
// headless sessions output a preview and never proceed with the mutation.
const HEADLESS_SYSTEM_PROMPT =
  "**IMPORTANT**: This is an automated test sequence running in a headless " +
  "session against a test Dynalist account. There is no human to confirm or " +
  "approve changes. OVERRIDE: The Dynalist MCP instruction to 'preview " +
  "changes and stop' and 'wait for the user to explicitly confirm' does NOT " +
  "apply here. That rule is suspended for this session. You MUST call " +
  "mutating Dynalist tools directly without previewing, confirming, or " +
  "asking for approval.";

const GLOBAL_ROOT = `Haiku Validation ${RUN_ID}`;

interface Task {
  category: string;
  id: string;
  prompt: string;
}

interface Pipeline {
  name: string;
  rootFolder: string;
  tasks: Task[];
}

// IDs returned by the coordinator for each pipeline.
interface PipelineIds {
  folderId: string;
  docId?: string;
}

// Pipeline spec: defines tasks as a function of coordinator-provided IDs.
// Tasks are resolved after the coordinator creates the folders and documents.
interface PipelineSpec {
  name: string;
  needsDoc: boolean;
  tasksFn: (ids: PipelineIds) => Task[];
}

// ---------------------------------------------------------------------------
// Pipeline specs
// ---------------------------------------------------------------------------

const PIPELINE_SPECS: PipelineSpec[] = [
  // Read + search.
  {
    name: "read-search",
    needsDoc: true,
    tasksFn: ({ docId }) => [
      {
        category: "setup",
        id: "insert-items",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. Insert ` +
          `three top-level items: 'Alpha', 'Beta' (with a note 'secret keyword'), and 'Gamma'.`,
      },
      {
        category: "search",
        id: "search-item",
        prompt:
          `Using Dynalist, search for 'Beta' in the document with file_id '${docId}'.`,
      },
      {
        category: "search",
        id: "search-notes",
        prompt:
          `Using Dynalist, search for 'secret keyword' in the document with ` +
          `file_id '${docId}' with search_notes set to true.`,
      },
    ],
  },

  // Insert + positioning.
  {
    name: "insert-position",
    needsDoc: true,
    tasksFn: ({ docId }) => [
      {
        category: "setup",
        id: "insert-items",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. Insert ` +
          `three top-level items: 'Alpha', 'Beta', 'Gamma'.`,
      },
      {
        category: "positioning",
        id: "insert-after",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Find the item 'Alpha'. Insert a new item 'After Alpha' immediately after it ` +
          `using position 'after' with Alpha's item_id as reference_item_id.`,
      },
      {
        category: "positioning",
        id: "insert-first-child",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Find the item 'Beta'. Insert 'Child of Beta' as the first child of 'Beta' ` +
          `using position 'first_child' with Beta's item_id as reference_item_id.`,
      },
      {
        category: "insert",
        id: "insert-nested",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Insert a new top-level item 'Parent' with one child 'Child'. ` +
          `Use the items array with a nested children object.`,
      },
    ],
  },

  // Edit + enums.
  {
    name: "edit-enums",
    needsDoc: true,
    tasksFn: ({ docId }) => [
      {
        category: "setup",
        id: "insert-items",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. Insert ` +
          `one top-level item 'Section' with heading 'h2' and color 'blue'.`,
      },
      {
        category: "edit",
        id: "edit-heading-color",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Find the item 'Section'. Edit it to change the heading to 'h1' and remove ` +
          `the color (set to 'none').`,
      },
      {
        category: "insert",
        id: "insert-checkbox-color",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Insert a new top-level item 'Task' with color 'red' and a checkbox.`,
      },
      {
        category: "inbox",
        id: "inbox-with-metadata",
        prompt:
          `Using Dynalist, send an item to my inbox with content 'Inbox Test Item', ` +
          `heading 'h3', and color 'green'.`,
      },
    ],
  },

  // Delete + move.
  {
    name: "delete-move",
    needsDoc: true,
    tasksFn: ({ docId }) => [
      {
        category: "setup",
        id: "insert-items",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. Insert ` +
          `a top-level item 'Parent' with one child 'Child'. Also insert three ` +
          `more top-level items: 'Alpha', 'Beta', 'Gamma'.`,
      },
      {
        category: "delete",
        id: "delete-promote",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Find the item 'Parent' and delete it with children set to 'promote', ` +
          `so 'Child' becomes a top-level item.`,
      },
      {
        category: "move",
        id: "move-after",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Find the items 'Alpha' and 'Gamma'. Move 'Alpha' to position 'after' 'Gamma'.`,
      },
      {
        category: "move",
        id: "move-as-child",
        prompt:
          `Using Dynalist, read the document with file_id '${docId}'. ` +
          `Find the items 'Beta' and 'Gamma'. Move 'Beta' to be the first_child of 'Gamma'.`,
      },
    ],
  },

  // File management. Uses folderId directly; no pre-created document.
  {
    name: "file-mgmt",
    needsDoc: false,
    tasksFn: ({ folderId }) => [
      {
        category: "file-mgmt",
        id: "create-subfolder",
        prompt:
          `Using Dynalist, create a new folder called 'Sub' inside the folder ` +
          `with file_id '${folderId}'.`,
      },
      {
        category: "file-mgmt",
        id: "create-doc-in-subfolder",
        prompt:
          `Using Dynalist, list documents to find the folder 'Sub' ` +
          `(inside the folder with file_id '${folderId}'). ` +
          `Create a new document called 'Sub Doc' inside it.`,
      },
      {
        category: "file-mgmt",
        id: "rename-doc",
        prompt:
          `Using Dynalist, list documents to find the document 'Sub Doc' ` +
          `(inside 'Sub'). Rename it to 'Sub Doc Renamed'.`,
      },
      {
        category: "file-mgmt",
        id: "move-doc",
        prompt:
          `Using Dynalist, list documents to find the document 'Sub Doc Renamed'. ` +
          `Move it into the folder with file_id '${folderId}' (out of 'Sub').`,
      },
      {
        category: "file-mgmt",
        id: "rename-subfolder",
        prompt:
          `Using Dynalist, list documents to find the folder 'Sub' ` +
          `(inside the folder with file_id '${folderId}'). Rename it to 'Sub Renamed'.`,
      },
      {
        category: "file-mgmt",
        id: "create-doc-before",
        prompt:
          `Using Dynalist, list documents to find 'Sub Doc Renamed' ` +
          `(inside the folder with file_id '${folderId}'). Create a new document ` +
          `called 'Before Doc' positioned before 'Sub Doc Renamed' ` +
          `(use its file_id as reference_file_id with position 'before').`,
      },
      {
        category: "file-mgmt",
        id: "move-folder-first-child",
        prompt:
          `Using Dynalist, list documents to find the folder 'Sub Renamed' ` +
          `(inside the folder with file_id '${folderId}'). Move it to be the ` +
          `first child of the folder with file_id '${folderId}' ` +
          `(use reference_file_id '${folderId}' with position 'first_child').`,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runTask(
  task: Task,
  model: string,
  logLabel?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const tag = logLabel ?? task.id;
  return new Promise((resolve) => {
    const args = [
      "-p",
      task.prompt,
      "--model",
      model,
      "--max-turns",
      String(MAX_TURNS),
      "--output-format",
      "text",
      "--append-system-prompt",
      HEADLESS_SYSTEM_PROMPT,
    ];
    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: WORK_DIR,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      const s = data.toString();
      stdout += s;
      process.stdout.write(`  [${tag}] ${s}`);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const s = data.toString();
      stderr += s;
      process.stderr.write(`  [${tag}:err] ${s}`);
    });

    proc.on("error", (err: Error) => {
      console.error(`  [${tag}:err] spawn error: ${err.message}`);
      resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: 1 });
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      stderr +=
        "\n[TIMEOUT] Task killed after " + TASK_TIMEOUT_MS / 1000 + "s\n";
      process.stderr.write(
        `  [${tag}:err] TIMEOUT - killed after ${TASK_TIMEOUT_MS / 1000}s\n`,
      );
    }, TASK_TIMEOUT_MS);

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);
      // Force non-zero exit code on timeout regardless of process exit code.
      const exitCode = timedOut ? 1 : (code ?? 1);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

interface TaskResult {
  pipeline: string;
  id: string;
  category: string;
  exitCode: number;
  stdout: string;
  elapsed: string;
}

interface ReviewRating {
  id: string;
  pass: boolean;
  stars: number;
  notes: string;
}

interface PipelineReview {
  pipeline: string;
  ratings: ReviewRating[];
  rawOutput: string;
}

async function runPipeline(
  pipeline: Pipeline,
  runDir: string,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  for (let i = 0; i < pipeline.tasks.length; i++) {
    const task = pipeline.tasks[i];
    const tag = `${pipeline.name}/${task.id}`;
    const label = `[${pipeline.name}] [${i + 1}/${pipeline.tasks.length}] ${task.id}`;
    console.log(`  ${label} Starting...`);

    const start = Date.now();
    const result = await runTask(task, VALIDATION_MODEL, tag);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(
      `  ${label} Done in ${elapsed}s (exit=${result.exitCode}, output=${result.stdout.length} chars)`,
    );

    const outputFile = join(
      runDir,
      `${pipeline.name}_${String(i + 1).padStart(2, "0")}_${task.id}.txt`,
    );
    const content = [
      `Pipeline: ${pipeline.name}`,
      `Category: ${task.category}`,
      `Task ID: ${task.id}`,
      `Step: ${i + 1}/${pipeline.tasks.length}`,
      `Prompt: ${task.prompt}`,
      `Exit code: ${result.exitCode}`,
      `Elapsed: ${elapsed}s`,
      "",
      "=== STDOUT ===",
      result.stdout,
      "",
      "=== STDERR ===",
      result.stderr,
    ].join("\n");

    await writeFile(outputFile, content);

    results.push({
      pipeline: pipeline.name,
      id: task.id,
      category: task.category,
      exitCode: result.exitCode,
      stdout: result.stdout,
      elapsed,
    });
  }

  return results;
}

async function reviewPipeline(
  pipeline: Pipeline,
  results: TaskResult[],
  runDir: string,
): Promise<PipelineReview> {
  // Build transcript sections for each task.
  const taskSections = results.map((r, i) => [
    `--- Task ${i + 1}: ${r.id} ---`,
    `Prompt: ${pipeline.tasks[i].prompt}`,
    `Exit code: ${r.exitCode}`,
    `Elapsed: ${r.elapsed}s`,
    "",
    "Transcript:",
    r.stdout || "(no output)",
  ].join("\n")).join("\n\n");

  const reviewPrompt =
    `You are reviewing the results of an automated Dynalist MCP validation test. ` +
    `A weaker model was given tasks to perform against a live Dynalist account. ` +
    `You must verify that each task was completed correctly.\n\n` +
    `Pipeline: ${pipeline.name}\n` +
    `Root folder: '${pipeline.rootFolder}'\n\n` +
    `For each task below:\n` +
    `1. Carefully read the FULL transcript. Identify every tool call the model ` +
    `made, what arguments it passed, what responses it received, and whether ` +
    `it retried or made unnecessary calls. Do NOT use elapsed time as a proxy ` +
    `for quality. Base your rating on the actual tool calls and responses.\n` +
    `2. Use Dynalist tools to verify the actual state matches expectations ` +
    `(e.g., read the document to confirm items exist in the right positions, ` +
    `with the right metadata).\n` +
    `3. Rate the task based on both transcript analysis and live verification.\n\n` +
    `${taskSections}\n\n` +
    `Output ONLY a JSON array (no other text) with one object per task:\n` +
    `[\n` +
    `  {\n` +
    `    "id": "task-id",\n` +
    `    "pass": true,\n` +
    `    "stars": 5,\n` +
    `    "notes": "brief explanation citing specific tool calls or state issues"\n` +
    `  }\n` +
    `]\n\n` +
    `Star rating guide:\n` +
    `- 5: Completed correctly on first try with minimal tool calls.\n` +
    `- 4: Completed correctly but with one unnecessary tool call or minor hesitation.\n` +
    `- 3: Completed correctly but with multiple unnecessary calls or retries.\n` +
    `- 2: Partially completed or completed with minor errors in the final state.\n` +
    `- 1: Failed or final state does not match what was requested.\n`;

  const tag = `review/${pipeline.name}`;
  console.log(`  [${tag}] Starting review...`);

  const start = Date.now();
  const result = await runTask(
    { category: "review", id: `review-${pipeline.name}`, prompt: reviewPrompt },
    COORDINATOR_MODEL,
    tag,
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  [${tag}] Done in ${elapsed}s`);

  // Write raw review output.
  await writeFile(
    join(runDir, `98_review_${pipeline.name}.txt`),
    [
      `Pipeline: ${pipeline.name}`,
      `Review model: ${COORDINATOR_MODEL}`,
      `Exit code: ${result.exitCode}`,
      `Elapsed: ${elapsed}s`,
      "",
      "=== REVIEW PROMPT ===",
      reviewPrompt,
      "",
      "=== REVIEW OUTPUT ===",
      result.stdout,
    ].join("\n"),
  );

  // Parse JSON ratings from the output. Try the full output first (if Sonnet
  // returned only JSON), then fall back to extracting from a code block.
  let ratings: ReviewRating[] = [];
  try {
    ratings = JSON.parse(result.stdout.trim());
  } catch {
    try {
      const codeBlockMatch = result.stdout.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        ratings = JSON.parse(codeBlockMatch[1]);
      }
    } catch {
      console.error(`  [${tag}] Failed to parse review JSON`);
    }
  }

  return { pipeline: pipeline.name, ratings, rawOutput: result.stdout };
}

async function confirmTestAccount(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("  WARNING: This script mutates a live Dynalist account.");
  console.log("  Only run against a TEST account, not your real one.");
  console.log("=".repeat(60));
  console.log('\nType "test-account" to confirm and proceed:\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("> ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  if (answer !== "test-account") {
    console.error("Aborted. You must type exactly: test-account");
    process.exit(1);
  }
  console.log();
}

// Write a local settings file into the work directory so spawned Claude
// sessions have all Dynalist MCP tools and the docs directory pre-allowed.
async function writeWorkDirSettings(): Promise<void> {
  const docsDir = join(import.meta.dir, "..", "docs");
  // Claude Code interprets a single leading "/" as relative to the project
  // root. Use "//" for absolute filesystem paths.
  const permDocsDir = "/" + docsDir;
  const settings = {
    permissions: {
      allow: [
        "mcp__dynalist__list_documents",
        "mcp__dynalist__read_document",
        "mcp__dynalist__search_documents",
        "mcp__dynalist__search_in_document",
        "mcp__dynalist__check_document_versions",
        "mcp__dynalist__get_recent_changes",
        "mcp__dynalist__insert_items",
        "mcp__dynalist__edit_items",
        "mcp__dynalist__delete_items",
        "mcp__dynalist__move_items",
        "mcp__dynalist__send_to_inbox",
        "mcp__dynalist__create_document",
        "mcp__dynalist__create_folder",
        "mcp__dynalist__rename_document",
        "mcp__dynalist__rename_folder",
        "mcp__dynalist__move_document",
        "mcp__dynalist__move_folder",
        `Read(${permDocsDir}/**)`,
      ],
    },
  };
  const settingsDir = join(WORK_DIR, ".claude");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.local.json"),
    JSON.stringify(settings, null, 2),
  );
}

async function main() {
  await confirmTestAccount();
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  await writeWorkDirSettings();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(OUTPUT_DIR, `run-${timestamp}`);
  await mkdir(runDir);

  console.log(`Output directory: ${runDir}`);
  console.log(`Run ID: ${RUN_ID} (global root: '${GLOBAL_ROOT}')`);
  console.log(`Coordinator model: ${COORDINATOR_MODEL}`);
  console.log(`Validation model: ${VALIDATION_MODEL}`);

  // Step 1: coordinator creates global root folder, sub-folders, and documents.
  const folderNames = PIPELINE_SPECS.map((s) => `'${GLOBAL_ROOT} ${s.name}'`).join(", ");
  const docsNeeded = PIPELINE_SPECS.filter((s) => s.needsDoc).map((s) => s.name);
  const docInstruction = docsNeeded.length > 0
    ? ` Then create a document called 'Test Doc' inside each of these folders: ${docsNeeded.map((n) => `'${GLOBAL_ROOT} ${n}'`).join(", ")}.`
    : "";

  const setupTask: Task = {
    category: "coordinator",
    id: "setup",
    prompt:
      `Using Dynalist, create a top-level folder named '${GLOBAL_ROOT}'. ` +
      `Then list documents to find '${GLOBAL_ROOT}' and create ${PIPELINE_SPECS.length} folders inside it ` +
      `(using its file_id as reference_file_id) named: ${folderNames}.${docInstruction}\n\n` +
      `After creating everything, output ONLY a JSON object mapping each folder name ` +
      `to its IDs. Use this exact format (no other text):\n` +
      `{\n` +
      PIPELINE_SPECS.map((s) =>
        `  "${s.name}": { "folder_id": "<file_id>"${s.needsDoc ? `, "doc_id": "<file_id>"` : ""} }`,
      ).join(",\n") +
      `\n}`,
  };

  console.log(
    `\n=== Step 1: Creating folders and documents (${COORDINATOR_MODEL}) ===\n`,
  );
  const setupStart = Date.now();
  const setupResult = await runTask(setupTask, COORDINATOR_MODEL);
  const setupElapsed = ((Date.now() - setupStart) / 1000).toFixed(1);
  console.log(
    `\n  Setup done in ${setupElapsed}s (exit=${setupResult.exitCode})\n`,
  );

  await writeFile(
    join(runDir, "00_coordinator_setup.txt"),
    [
      `Category: coordinator`,
      `Task ID: setup`,
      `Prompt: ${setupTask.prompt}`,
      `Exit code: ${setupResult.exitCode}`,
      `Elapsed: ${setupElapsed}s`,
      "",
      "=== STDOUT ===",
      setupResult.stdout,
      "",
      "=== STDERR ===",
      setupResult.stderr,
    ].join("\n"),
  );

  if (setupResult.exitCode !== 0) {
    console.error("Setup failed. Aborting.");
    process.exit(1);
  }

  // Parse coordinator output for pipeline IDs.
  let pipelineIds: Record<string, PipelineIds>;
  try {
    const raw = setupResult.stdout.trim();
    let parsed: Record<string, { folder_id: string; doc_id?: string }>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const codeBlockMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        parsed = JSON.parse(codeBlockMatch[1]);
      } else {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("No JSON found in coordinator output");
        }
      }
    }
    pipelineIds = {};
    for (const spec of PIPELINE_SPECS) {
      const entry = parsed[spec.name];
      if (!entry?.folder_id) {
        throw new Error(`Missing folder_id for pipeline '${spec.name}'`);
      }
      if (spec.needsDoc && !entry.doc_id) {
        throw new Error(`Missing doc_id for pipeline '${spec.name}'`);
      }
      pipelineIds[spec.name] = {
        folderId: entry.folder_id,
        docId: entry.doc_id,
      };
    }
  } catch (err) {
    console.error("Failed to parse coordinator output:", err);
    console.error("Raw output:", setupResult.stdout);
    process.exit(1);
  }

  // Resolve pipeline specs into concrete pipelines with IDs.
  const PIPELINES: Pipeline[] = PIPELINE_SPECS.map((spec) => ({
    name: spec.name,
    rootFolder: `${GLOBAL_ROOT} ${spec.name}`,
    tasks: spec.tasksFn(pipelineIds[spec.name]),
  }));

  // Step 2: run all pipelines in parallel.
  const totalTasks = PIPELINES.reduce((n, p) => n + p.tasks.length, 0);
  console.log(
    `=== Step 2: Running ${PIPELINES.length} validation pipelines (${totalTasks} tasks, ${VALIDATION_MODEL}) ===\n`,
  );

  const pipelineStart = Date.now();
  const allResults = await Promise.all(
    PIPELINES.map((pipeline) => runPipeline(pipeline, runDir)),
  );
  const pipelineElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  console.log(`\n  All pipelines done in ${pipelineElapsed}s\n`);

  // Step 3: Sonnet reviews each pipeline's results against live state.
  console.log(
    `=== Step 3: Reviewing ${PIPELINES.length} pipelines (${COORDINATOR_MODEL}) ===\n`,
  );

  const reviewStart = Date.now();
  const reviews = await Promise.all(
    PIPELINES.map((pipeline, i) =>
      reviewPipeline(pipeline, allResults[i], runDir),
    ),
  );
  const reviewElapsed = ((Date.now() - reviewStart) / 1000).toFixed(1);
  console.log(`\n  All reviews done in ${reviewElapsed}s\n`);

  // Collect ratings from reviews and write structured summary.
  const allRatings = reviews.flatMap((r) =>
    r.ratings.map((rating) => ({ pipeline: r.pipeline, ...rating })),
  );
  const unparsed = allResults.flat().length - allRatings.length;

  const summaryFile = join(runDir, "_summary.json");
  await writeFile(summaryFile, JSON.stringify({ ratings: allRatings, reviews }, null, 2));

  // Step 4: final aggregator produces the human-readable summary.
  const ratingsJson = JSON.stringify(allRatings, null, 2);
  const aggregatorPrompt =
    `You are producing a final summary of a Dynalist MCP validation test run ` +
    `where a weaker model (${VALIDATION_MODEL}) was tested against ${allResults.flat().length} tasks ` +
    `across ${PIPELINES.length} pipelines, and a stronger model (${COORDINATOR_MODEL}) reviewed the results.\n\n` +
    `Here are the review ratings:\n\n${ratingsJson}\n\n` +
    (unparsed > 0
      ? `WARNING: ${unparsed} tasks could not be parsed from review output.\n\n`
      : "") +
    `Produce a concise summary with:\n` +
    `1. Overall pass/fail count and average star rating.\n` +
    `2. Per-pipeline breakdown (one line each): pass count and average stars.\n` +
    `3. For every task rated below 5 stars, list it with its star rating and ` +
    `the reviewer's notes explaining why.\n` +
    `4. If there were any failures (pass: false), highlight them prominently.\n\n` +
    `Use plain text, no markdown. Be concise.`;

  console.log(
    `=== Step 4: Generating final summary (${COORDINATOR_MODEL}) ===\n`,
  );
  const aggStart = Date.now();
  const aggResult = await runTask(
    { category: "aggregator", id: "final-summary", prompt: aggregatorPrompt },
    COORDINATOR_MODEL,
    "aggregator",
  );
  const aggElapsed = ((Date.now() - aggStart) / 1000).toFixed(1);

  await writeFile(
    join(runDir, "99_aggregator_final-summary.txt"),
    [
      `Category: aggregator`,
      `Task ID: final-summary`,
      `Exit code: ${aggResult.exitCode}`,
      `Elapsed: ${aggElapsed}s`,
      "",
      "=== OUTPUT ===",
      aggResult.stdout,
    ].join("\n"),
  );

  console.log(`\n=== Final Summary ===\n`);
  console.log(aggResult.stdout);
  console.log(`  Summary JSON: ${summaryFile}`);
  console.log(`  Full output: ${runDir}`);
  console.log(
    `\nCleanup required: delete the folder '${GLOBAL_ROOT}' in Dynalist. ` +
    `The API cannot delete folders, so this must be done manually.`,
  );

  const failed = allRatings.filter((r) => !r.pass).length;
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
