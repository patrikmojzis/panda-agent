import * as React from "react"
import { Outlet, useLocation } from "react-router-dom"

import { ControlSidebar } from "@/components/layout/control-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"

const ControlFormSheets = React.lazy(() =>
  import("@/features/control/forms/control-form-sheets").then((module) => ({
    default: module.ControlFormSheets,
  }))
)

const GlobalSearch = React.lazy(() => import("@/components/layout/global-search"))

export function AppShell() {
  const location = useLocation()

  return (
    <SidebarProvider>
      <CloseMobileSidebarOnNavigation
        routeKey={`${location.pathname}${location.search}`}
      />
      <ControlSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <SidebarTrigger />
          <React.Suspense fallback={<GlobalSearchFallback />}>
            <GlobalSearch />
          </React.Suspense>
        </header>
        <main className="min-w-0 p-3 md:p-5">
          <Outlet />
        </main>
      </SidebarInset>
      <React.Suspense fallback={null}>
        <ControlFormSheets />
      </React.Suspense>
    </SidebarProvider>
  )
}

function CloseMobileSidebarOnNavigation({ routeKey }: { routeKey: string }) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  const previousRouteKey = React.useRef(routeKey)

  React.useEffect(() => {
    if (previousRouteKey.current === routeKey) return
    previousRouteKey.current = routeKey
    if (isMobile && openMobile) setOpenMobile(false)
  }, [isMobile, openMobile, routeKey, setOpenMobile])

  return null
}

function GlobalSearchFallback() {
  return (
    <div
      aria-hidden="true"
      className="hidden h-9 min-w-44 flex-1 items-center rounded-none border bg-muted/30 px-3 text-sm text-muted-foreground sm:flex sm:max-w-md"
    >
      Search agents, sessions, and resources
    </div>
  )
}
