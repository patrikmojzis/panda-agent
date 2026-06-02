import { useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/common/shared/page-layout"
import { AgentsTable } from "@/features/control/agent/agents-table"

function AgentsPage() {
  const [searchParams] = useSearchParams()
  return (
    <div>
      <PageHeader title="Agents" eyebrow="Control" />
      <AgentsTable initialSearch={searchParams.get("search") ?? ""} />
    </div>
  )
}

export { AgentsPage }
export default AgentsPage
