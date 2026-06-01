import {createRootRoute, createRoute, createRouter, redirect} from "@tanstack/react-router";
import {Shell} from "./routes/shell";
import {LoginPage} from "./routes/login";
import {OverviewPage} from "./features/control/overview";
import {AgentsPage} from "./features/control/agents";
import {CredentialsPage} from "./features/control/credentials";
import {AuditEventsPage} from "./features/control/audit";
import {SessionBriefingLookupPage, SessionBriefingPage} from "./features/control/session-briefing";
import {SessionHeartbeatLookupPage, SessionHeartbeatPage} from "./features/control/session-heartbeat";
import {SessionTodoLookupPage, SessionTodoPage} from "./features/control/session-todos";
import {ScheduledTasksLookupPage, ScheduledTasksPage} from "./features/control/scheduled-tasks";
import {WatchesLookupPage, WatchesPage} from "./features/control/watches";
import {RuntimeActivityLookupPage, RuntimeActivityPage} from "./features/control/runtime-activity";
import {ConnectorAccountsLookupPage, ConnectorAccountsPage} from "./features/control/connectors";
import {CreateSessionPage} from "./features/control/create-session";
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
const createSessionRoute = createRoute({getParentRoute: () => appRoute, path: "/sessions/new", component: CreateSessionPage});
const credentialsRoute = createRoute({getParentRoute: () => appRoute, path: "/credentials", component: CredentialsPage});
const auditEventsRoute = createRoute({getParentRoute: () => appRoute, path: "/audit", component: AuditEventsPage});
const sessionBriefingLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/briefing", component: SessionBriefingLookupPage});
const sessionBriefingRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/briefing", component: SessionBriefingPage});
const sessionHeartbeatLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/heartbeat", component: SessionHeartbeatLookupPage});
const sessionHeartbeatRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/heartbeat", component: SessionHeartbeatPage});
const sessionTodoLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/todos", component: SessionTodoLookupPage});
const sessionTodoRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/todos", component: SessionTodoPage});
const watchesLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/watches", component: WatchesLookupPage});
const watchesRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/watches", component: WatchesPage});
const connectorAccountsLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/connectors", component: ConnectorAccountsLookupPage});
const connectorAccountsRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/connectors", component: ConnectorAccountsPage});
const runtimeActivityLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/runtime-activity", component: RuntimeActivityLookupPage});
const runtimeActivityRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/runtime-activity", component: RuntimeActivityPage});
const scheduledTasksLookupRoute = createRoute({getParentRoute: () => appRoute, path: "/scheduled-tasks", component: ScheduledTasksLookupPage});
const scheduledTasksRoute = createRoute({getParentRoute: () => appRoute, path: "/agents/$agentKey/sessions/$sessionId/scheduled-tasks", component: ScheduledTasksPage});

const routeTree = rootRoute.addChildren([loginRoute, appRoute.addChildren([indexRoute, agentsRoute, createSessionRoute, credentialsRoute, auditEventsRoute, sessionBriefingLookupRoute, sessionBriefingRoute, sessionHeartbeatLookupRoute, sessionHeartbeatRoute, sessionTodoLookupRoute, sessionTodoRoute, watchesLookupRoute, watchesRoute, connectorAccountsLookupRoute, connectorAccountsRoute, runtimeActivityLookupRoute, runtimeActivityRoute, scheduledTasksLookupRoute, scheduledTasksRoute])]);
export const router = createRouter({routeTree});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
