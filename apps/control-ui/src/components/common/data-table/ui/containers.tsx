import type * as React from "react"

function DataTableContainer({ children }: { children: React.ReactNode }) {
  return <div className="relative min-w-0 overflow-hidden rounded-md border">{children}</div>
}

export { DataTableContainer }
