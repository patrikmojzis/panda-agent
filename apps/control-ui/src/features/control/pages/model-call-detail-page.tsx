import { Link, useParams } from "react-router-dom"
import { ArrowLeft, RefreshCw } from "lucide-react"

import { PageHeader } from "@/components/common/shared/page-layout"
import { Button } from "@/components/ui/button"
import { useModelCallTrace } from "@/features/control/api/queries"
import { TableError } from "@/features/control/detail-primitives"
import {
  TraceContextPanel,
  TraceDetailSections,
  TraceOverview,
} from "@/features/control/model-calls/model-call-detail-content"
import { humanize, short } from "@/features/control/control-display"

function ModelCallDetailPage() {
  const { traceId } = useParams()
  const trace = useModelCallTrace(traceId ?? "", { enabled: Boolean(traceId) })
  const data = trace.data?.modelCallTrace

  return (
    <div className="grid min-w-0 max-w-full gap-4">
      <PageHeader
        title="Model Call"
        breadcrumbs={[
          { label: "Model Calls", to: "/model-calls" },
          { label: traceId ? short(traceId) : "Trace" },
        ]}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/model-calls">
                <ArrowLeft className="size-4" />
                Back to model calls
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void trace.refetch()}
              disabled={trace.isFetching || !traceId}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          </>
        }
      />
      {data ? (
        <div className="text-sm text-muted-foreground">
          {short(data.id)} · {data.provider}/{data.model} · {humanize(data.status)}
        </div>
      ) : null}
      {trace.error && !data ? (
        <TableError error={trace.error} />
      ) : data ? (
        <div className="grid min-w-0 max-w-full gap-4">
          <TraceOverview trace={data} />
          <TraceContextPanel trace={data} />
          <TraceDetailSections trace={data} />
        </div>
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
