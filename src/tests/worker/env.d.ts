// Types the `env` export of cloudflare:test as the Worker's Env.

import type { Env as WorkerEnv } from "../../worker/env";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}
  }
}

export {};
