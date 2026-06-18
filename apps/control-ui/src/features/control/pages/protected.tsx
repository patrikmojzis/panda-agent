import type { ReactNode } from "react"
import { Navigate } from "react-router-dom"

import { ScreenSkeleton } from "@/components/common/shared/screen-skeleton"
import { useAuth } from "@/lib/auth"

function Protected({ children }: { children: ReactNode }) {
  const auth = useAuth()
  if (auth.isLoading) return <ScreenSkeleton />
  if (!auth.session) return <Navigate to="/login" replace />
  return children
}

function AdminOnly({ children }: { children: ReactNode }) {
  const auth = useAuth()
  if (auth.isLoading) return <ScreenSkeleton />
  if (!auth.session) return <Navigate to="/login" replace />
  if (auth.session.role !== "admin") return <Navigate to="/" replace />
  return children
}

export { AdminOnly, Protected }
