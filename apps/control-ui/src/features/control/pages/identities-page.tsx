import { useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/common/shared/page-layout"
import { IdentitiesTable } from "@/features/control/identity/identities-table"

function IdentitiesPage() {
  const [searchParams] = useSearchParams()
  return (
    <div>
      <PageHeader
        title="Identities"
        eyebrow="Control"
      />
      <IdentitiesTable initialSearch={searchParams.get("search") ?? ""} />
    </div>
  )
}

export { IdentitiesPage }
export default IdentitiesPage
