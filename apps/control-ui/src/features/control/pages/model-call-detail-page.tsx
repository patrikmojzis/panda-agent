import { useParams } from "react-router-dom"

import { useModelCallTrace } from "@/features/control/api/queries"
import { TableError } from "@/features/control/detail-primitives"
import { ModelCallTraceDebugger } from "@/features/control/model-calls/model-call-detail-content"

function ModelCallDetailPage() {
  const { traceId } = useParams()
  const trace = useModelCallTrace(traceId ?? "", { enabled: Boolean(traceId) })
  const data = trace.data?.modelCallTrace

  return (
    <div className="grid min-w-0 max-w-full gap-4">
      {trace.error && !data ? (
        <TableError error={trace.error} />
      ) : data ? (
        <ModelCallTraceDebugger
          trace={data}
          refreshing={trace.isFetching}
          onRefresh={() => void trace.refetch()}
        />
      ) : (
        <LoadingState />
      )}
    </div>
  )
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
