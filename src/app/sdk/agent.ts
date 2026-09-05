import {Thread as CoreThread, type ThreadOptions as CoreThreadOptions} from "../../kernel/agent/thread.js";
import {withDefaultModel} from "./model-defaults.js";

export * from "../../kernel/agent/index.js";

export type ThreadOptions<TContext = unknown, TOutput = unknown> =
  Omit<CoreThreadOptions<TContext, TOutput>, "model"> & {model?: string};

export type Thread<TContext = unknown, TOutput = unknown> = CoreThread<TContext, TOutput>;

/** Adapts construction while sharing the core prototype, including its constructor property. */
export const Thread = new Proxy(CoreThread, {
  construct(target, [options]: [ThreadOptions], newTarget) {
    return Reflect.construct(target, [withDefaultModel(options)], newTarget);
  },
}) as typeof CoreThread & {
  new<TContext = unknown, TOutput = unknown>(options: ThreadOptions<TContext, TOutput>): Thread<TContext, TOutput>;
};
