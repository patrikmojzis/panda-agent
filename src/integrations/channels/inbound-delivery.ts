import type {RememberedRoute} from "../../domain/channels/types.js";
import type {SessionRouteRepo} from "../../domain/sessions/routes/repo.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {submitCurrentSessionInput, type CurrentSessionThread} from "../../domain/sessions/current-thread.js";
import type {
  ThreadRuntimeCoordinator,
  ThreadWakeMode,
} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadInputPayload} from "../../domain/threads/runtime/types.js";

/**
 * Persists the latest channel route before waking the thread. This keeps
 * `outbound` route memory available to the very run caused by the inbound
 * message, instead of racing behind `submitInput`.
 */
export async function submitRememberedChannelInput(input: {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  identityId?: string;
  mode?: ThreadWakeMode;
  payload: ThreadInputPayload;
  route: RememberedRoute;
  routes: Pick<SessionRouteRepo, "saveLastRoute">;
  sessions: Pick<SessionStore, "getSession">;
  sessionId: string;
}): Promise<CurrentSessionThread> {
  await input.routes.saveLastRoute({
    sessionId: input.sessionId,
    identityId: input.identityId,
    route: input.route,
  });
  return submitCurrentSessionInput({
    sessions: input.sessions,
    sessionId: input.sessionId,
    coordinator: input.coordinator,
    ...(input.mode === undefined ? {} : {mode: input.mode}),
    payload: input.payload,
  });
}
