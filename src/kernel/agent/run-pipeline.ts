import type {AssistantMessage} from "@mariozechner/pi-ai";

import type {Thread} from "./thread.js";

export abstract class RunPipeline<TContext = unknown> {
  async preflight(_thread: Thread<TContext>): Promise<void> {}

  async postflight(_thread: Thread<TContext>, _response: AssistantMessage): Promise<void> {}
}
