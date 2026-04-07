import type { RunContext } from "./run-context.js";
import type { ResponseLike } from "./types.js";

export abstract class Hook<TContext = unknown> {
  async onStart(_runContext: RunContext<TContext>): Promise<void> {}

  async onEnd(_runContext: RunContext<TContext>, _output: ResponseLike): Promise<void> {}
}
