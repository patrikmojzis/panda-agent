import { lazy, type ElementType } from "react"

export const LoginPage = lazy(() => import("@/features/control/pages/login-page"))

const HomePage = lazy(() => import("@/features/control/pages/home-page"))
const AgentsPage = lazy(() => import("@/features/control/pages/agents-page"))
const IdentitiesPage = lazy(() => import("@/features/control/pages/identities-page"))
const AgentPage = lazy(() => import("@/features/control/pages/agent-page"))
const SessionPage = lazy(() => import("@/features/control/pages/session-page"))

export type ControlPageRoute = {
  component: ElementType
  index?: boolean
  path?: string
}

export const CONTROL_PAGE_ROUTES: ControlPageRoute[] = [
  { index: true, component: HomePage },
  { path: "agents", component: AgentsPage },
  { path: "identities", component: IdentitiesPage },
  { path: "agents/:agentKey", component: AgentPage },
  { path: "agents/:agentKey/sessions/:sessionId", component: SessionPage },
]
