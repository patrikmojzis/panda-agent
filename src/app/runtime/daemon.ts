import {bootstrapPandaDaemonContext} from "./daemon-bootstrap.js";
import {createPandaDaemonLifecycle} from "./daemon-lifecycle.js";
import {createDaemonRequestProcessor} from "./daemon-requests.js";
import {createDaemonThreadHelpers} from "./daemon-threads.js";
import {
    DEFAULT_PANDA_DAEMON_KEY,
    PANDA_DAEMON_HEARTBEAT_INTERVAL_MS,
    PANDA_DAEMON_REQUEST_TIMEOUT_MS,
    PANDA_DAEMON_STALE_AFTER_MS,
    type PandaDaemonOptions,
    type PandaDaemonServices,
    resolveImplicitHomeThreadReplacementAgent,
} from "./daemon-shared.js";

export {
  DEFAULT_PANDA_DAEMON_KEY,
  PANDA_DAEMON_HEARTBEAT_INTERVAL_MS,
  PANDA_DAEMON_REQUEST_TIMEOUT_MS,
  PANDA_DAEMON_STALE_AFTER_MS,
  resolveImplicitHomeThreadReplacementAgent,
};

export type {
  PandaDaemonOptions,
  PandaDaemonServices,
};

export async function createPandaDaemon(options: PandaDaemonOptions): Promise<PandaDaemonServices> {
  const context = await bootstrapPandaDaemonContext(options);
  const threads = createDaemonThreadHelpers(context);
  const processRequest = createDaemonRequestProcessor(context, threads);
  return createPandaDaemonLifecycle({
    context,
    processRequest,
  });
}
