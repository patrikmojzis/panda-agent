import { useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/common/shared/page-layout"
import { ModelCallsPanel } from "@/features/control/model-calls/model-calls-panel"

function ModelCallsPage() {
  const [searchParams] = useSearchParams()

  return (
    <div className="min-w-0">
      <PageHeader
        title="Model Calls"
        eyebrow="Control"
      />
      <ModelCallsPanel
        initialFilters={{
          agentKey: searchParams.get("agent_key") ?? "",
          mode: searchParams.get("mode") ?? "",
          runId: searchParams.get("run_id") ?? "",
          sessionId: searchParams.get("session_id") ?? "",
          status: searchParams.get("status") ?? "",
        }}
      />
    </div>
  )
}

export { ModelCallsPage }
export default ModelCallsPage
