import * as React from "react"
import { Route, Routes } from "react-router-dom"

import {
  CONTROL_PAGE_ROUTES,
  type ControlPageRoute,
  LoginPage,
} from "@/app/control-page-routes"
import { ScreenSkeleton } from "@/components/common/shared/screen-skeleton"
import { AppHead } from "@/components/layout/app-head"
import { AppShell } from "@/components/layout/app-shell"
import { AdminOnly, Protected } from "@/features/control/pages/protected"

function renderRouteElement(route: ControlPageRoute) {
  const Page = route.component
  const page = <Page />
  return route.adminOnly ? <AdminOnly>{page}</AdminOnly> : page
}

function App() {
  return (
    <>
      <AppHead />
      <React.Suspense fallback={<ScreenSkeleton />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <Protected>
                <AppShell />
              </Protected>
            }
          >
            {CONTROL_PAGE_ROUTES.map((route) =>
              route.index ? (
                <Route key="index" index element={renderRouteElement(route)} />
              ) : (
                <Route
                  key={route.path}
                  path={route.path}
                  element={renderRouteElement(route)}
                />
              )
            )}
          </Route>
        </Routes>
      </React.Suspense>
    </>
  )
}

export default App
