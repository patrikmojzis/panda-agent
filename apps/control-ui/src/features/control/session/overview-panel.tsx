import { Link } from "react-router-dom"
import {
  Activity,
  ArrowRightIcon,
  Link2,
  Pencil,
  Plus,
  SlidersHorizontal,
} from "lucide-react"

import { sessionTabPath } from "@/app/control-routes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  useAgentBindings,
  useA2ABindings,
  useBriefing,
  useHeartbeat,
  useRuntimeActivity,
  useScheduledTasks,
  useSessionDetail,
  useScopedGatewayEvents,
  useWatches,
} from "@/features/control/api/queries"
import { StatusBadge } from "@/features/control/control-display"
import {
  DetailField,
  DetailPanel,
  DetailsGrid,
  TableError,
} from "@/features/control/detail-primitives"
import { formatDate } from "@/features/control/formatting"
import {
  briefingDefaults,
  briefingToFormValues,
  heartbeatConfigToFormValues,
  runtimeConfigToFormValues,
} from "@/features/control/forms/form-values"
import {
  useBindingSheet,
  useA2ABindingSheet,
  useBriefingSheet,
  useHeartbeatConfigSheet,
  useRuntimeConfigSheet,
} from "@/features/control/forms/use-control-form-sheets"

export function SessionOverviewPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const bindingSheet = useBindingSheet()
  const a2aBindingSheet = useA2ABindingSheet()
  const briefingSheet = useBriefingSheet()
  const heartbeatConfigSheet = useHeartbeatConfigSheet()
  const runtimeConfigSheet = useRuntimeConfigSheet()
  const session = useSessionDetail(agentKey, sessionId)
  const briefing = useBriefing(agentKey, sessionId)
  const heartbeat = useHeartbeat(agentKey, sessionId)
  const runtime = useRuntimeActivity(agentKey, sessionId, {
    page: 1,
    per_page: 1,
    sort_by: "startedAt",
    sort_direction: "desc",
  })
  const automations = useScheduledTasks(agentKey, sessionId, {
    page: 1,
    per_page: 25,
    sort_by: "nextFireAt",
    sort_direction: "asc",
  })
  const watches = useWatches(agentKey, sessionId, {
    page: 1,
    per_page: 25,
    sort_by: "nextPollAt",
    sort_direction: "asc",
  })
  const bindings = useAgentBindings(agentKey, {
    page: 1,
    per_page: 1,
    session_id: sessionId,
  })
  const a2aBindings = useA2ABindings(agentKey, sessionId, {
    page: 1,
    per_page: 1,
  })
  const gatewayEvents = useScopedGatewayEvents(agentKey, sessionId, {
    page: 1,
    per_page: 1,
    sort_by: "createdAt",
    sort_direction: "desc",
  })
  const detail = session.data?.session
  const briefingRecord = briefing.data?.briefing
  const presence = heartbeat.data?.heartbeat
  const loading = session.isLoading || heartbeat.isLoading
  const briefingIsSet = Boolean(briefingRecord?.wasSet || detail?.briefingSet)
  const runtimeSummary = runtime.data?.runtimeActivity.summary
  const automationRecord = automations.data?.scheduledTasks
  const automationRows = automationRecord?.data ?? automationRecord?.tasks ?? []
  const watchRecord = watches.data?.watches
  const watchRows = watchRecord?.data ?? watchRecord?.watches ?? []
  const watchTotal = watchRecord?.meta?.total ?? watchRows.length
  const automationTotal = automationRecord?.meta?.total ?? automationRows.length
  const failedAutomationRuns = automationRows.reduce(
    (count, task) =>
      count + task.recentRuns.filter((run) => run.status === "failed").length,
    0
  )
  if (session.error) return <TableError error={session.error} />

  function openBriefingSheet() {
    briefingSheet.setOpen(true, {
      context: { agentKey, sessionId },
      defaultData: briefingRecord
        ? briefingToFormValues(briefingRecord)
        : briefingDefaults,
      entity: briefingRecord,
    })
  }

  return (
    <div className="grid gap-4">
      {heartbeat.error ? <TableError error={heartbeat.error} /> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <DetailPanel
          title="Runtime Health"
          action={
            <PanelActions>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!detail}
                onClick={() => {
                  if (!detail) return
                  runtimeConfigSheet.setOpen(true, {
                    context: { agentKey, sessionId },
                    defaultData: runtimeConfigToFormValues(detail),
                    entity: detail,
                  })
                }}
              >
                <SlidersHorizontal className="size-3.5" />
                Defaults
              </Button>
              <OverviewLink
                to={sessionTabPath(agentKey, sessionId, "runtime")}
                label="Runtime"
              />
            </PanelActions>
          }
        >
          <DetailsGrid placement="main" className="xl:grid-cols-3">
            <DetailField
              loading={runtime.isLoading}
              label="Current"
              value={
                <StatusBadge
                  status={(runtimeSummary?.running ?? 0) > 0 ? "running" : "idle"}
                />
              }
            />
            <DetailField
              loading={runtime.isLoading}
              label="Failed runs"
              value={emphasizedCount(runtimeSummary?.failed)}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Latest run"
              value={
                runtimeSummary?.latestRun ? (
                  <StatusBadge status={runtimeSummary.latestRun.status} />
                ) : (
                  "-"
                )
              }
            />
            <DetailField
              loading={runtime.isLoading}
              label="Latest started"
              value={formatDate(runtimeSummary?.latestStartedAt)}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Pending wake"
              value={formatDate(detail?.runtime.pendingWakeAt)}
            />
            <DetailField
              loading={runtime.isLoading}
              label="Abort requests"
              value={(runtimeSummary?.abortRequests ?? 0).toLocaleString()}
            />
          </DetailsGrid>
        </DetailPanel>
        <DetailPanel
          title="Wake Sources"
          action={
            <PanelActions>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!presence}
                onClick={() => {
                  if (!presence) return
                  heartbeatConfigSheet.setOpen(true, {
                    context: { agentKey, sessionId },
                    defaultData: heartbeatConfigToFormValues(presence),
                    entity: presence,
                  })
                }}
              >
                <Activity className="size-3.5" />
                Policy
              </Button>
              <OverviewLink
                to={sessionTabPath(agentKey, sessionId, "automations")}
                label="Automations"
              />
            </PanelActions>
          }
        >
          <DetailsGrid placement="main" className="xl:grid-cols-3">
            <DetailField
              loading={loading}
              label="Wake mode"
              value={
                <Badge variant={presence?.enabled ? "outline" : "secondary"}>
                  {presence?.enabled ? "Automatic" : "Manual"}
                </Badge>
              }
            />
            <DetailField
              loading={heartbeat.isLoading}
              label="Next wake"
              value={formatDate(presence?.nextFireAt)}
            />
            <DetailField
              loading={automations.isLoading}
              label="Automations"
              value={automationTotal.toLocaleString()}
            />
            <DetailField
              loading={automations.isLoading}
              label="Page failed runs"
              value={emphasizedCount(failedAutomationRuns)}
            />
            <DetailField
              loading={watches.isLoading}
              label="Watches"
              value={watchTotal.toLocaleString()}
            />
            <DetailField
              loading={watches.isLoading}
              label="Next watch"
              value={formatDate(nextWatchPollAt(watchRows))}
            />
          </DetailsGrid>
        </DetailPanel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <DetailPanel
          title="Connections"
          action={
            <PanelActions>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  bindingSheet.setOpen(true, {
                    context: { agentKey, sessionId },
                    defaultData: { sessionId },
                  })
                }
              >
                <Link2 className="size-3.5" />
                Bind
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  a2aBindingSheet.setOpen(true, {
                    context: { agentKey, sessionId },
                  })
                }
              >
                <Link2 className="size-3.5" />
                A2A
              </Button>
              <OverviewLink
                to={sessionTabPath(agentKey, sessionId, "bindings")}
                label="Channels"
              />
              <OverviewLink
                to={sessionTabPath(agentKey, sessionId, "a2a")}
                label="A2A"
              />
            </PanelActions>
          }
        >
          <DetailsGrid placement="main" className="xl:grid-cols-3">
            <DetailField
              loading={bindings.isLoading}
              label="Channel bindings"
              value={(bindings.data?.meta.total ?? 0).toLocaleString()}
            />
            <DetailField
              loading={a2aBindings.isLoading}
              label="A2A links"
              value={(a2aBindings.data?.meta.total ?? 0).toLocaleString()}
            />
            <DetailField
              loading={gatewayEvents.isLoading}
              label="Gateway events"
              value={(gatewayEvents.data?.meta.total ?? 0).toLocaleString()}
            />
            <DetailField
              loading={gatewayEvents.isLoading}
              label="Latest gateway event"
              value={formatDate(gatewayEvents.data?.data[0]?.createdAt)}
            />
          </DetailsGrid>
        </DetailPanel>
        <DetailPanel
          title="Configuration"
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={briefing.isLoading}
              onClick={openBriefingSheet}
            >
              {briefingIsSet ? (
                <Pencil className="size-3.5" />
              ) : (
                <Plus className="size-3.5" />
              )}
              {briefingIsSet ? "Edit" : "Add"}
            </Button>
          }
        >
          <DetailsGrid placement="main" className="xl:grid-cols-3">
            <DetailField
              loading={loading || briefing.isLoading}
              label="Briefing"
              value={
                briefingIsSet ? (
                  <StatusBadge status="set" />
                ) : (
                  <StatusBadge status="empty" />
                )
              }
            />
            <DetailField
              loading={loading}
              label="Runtime model"
              value={detail?.runtime.model ?? "default"}
            />
            <DetailField
              loading={loading}
              label="Thinking"
              value={
                detail?.runtime.thinking ??
                (detail?.runtime.thinkingConfigured ? "off" : "default")
              }
            />
          </DetailsGrid>
        </DetailPanel>
      </div>
    </div>
  )
}

function PanelActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-1">{children}</div>
}

function OverviewLink({ to, label }: { to: string; label: string }) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link to={to}>
        {label}
        <ArrowRightIcon className="size-3.5" />
      </Link>
    </Button>
  )
}

function emphasizedCount(value?: number | null) {
  const count = value ?? 0
  if (count > 0) {
    return <span className="text-destructive">{count.toLocaleString()}</span>
  }
  return "0"
}

function nextWatchPollAt(watches: Array<{ nextPollAt: string | null }>) {
  return watches
    .map((watch) => watch.nextPollAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0]
}
