import type { Thread } from "./thread.js";
import type { ResponseLike } from "./types.js";

export abstract class RunPipeline<TContext = unknown> {
  async preflight(_thread: Thread<TContext>): Promise<void> {}

  async postflight(_thread: Thread<TContext>, _response: ResponseLike): Promise<void> {}
}
