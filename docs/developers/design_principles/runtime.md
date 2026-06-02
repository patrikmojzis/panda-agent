# Runtime

Most tool errors should be recoverable.

If the agent supplied bad input or chose an invalid option, return a tool error
instead of failing the whole run.
