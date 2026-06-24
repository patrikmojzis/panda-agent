import * as React from "react"
import { useParams, useSearchParams } from "react-router-dom"

import { useModelCallTrace, useModelCallTraces } from "@/features/control/api/queries"
import { TableError } from "@/features/control/detail-primitives"
import { ModelCallTraceDebugger } from "@/features/control/model-calls/model-call-detail-content"
import type { ModelCallTraceDetail, TableParams } from "@/lib/api"

function ModelCallDetailPage() {
  const { traceId } = useParams()
  const [searchParams] = useSearchParams()
  const trace = useModelCallTrace(traceId ?? "", { enabled: Boolean(traceId) })
  const data = trace.data?.modelCallTrace
  const relatedParams = React.useMemo(() => relatedModelCallParams(data), [data])
  const relatedTraces = useModelCallTraces(relatedParams, {
    enabled: Boolean(data && (data.runId || data.sessionId || data.agentKey)),
    staleTime: 10_000,
  })
  const compareTraceId = searchParams.get("compare") ?? ""
  const compareTrace = useModelCallTrace(compareTraceId, {
    enabled: Boolean(compareTraceId && compareTraceId !== traceId),
    staleTime: 10_000,
  })

  return (
    <div className="grid min-w-0 max-w-full gap-4">
      {trace.error && !data ? (
        <TableError error={trace.error} />
      ) : data ? (
        <ModelCallTraceDebugger
          trace={data}
          relatedTraces={relatedTraces.data?.modelCallTraces.data ?? []}
          compareTrace={compareTrace.data?.modelCallTrace ?? null}
          comparing={compareTrace.isFetching}
          refreshing={trace.isFetching}
          onRefresh={() => void trace.refetch()}
        />
      ) : (
        <LoadingState />
      )}
    </div>
  )
}

function relatedModelCallParams(trace?: ModelCallTraceDetail): TableParams {
  if (!trace) return { per_page: 100 }
  const params: TableParams = { per_page: 100 }
  if (trace.runId) params.run_id = trace.runId
  if (!trace.runId && trace.sessionId) params.session_id = trace.sessionId
  if (trace.agentKey) params.agent_key = trace.agentKey
  return params
}

function LoadingState() {
  return (
    <div className="grid min-w-0 gap-4">
      <div className="border p-6 text-sm text-muted-foreground" role="status">
        Loading sanitized model call trace…
      </div>
    </div>
  )
}

export { ModelCallDetailPage }
export default ModelCallDetailPage
