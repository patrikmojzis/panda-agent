import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { controlKeys } from "@/features/control/api/query-key-factory"
import type { AgentSheetContext } from "@/features/control/forms/use-control-form-sheets"

export function requireContext(context?: AgentSheetContext) {
  if (!context) throw new Error("Control form context is missing.")
  return context
}

export function formError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "Control write failed")
}

export function useInvalidateAgent(agentKey?: string) {
  const queryClient = useQueryClient()
  return React.useCallback(
    async (queryKey: readonly unknown[]) => {
      await Promise.all([
        agentKey
          ? queryClient.invalidateQueries({
              queryKey: controlKeys.agents.detail(agentKey),
            })
          : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey }),
      ])
    },
    [agentKey, queryClient]
  )
}

export function agentCacheKey(agentKey?: string) {
  return agentKey ? controlKeys.agents.detail(agentKey) : controlKeys.all
}

export function mergedValues<T extends object>(
  defaults: T,
  overrides?: Partial<T>
): T {
  return { ...defaults, ...overrides }
}
