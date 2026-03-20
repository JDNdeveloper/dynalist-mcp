/**
 * Weak-model instruction validation harness.
 *
 * Tests whether Claude Haiku can correctly follow MCP instructions and tool
 * descriptions for string enums, positioning, nested inserts, deletes, moves,
 * search, and file management.
 *
 * Architecture:
 *   1. A Sonnet coordinator creates one global root folder in Dynalist,
 *      then N sub-folders inside it (one per pipeline) for isolation.
 *   2. Haiku pipelines run in parallel, each working exclusively within
 *      its own sub-folder. Each pipeline is internally sequential.
 *   3. A Sonnet coordinator cleans up any inbox items added by the test.
 *   4. The user manually deletes the global root folder (API limitation).
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

const GLOBAL_ROOT = `Validation ${RUN_ID}`;

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

// Helper to build a pipeline with an auto-assigned root folder name.
function pipeline(
  name: string,
  tasksFn: (folder: string) => Task[],
): Pipeline {
  const rootFolder = `${GLOBAL_ROOT} ${name}`;
  return { name, rootFolder, tasks: tasksFn(rootFolder) };
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

const PIPELINES: Pipeline[] = [
  // Read + search.
  pipeline("read-search", (f) => [
    {
      category: "setup",
      id: "create-doc",
      prompt:
        `Using Dynalist, list documents to find the folder '${f}'. ` +
        `Create a new document called 'Test Doc' in that folder. Then insert ` +
        `three top-level items: 'Alpha', 'Beta' (with a note 'secret keyword'), and 'Gamma'.`,
    },
    {
      category: "search",
      id: "search-item",
      prompt:
        `Using Dynalist, find the document 'Test Doc' (in folder '${f}'). ` +
        `Search for 'Beta' in that document.`,
    },
    {
      category: "search",
      id: "search-notes",
      prompt:
        `Using Dynalist, find the document 'Test Doc' (in folder '${f}'). ` +
        `Search for 'secret keyword' in that document with search_notes set to true.`,
    },
  ]),

  // Insert + positioning.
  pipeline("insert-position", (f) => [
    {
      category: "setup",
      id: "create-doc",
      prompt:
        `Using Dynalist, list documents to find the folder '${f}'. ` +
        `Create a new document called 'Test Doc' in that folder. Then insert ` +
        `three top-level items: 'Alpha', 'Beta', 'Gamma'.`,
    },
    {
      category: "positioning",
      id: "insert-after",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Find the item 'Alpha'. Insert a new item 'After Alpha' immediately after it ` +
        `using position 'after' with Alpha's item_id as reference_item_id.`,
    },
    {
      category: "positioning",
      id: "insert-first-child",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Find the item 'Beta'. Insert 'Child of Beta' as the first child of 'Beta' ` +
        `using position 'first_child' with Beta's item_id as reference_item_id.`,
    },
    {
      category: "insert",
      id: "insert-nested",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Insert a new top-level item 'Parent' with one child 'Child'. ` +
        `Use the items array with a nested children object.`,
    },
  ]),

  // Edit + enums.
  pipeline("edit-enums", (f) => [
    {
      category: "setup",
      id: "create-doc",
      prompt:
        `Using Dynalist, list documents to find the folder '${f}'. ` +
        `Create a new document called 'Test Doc' in that folder. Then insert ` +
        `one top-level item 'Section' with heading 'h2' and color 'blue'.`,
    },
    {
      category: "edit",
      id: "edit-heading-color",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Find the item 'Section'. Edit it to change the heading to 'h1' and remove ` +
        `the color (set to 'none').`,
    },
    {
      category: "insert",
      id: "insert-checkbox-color",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Insert a new top-level item 'Task' with color 'red' and a checkbox.`,
    },
    {
      category: "inbox",
      id: "inbox-with-metadata",
      prompt:
        `Using Dynalist, send an item to my inbox with content 'Inbox Test Item', ` +
        `heading 'h3', and color 'green'.`,
    },
  ]),

  // Delete + move.
  pipeline("delete-move", (f) => [
    {
      category: "setup",
      id: "create-doc",
      prompt:
        `Using Dynalist, list documents to find the folder '${f}'. ` +
        `Create a new document called 'Test Doc' in that folder. Then insert ` +
        `a top-level item 'Parent' with one child 'Child'. Also insert three ` +
        `more top-level items: 'Alpha', 'Beta', 'Gamma'.`,
    },
    {
      category: "delete",
      id: "delete-promote",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Find the item 'Parent' and delete it with children set to 'promote', ` +
        `so 'Child' becomes a top-level item.`,
    },
    {
      category: "move",
      id: "move-after",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Find the items 'Alpha' and 'Gamma'. Move 'Alpha' to position 'after' 'Gamma'.`,
    },
    {
      category: "move",
      id: "move-as-child",
      prompt:
        `Using Dynalist, find and read the document 'Test Doc' (in folder '${f}'). ` +
        `Find the items 'Beta' and 'Gamma'. Move 'Beta' to be the first_child of 'Gamma'.`,
    },
  ]),

  // File management.
  pipeline("file-mgmt", (f) => [
    {
      category: "file-mgmt",
      id: "create-subfolder",
      prompt:
        `Using Dynalist, list documents to find the folder '${f}'. ` +
        `Create a new folder called 'Sub' inside it.`,
    },
    {
      category: "file-mgmt",
      id: "create-doc-in-subfolder",
      prompt:
        `Using Dynalist, list documents to find the folder 'Sub' ` +
        `(inside '${f}'). Create a new document called 'Sub Doc' inside it.`,
    },
    {
      category: "file-mgmt",
      id: "rename-doc",
      prompt:
        `Using Dynalist, list documents to find the document 'Sub Doc' ` +
        `(inside 'Sub' in '${f}'). Rename it to 'Sub Doc Renamed'.`,
    },
    {
      category: "file-mgmt",
      id: "move-doc",
      prompt:
        `Using Dynalist, list documents to find the document 'Sub Doc Renamed' ` +
        `and the folder '${f}'. Move the document into '${f}' (out of 'Sub').`,
    },
    {
      category: "file-mgmt",
      id: "rename-subfolder",
      prompt:
        `Using Dynalist, list documents to find the folder 'Sub' ` +
        `(inside '${f}'). Rename it to 'Sub Renamed'.`,
    },
  ]),
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

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      stderr +=
        "\n[TIMEOUT] Task killed after " + TASK_TIMEOUT_MS / 1000 + "s\n";
      process.stderr.write(
        `  [${tag}:err] TIMEOUT - killed after ${TASK_TIMEOUT_MS / 1000}s\n`,
      );
    }, TASK_TIMEOUT_MS);

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

interface TaskResult {
  pipeline: string;
  id: string;
  category: string;
  exitCode: number;
  outputLength: number;
  elapsed: string;
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
      outputLength: result.stdout.length,
      elapsed,
    });
  }

  return results;
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
        `Read(${docsDir}/**)`,
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

  // Step 1: coordinator creates global root folder, then sub-folders inside it.
  const folderList = PIPELINES.map((p) => `'${p.rootFolder}'`).join(", ");
  const setupTask: Task = {
    category: "coordinator",
    id: "create-root-folders",
    prompt:
      `Using Dynalist, create a top-level folder named '${GLOBAL_ROOT}'. ` +
      `Then list documents to find '${GLOBAL_ROOT}' and create ${PIPELINES.length} folders inside it ` +
      `(using its file_id as parent_folder_id) named: ${folderList}.`,
  };

  console.log(
    `\n=== Step 1: Creating ${PIPELINES.length} pipeline folders (${COORDINATOR_MODEL}) ===\n`,
  );
  const setupStart = Date.now();
  const setupResult = await runTask(setupTask, COORDINATOR_MODEL);
  const setupElapsed = ((Date.now() - setupStart) / 1000).toFixed(1);
  console.log(
    `\n  Setup done in ${setupElapsed}s (exit=${setupResult.exitCode})\n`,
  );

  await writeFile(
    join(runDir, "00_coordinator_create-root-folders.txt"),
    [
      `Category: coordinator`,
      `Task ID: create-root-folders`,
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

  // Step 3: coordinator cleans up inbox items added by the test.
  const cleanupTask: Task = {
    category: "coordinator",
    id: "cleanup-inbox",
    prompt:
      `Using Dynalist, read the inbox document. Find and delete the item ` +
      `'Inbox Test Item' that was added by this test run.`,
  };

  console.log(
    `=== Step 3: Cleaning up inbox items (${COORDINATOR_MODEL}) ===\n`,
  );
  const cleanupStart = Date.now();
  const cleanupResult = await runTask(cleanupTask, COORDINATOR_MODEL);
  const cleanupElapsed = ((Date.now() - cleanupStart) / 1000).toFixed(1);
  console.log(
    `\n  Inbox cleanup done in ${cleanupElapsed}s (exit=${cleanupResult.exitCode})\n`,
  );

  await writeFile(
    join(runDir, "99_coordinator_cleanup-inbox.txt"),
    [
      `Category: coordinator`,
      `Task ID: cleanup-inbox`,
      `Prompt: ${cleanupTask.prompt}`,
      `Exit code: ${cleanupResult.exitCode}`,
      `Elapsed: ${cleanupElapsed}s`,
      "",
      "=== STDOUT ===",
      cleanupResult.stdout,
      "",
      "=== STDERR ===",
      cleanupResult.stderr,
    ].join("\n"),
  );

  // Write summary.
  const summary = allResults.flat();
  const passed = summary.filter((r) => r.exitCode === 0).length;
  const failed = summary.filter((r) => r.exitCode !== 0).length;
  const summaryFile = join(runDir, "_summary.json");
  await writeFile(summaryFile, JSON.stringify(summary, null, 2));

  console.log(`\n=== Results ===`);
  console.log(`  ${passed} passed, ${failed} failed out of ${summary.length}`);
  console.log(`  Summary: ${summaryFile}`);
  console.log(`  Full output: ${runDir}`);

  if (failed > 0) {
    console.log("\nFailed tasks:");
    for (const r of summary.filter((r) => r.exitCode !== 0)) {
      console.log(`  ${r.pipeline}/${r.id} (exit ${r.exitCode})`);
    }
  }

  console.log(
    `\nCleanup required: delete the folder '${GLOBAL_ROOT}' in Dynalist. ` +
    `The API cannot delete folders, so this must be done manually.`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
