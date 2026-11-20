/**
 * Log sink for Cloudflare Workers. Each level goes to the matching
 * console method so Workers Logs can filter by level.
 */

import type { LogSink } from "../config";

export const workersLogSink: LogSink = (level, line) => {
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "info":
      console.info(line);
      break;
    case "debug":
      console.debug(line);
      break;
  }
};
