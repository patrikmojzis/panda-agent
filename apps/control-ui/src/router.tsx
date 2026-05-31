import {createRootRoute, createRoute, createRouter, redirect} from "@tanstack/react-router";
import {Shell} from "./routes/shell";
import {LoginPage} from "./routes/login";
import {OverviewPage} from "./features/control/overview";
import {AgentsPage} from "./features/control/agents";
import {CredentialsPage} from "./features/control/credentials";
import {AuditEventsPage} from "./features/control/audit";
import {SessionBriefingLookupPage, SessionBriefingPage} from "./features/control/session-briefing";
import {SessionHeartbeatLookupPage, SessionHeartbeatPage} from "./features/control/session-heartbeat";
import {controlApi, ControlApiError} from "./lib/api";

const rootRoute = createRootRoute();
const loginRoute = createRoute({getParentRoute: () => rootRoute, path: "/login", component: LoginPage});
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: Shell,
  beforeLoad: async () => {
    try {
      await controlApi.me();
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 401) throw redirect({to: "/login"});
      throw error;
    }
  },
});
const indexRoute = createRoute({getParentRoute: () => appRoute, path: "/", component: OverviewPage});
const agentsRoute = createRoute({getParentRoute: () => appRoute, path: "/agents", component: AgentsPage});
const credentialsRoute = createRoute({getParentRoute: () => appRoute, path: "/credentials", component: CredentialsPage});
const auditEventsRoute = createRoute({getParentRoute: () => appRoute, path: "/audit", component: AuditEventsPage});
const sessionBriefingLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/briefing", component: SessionBriefingLookupPage});
const sessionBriefingRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/briefing", component: SessionBriefingPage});
const sessionHeartbeatLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/heartbeat", component: SessionHeartbeatLookupPage});
const sessionHeartbeatRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/heartbeat", component: SessionHeartbeatPage});

const routeTree = rootRoute.addChildren([loginRoute, appRoute.addChildren([indexRoute, agentsRoute, credentialsRoute, auditEventsRoute, sessionBriefingLookupRoute, sessionBriefingRoute, sessionHeartbeatLookupRoute, sessionHeartbeatRoute])]);
export const router = createRouter({routeTree});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
