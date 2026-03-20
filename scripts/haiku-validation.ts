/**
 * Weak-model instruction validation harness.
 *
 * Tests whether Claude Haiku can correctly follow MCP instructions and tool
 * descriptions for string enums, positioning, nested inserts, version guards,
 * URL extraction, compositional patterns, deletes, and moves.
 *
 * Architecture:
 *   1. A Sonnet coordinator creates 6 isolated root folders in Dynalist.
 *   2. Six Haiku pipelines run in parallel, each working exclusively within
 *      its own root folder. Each pipeline is internally sequential.
 *   3. A Sonnet coordinator cleans up all root folders at the end.
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
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 25);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 180_000);

// Short random suffix so repeated runs do not collide on folder names.
const RUN_ID = Math.random().toString(36).slice(2, 6);

// System prompt override that prevents the model from following the MCP
// instruction to preview changes and wait for user confirmation. Without this,
// headless sessions output a preview and never proceed with the mutation.
const HEADLESS_SYSTEM_PROMPT =
  "This is an automated test sequence running against a test Dynalist account. " +
  "You MUST proceed with all Dynalist mutation tools immediately. Do NOT " +
  "preview Dynalist changes, ask for confirmation, or wait for user approval. " +
  "Execute every requested Dynalist operation directly.";

const ROOT_FOLDERS = Array.from(
  { length: 6 },
  (_, i) => `Validation ${RUN_ID} Root ${i + 1}`,
);

interface Task {
  category: string;
  id: string;
  prompt: string;
}

interface Pipeline {
  name: string;
  tasks: Task[];
}

// ---------------------------------------------------------------------------
// Pipeline 1: insert_items positioning
// ---------------------------------------------------------------------------
const positioningPipeline: Pipeline = {
  name: "positioning",
  tasks: [
    {
      category: "setup",
      id: "create-doc",
      prompt: `Using Dynalist, list documents to find the folder '${ROOT_FOLDERS[0]}'. Create a new document called 'Positioning Test Doc' in that folder. Then insert five top-level items: 'Item A', 'Item B', 'Item C', 'Item D', 'Item E'.`,
    },
    {
      category: "positioning",
      id: "insert-last-child-root",
      prompt: `Using Dynalist, find and read the document 'Positioning Test Doc' (in folder '${ROOT_FOLDERS[0]}'). Insert a new item 'Last Child' as the last top-level item (position last_child, omit reference_item_id).`,
    },
    {
      category: "positioning",
      id: "insert-first-child-root",
      prompt: `Using Dynalist, find and read the document 'Positioning Test Doc' (in folder '${ROOT_FOLDERS[0]}'). Insert a new item 'First Child' as the first top-level item (position first_child, omit reference_item_id).`,
    },
    {
      category: "positioning",
      id: "insert-after-sibling",
      prompt: `Using Dynalist, find and read the document 'Positioning Test Doc' (in folder '${ROOT_FOLDERS[0]}'). Find the item 'Item B'. Insert a new item 'After B' immediately after it using position 'after' with Item B's item_id as reference_item_id.`,
    },
    {
      category: "positioning",
      id: "insert-before-sibling",
      prompt: `Using Dynalist, find and read the document 'Positioning Test Doc' (in folder '${ROOT_FOLDERS[0]}'). Find the item 'Item D'. Insert a new item 'Before D' immediately before it using position 'before' with Item D's item_id as reference_item_id.`,
    },
    {
      category: "positioning",
      id: "insert-child-of-item",
      prompt: `Using Dynalist, find and read the document 'Positioning Test Doc' (in folder '${ROOT_FOLDERS[0]}'). Find the item 'Item A'. Insert 'Child of A' as the first child of 'Item A' using position 'first_child' with Item A's item_id as reference_item_id.`,
    },
    {
      category: "cleanup",
      id: "cleanup",
      prompt: `Using Dynalist, find and read the document 'Positioning Test Doc' (in folder '${ROOT_FOLDERS[0]}'). Delete ALL its top-level items in a single delete_items call.`,
    },
  ],
};

// ---------------------------------------------------------------------------
// Pipeline 2: enums (heading, color, nested inserts with metadata)
// ---------------------------------------------------------------------------
const enumsPipeline: Pipeline = {
  name: "enums",
  tasks: [
    {
      category: "setup",
      id: "create-doc",
      prompt: `Using Dynalist, list documents to find the folder '${ROOT_FOLDERS[1]}'. Create a new document called 'Enums Test Doc' in that folder. Then insert one top-level item: 'Placeholder'.`,
    },
    {
      category: "nested-insert",
      id: "insert-nested-tree",
      prompt: `Using Dynalist, find and read the document 'Enums Test Doc' (in folder '${ROOT_FOLDERS[1]}'). Insert the following nested structure at the end: A parent item 'Project' with two children: 'Phase 1' (which itself has a child 'Design') and 'Phase 2' (which has a child 'Build'). Use the items array with nested children objects.`,
    },
    {
      category: "nested-insert",
      id: "insert-tree-with-metadata",
      prompt: `Using Dynalist, find and read the document 'Enums Test Doc' (in folder '${ROOT_FOLDERS[1]}'). Insert a new top-level item 'Shopping' with heading 'h2' and three children: 'Milk' (with checkbox and color 'green'), 'Eggs' (with checkbox), and 'Bread' (with checkbox and checked set to true). Use the JSON tree format with nested children.`,
    },
    {
      category: "enums",
      id: "insert-with-heading",
      prompt: `Using Dynalist, find and read the document 'Enums Test Doc' (in folder '${ROOT_FOLDERS[1]}'). Insert a new top-level item 'Important Section' with heading level h2 at the end.`,
    },
    {
      category: "enums",
      id: "edit-heading-and-color",
      prompt: `Using Dynalist, find and read the document 'Enums Test Doc' (in folder '${ROOT_FOLDERS[1]}'). Find the item 'Important Section'. Edit it to change the heading to h1 and add color 'blue'.`,
    },
    {
      category: "enums",
      id: "clear-heading-and-color",
      prompt: `Using Dynalist, find and read the document 'Enums Test Doc' (in folder '${ROOT_FOLDERS[1]}'). Find the item 'Important Section'. Edit it to remove the heading (set to 'none') and remove the color (set to 'none').`,
    },
    {
      category: "enums",
      id: "insert-with-color",
      prompt: `Using Dynalist, find and read the document 'Enums Test Doc' (in folder '${ROOT_FOLDERS[1]}'). Insert a new top-level item 'Urgent Task' with color 'red' and a checkbox at the end.`,
    },
    {
      category: "enums",
      id: "inbox-with-metadata",
      prompt: `Using Dynalist, send an item to my inbox with content 'Inbox Test Item', heading 'h3', and color 'green'.`,
    },
    {
      category: "cleanup",
      id: "cleanup",
      prompt: `Using Dynalist, find and read the document 'Enums Test Doc' (in folder '${ROOT_FOLDERS[1]}'). Delete ALL its top-level items in a single delete_items call.`,
    },
  ],
};

// ---------------------------------------------------------------------------
// Pipeline 3: edit_items + version guard
// ---------------------------------------------------------------------------
const editPipeline: Pipeline = {
  name: "edit",
  tasks: [
    {
      category: "setup",
      id: "create-doc",
      prompt: `Using Dynalist, list documents to find the folder '${ROOT_FOLDERS[2]}'. Create a new document called 'Edit Test Doc' in that folder. Then insert five top-level items: 'Item A', 'Item B', 'Item C', 'Item D', 'Item E'.`,
    },
    {
      category: "edit",
      id: "edit-content",
      prompt: `Using Dynalist, find and read the document 'Edit Test Doc' (in folder '${ROOT_FOLDERS[2]}'). Find the item 'Item C'. Edit its content to 'Item C (edited)'.`,
    },
    {
      category: "edit",
      id: "edit-note",
      prompt: `Using Dynalist, find and read the document 'Edit Test Doc' (in folder '${ROOT_FOLDERS[2]}'). Find the item 'Item B'. Set its note to 'This is a test note'.`,
    },
    {
      category: "edit",
      id: "edit-checkbox",
      prompt: `Using Dynalist, find and read the document 'Edit Test Doc' (in folder '${ROOT_FOLDERS[2]}'). Find the item 'Item E'. Set checked to true on it.`,
    },
    {
      category: "version-guard",
      id: "read-then-edit",
      prompt: `Using Dynalist, find and read the document 'Edit Test Doc' (in folder '${ROOT_FOLDERS[2]}') to get its current sync token. Then edit the item 'Item A' to change its content to 'Item A (v-tested)'. Make sure to pass the expected_sync_token from the read response.`,
    },
    {
      category: "cleanup",
      id: "cleanup",
      prompt: `Using Dynalist, find and read the document 'Edit Test Doc' (in folder '${ROOT_FOLDERS[2]}'). Delete ALL its top-level items in a single delete_items call.`,
    },
  ],
};

// ---------------------------------------------------------------------------
// Pipeline 4: search + compositional patterns + URL extraction
// ---------------------------------------------------------------------------
const searchPipeline: Pipeline = {
  name: "search",
  tasks: [
    {
      category: "setup",
      id: "create-doc",
      prompt: `Using Dynalist, list documents to find the folder '${ROOT_FOLDERS[3]}'. Create a new document called 'Search Test Doc' in that folder. Then insert this nested structure: a top-level item 'Outer' with a child 'Inner' (give 'Inner' a note that says 'secret keyword'), and 'Inner' should have a child 'Deep'. Also insert a second top-level item 'Another' with a child 'Also Inner'.`,
    },
    {
      category: "search",
      id: "search-with-ancestors",
      prompt: `Using Dynalist, find the document 'Search Test Doc' (in folder '${ROOT_FOLDERS[3]}'). Search for 'Inner' in that document and show me the full ancestor chain for each match (use parent_levels 'all').`,
    },
    {
      category: "search",
      id: "search-in-notes",
      prompt: `Using Dynalist, find the document 'Search Test Doc' (in folder '${ROOT_FOLDERS[3]}'). Search for 'secret keyword' in that document with search_notes set to true. Tell me which item has it.`,
    },
    {
      category: "compositional",
      id: "drill-depth-limited",
      prompt: `Using Dynalist, find and read the document 'Search Test Doc' (in folder '${ROOT_FOLDERS[3]}') with max_depth 1. For any items that show depth_limited: true, pick one and call read_document again with that item's item_id to see its children.`,
    },
    {
      category: "cleanup",
      id: "cleanup",
      prompt: `Using Dynalist, find and read the document 'Search Test Doc' (in folder '${ROOT_FOLDERS[3]}'). Delete ALL its top-level items in a single delete_items call.`,
    },
  ],
};

// ---------------------------------------------------------------------------
// Pipeline 5: delete_items + move_items
// ---------------------------------------------------------------------------
const deleteMovePipeline: Pipeline = {
  name: "delete-move",
  tasks: [
    {
      category: "setup",
      id: "create-doc",
      prompt: `Using Dynalist, list documents to find the folder '${ROOT_FOLDERS[4]}'. Create a new document called 'Move Test Doc' in that folder. Then insert this structure: a top-level item 'Parent' with three children 'Child 1', 'Child 2', 'Child 3'. Also insert four more top-level items: 'Sibling A', 'Sibling B', 'Sibling C', 'Target'.`,
    },
    {
      category: "delete",
      id: "delete-with-promote",
      prompt: `Using Dynalist, find and read the document 'Move Test Doc' (in folder '${ROOT_FOLDERS[4]}'). Find the item 'Parent' and delete it with children set to 'promote', so its children ('Child 1', 'Child 2', 'Child 3') become top-level items.`,
    },
    {
      category: "delete",
      id: "delete-multiple",
      prompt: `Using Dynalist, find and read the document 'Move Test Doc' (in folder '${ROOT_FOLDERS[4]}'). Delete the items 'Child 1' and 'Child 2' in a single delete_items call.`,
    },
    {
      category: "move",
      id: "move-after-sibling",
      prompt: `Using Dynalist, find and read the document 'Move Test Doc' (in folder '${ROOT_FOLDERS[4]}'). Find the items 'Sibling A' and 'Sibling C'. Move 'Sibling A' to position 'after' 'Sibling C'.`,
    },
    {
      category: "move",
      id: "move-as-child",
      prompt: `Using Dynalist, find and read the document 'Move Test Doc' (in folder '${ROOT_FOLDERS[4]}'). Find the items 'Sibling B' and 'Target'. Move 'Target' to be the first_child of 'Sibling B'.`,
    },
    {
      category: "cleanup",
      id: "cleanup",
      prompt: `Using Dynalist, find and read the document 'Move Test Doc' (in folder '${ROOT_FOLDERS[4]}'). Delete ALL its top-level items in a single delete_items call.`,
    },
  ],
};

// ---------------------------------------------------------------------------
// Pipeline 6: file management (create, rename, move folders and documents)
// ---------------------------------------------------------------------------
const fileMgmtPipeline: Pipeline = {
  name: "file-mgmt",
  tasks: [
    {
      category: "file-mgmt",
      id: "create-subfolder",
      prompt: `Using Dynalist, list documents to find the folder '${ROOT_FOLDERS[5]}'. Create a new folder called 'Subfolder' inside it.`,
    },
    {
      category: "file-mgmt",
      id: "create-doc-in-subfolder",
      prompt: `Using Dynalist, list documents to find the folder 'Subfolder' (inside '${ROOT_FOLDERS[5]}'). Create a new document called 'Subfolder Doc' inside it.`,
    },
    {
      category: "file-mgmt",
      id: "rename-subfolder",
      prompt: `Using Dynalist, list documents to find the folder 'Subfolder' (inside '${ROOT_FOLDERS[5]}'). Rename it to 'Subfolder Renamed'.`,
    },
    {
      category: "file-mgmt",
      id: "rename-document",
      prompt: `Using Dynalist, list documents to find the document 'Subfolder Doc' (inside 'Subfolder Renamed' in '${ROOT_FOLDERS[5]}'). Rename it to 'Subfolder Doc Renamed'.`,
    },
    {
      category: "file-mgmt",
      id: "move-document",
      prompt: `Using Dynalist, list documents to find the document 'Subfolder Doc Renamed' and the folder '${ROOT_FOLDERS[5]}'. Move the document into '${ROOT_FOLDERS[5]}' (out of 'Subfolder Renamed').`,
    },
    {
      category: "file-mgmt",
      id: "create-dest-subfolder",
      prompt: `Using Dynalist, list documents to find the folder '${ROOT_FOLDERS[5]}'. Create a new folder called 'Dest Subfolder' inside it.`,
    },
    {
      category: "file-mgmt",
      id: "move-subfolder",
      prompt: `Using Dynalist, list documents to find the folders 'Subfolder Renamed' and 'Dest Subfolder' (both in '${ROOT_FOLDERS[5]}'). Move 'Subfolder Renamed' into 'Dest Subfolder'.`,
    },
  ],
};

const PIPELINES: Pipeline[] = [
  positioningPipeline,
  enumsPipeline,
  editPipeline,
  searchPipeline,
  deleteMovePipeline,
  fileMgmtPipeline,
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
      cwd: "/tmp",
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

async function main() {
  await confirmTestAccount();
  await mkdir(OUTPUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(OUTPUT_DIR, `run-${timestamp}`);
  await mkdir(runDir);

  console.log(`Output directory: ${runDir}`);
  console.log(
    `Run ID: ${RUN_ID} (folder prefix: 'Validation ${RUN_ID} Root')`,
  );
  console.log(`Coordinator model: ${COORDINATOR_MODEL}`);
  console.log(`Validation model: ${VALIDATION_MODEL}`);

  // Step 1: coordinator creates root folders.
  const folderList = ROOT_FOLDERS.map((f) => `'${f}'`).join(", ");
  const setupTask: Task = {
    category: "coordinator",
    id: "create-root-folders",
    prompt: `Using Dynalist, create 6 new top-level folders named: ${folderList}. Create them one at a time (omit parent_folder_id to create at the top level).`,
  };

  console.log(
    `\n=== Step 1: Creating ${ROOT_FOLDERS.length} root folders (${COORDINATOR_MODEL}) ===\n`,
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

  // Step 3: coordinator cleans up root folders.
  const cleanupTask: Task = {
    category: "coordinator",
    id: "cleanup-root-folders",
    prompt: `Using Dynalist, list documents. Find all folders named ${folderList}. For each folder: find all documents inside it (and inside any subfolders), read each document, and delete all its top-level items. Then report what you cleaned up. Note: the Dynalist API cannot delete documents or folders themselves, so just empty the documents.`,
  };

  console.log(
    `=== Step 3: Cleaning up root folders (${COORDINATOR_MODEL}) ===\n`,
  );
  const cleanupStart = Date.now();
  const cleanupResult = await runTask(cleanupTask, COORDINATOR_MODEL);
  const cleanupElapsed = ((Date.now() - cleanupStart) / 1000).toFixed(1);
  console.log(
    `\n  Cleanup done in ${cleanupElapsed}s (exit=${cleanupResult.exitCode})\n`,
  );

  await writeFile(
    join(runDir, "99_coordinator_cleanup-root-folders.txt"),
    [
      `Category: coordinator`,
      `Task ID: cleanup-root-folders`,
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
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
