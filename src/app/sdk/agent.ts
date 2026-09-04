import {Thread as CoreThread, type ThreadOptions as CoreThreadOptions} from "../../kernel/agent/thread.js";
import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";

export * from "../../kernel/agent/index.js";

export type ThreadOptions<TContext = unknown, TOutput = unknown> =
  Omit<CoreThreadOptions<TContext, TOutput>, "model"> & {model?: string};

/** Package convenience constructor; the inner loop always receives an explicit model. */
export class Thread<TContext = unknown, TOutput = unknown> extends CoreThread<TContext, TOutput> {
  constructor(options: ThreadOptions<TContext, TOutput>) {
    super({...options, model: options.model ?? resolveDefaultAgentModelSelector()});
  }
}
