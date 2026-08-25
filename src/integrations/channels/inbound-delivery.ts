import type {RememberedRoute} from "../../domain/channels/types.js";
import {submitCurrentSessionInput, type SessionInputDeliveryResult} from "../../domain/sessions/current-thread.js";
import type {
  ThreadRuntimeCoordinator,
  ThreadWakeMode,
} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadEnqueueOptions, ThreadInputPayload} from "../../domain/threads/runtime/types.js";

export async function submitDurableRuntimeRequestInput(input: {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
  enqueueOptions?: ThreadEnqueueOptions;
  mode?: ThreadWakeMode;
  payload: ThreadInputPayload;
  sessionId: string;
}): Promise<SessionInputDeliveryResult> {
  return submitCurrentSessionInput({
    sessionId: input.sessionId,
    coordinator: input.coordinator,
    ...(input.mode === undefined ? {} : {mode: input.mode}),
    ...(input.enqueueOptions === undefined ? {} : {options: input.enqueueOptions}),
    payload: input.payload,
  });
}

/**
 * Persists the route and input in one database statement. The run can never
 * observe the input without its outbound route, and replay cannot move routing
 * backwards because the store compares the transport capture timestamp.
 */
export async function submitRememberedChannelInput(input: {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
  identityId?: string;
  enqueueOptions?: ThreadEnqueueOptions;
  mode?: ThreadWakeMode;
  payload: ThreadInputPayload;
  route: RememberedRoute;
  sessionId: string;
}): Promise<SessionInputDeliveryResult> {
  return submitDurableRuntimeRequestInput({
    sessionId: input.sessionId,
    coordinator: input.coordinator,
    ...(input.mode === undefined ? {} : {mode: input.mode}),
    enqueueOptions: {
      ...input.enqueueOptions,
      rememberedRoute: {
        ...(input.identityId === undefined ? {} : {identityId: input.identityId}),
        route: input.route,
      },
    },
    payload: input.payload,
  });
}
