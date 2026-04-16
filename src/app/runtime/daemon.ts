import {bootstrapDaemonContext} from "./daemon-bootstrap.js";
import {createDaemonLifecycle} from "./daemon-lifecycle.js";
import {createDaemonRequestProcessor} from "./daemon-requests.js";
import {createDaemonThreadHelpers} from "./daemon-threads.js";
import {
    DAEMON_HEARTBEAT_INTERVAL_MS,
    DAEMON_REQUEST_TIMEOUT_MS,
    DAEMON_STALE_AFTER_MS,
    type DaemonOptions,
    type DaemonServices,
    DEFAULT_DAEMON_KEY,
} from "./daemon-shared.js";

export {
  DEFAULT_DAEMON_KEY,
  DAEMON_HEARTBEAT_INTERVAL_MS,
  DAEMON_REQUEST_TIMEOUT_MS,
  DAEMON_STALE_AFTER_MS,
};

export type {
  DaemonOptions,
  DaemonServices,
};

export async function createDaemon(options: DaemonOptions): Promise<DaemonServices> {
  const context = await bootstrapDaemonContext(options);
  const threads = createDaemonThreadHelpers(context);
  const processRequest = createDaemonRequestProcessor(context, threads);
  return createDaemonLifecycle({
    context,
    processRequest,
  });
}
