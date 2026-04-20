/**
 * Returns true when `error` matches Panda's standard "unknown agent" message
 * for the provided `agentKey`.
 */
export function isMissingAgentError(error: unknown, agentKey: string): boolean {
  return error instanceof Error
    && error.message === `Unknown agent ${agentKey}. Create it with \`panda agent create ${agentKey}\`.`;
}
