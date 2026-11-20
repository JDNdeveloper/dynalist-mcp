/**
 * Bun test preload: suppress stderr so passing test runs are quiet, and
 * install the file config loader that the stdio server uses. Loaded via
 * bunfig.toml [test].preload before any test file executes.
 *
 * Set VERBOSE_TESTS=1 to re-enable stderr output when debugging.
 */

import { setConfigLoader } from "../config";
import { createFileConfigLoader } from "../config-file";

if (!process.env.VERBOSE_TESTS) {
  console.error = () => {};
}

setConfigLoader(createFileConfigLoader());
