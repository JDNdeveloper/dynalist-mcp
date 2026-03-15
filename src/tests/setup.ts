/**
 * Bun test preload: suppress stderr so passing test runs are quiet.
 * Loaded via bunfig.toml [test].preload before any test file executes.
 *
 * Set VERBOSE_TESTS=1 to re-enable stderr output when debugging.
 */

if (!process.env.VERBOSE_TESTS) {
  console.error = () => {};
}
