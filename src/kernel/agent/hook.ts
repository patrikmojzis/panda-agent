import type {AssistantMessage} from "@mariozechner/pi-ai";

import type {RunContext} from "./run-context.js";

export abstract class Hook<TContext = unknown> {
  async onStart(_runContext: RunContext<TContext>): Promise<void> {}

  async onEnd(_runContext: RunContext<TContext>, _output: AssistantMessage): Promise<void> {}
}
