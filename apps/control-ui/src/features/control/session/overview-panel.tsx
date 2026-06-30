import { Link } from "react-router-dom"
import {
  Activity,
  ArrowRightIcon,
  Link2,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"

import { sessionTabPath } from "@/app/control-routes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import {
  useAgentBindings,
  useA2ABindings,
  useHeartbeat,
  useRuntimeActivity,
  useScheduledTasks,
  useSessionDetail,
  useSessionPrompts,
  useSessionTargets,
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
  heartbeatConfigToFormValues,
  runtimeConfigToFormValues,
} from "@/features/control/forms/form-values"
import {
  useBindingSheet,
  useA2ABindingSheet,
  useHeartbeatConfigSheet,
  useRuntimeConfigSheet,
} from "@/features/control/forms/use-control-form-sheets"
import { controlApi } from "@/lib/api"
import { useAuth } from "@/lib/auth"

function targetHealthLabel(health: string) {
  if (health === "not_applicable") return "Not applicable"
  return health.replace(/[_-]+/g, " ")
}

function targetHealthVariant(health: string): "outline" | "destructive" | "secondary" {
  if (health === "reachable") return "outline"
  if (health === "unreachable") return "destructive"
  return "secondary"
}

export function SessionOverviewPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const auth = useAuth()
  const bindingSheet = useBindingSheet()
  const a2aBindingSheet = useA2ABindingSheet()
  const heartbeatConfigSheet = useHeartbeatConfigSheet()
  const runtimeConfigSheet = useRuntimeConfigSheet()
  const session = useSessionDetail(agentKey, sessionId)
  const promptBundle = useSessionPrompts(agentKey, sessionId)
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
  const targets = useSessionTargets(agentKey, sessionId)
  const bindTarget = useToastMutation({
    mutationFn: (body: Record<string, unknown>) =>
      controlApi.bindSessionTarget(agentKey, sessionId, body, auth.csrfToken),
    success: "Execution target bound",
    invalidate: controlKeys.sessions.targets(agentKey, sessionId),
  })
  const detachTarget = useToastMutation({
    mutationFn: (alias: string) =>
      controlApi.deleteSessionTarget(agentKey, sessionId, alias, auth.csrfToken),
    success: "Execution target detached",
    invalidate: controlKeys.sessions.targets(agentKey, sessionId),
  })
  const detail = session.data?.session
  const presence = heartbeat.data?.heartbeat
  const loading = session.isLoading || heartbeat.isLoading
  const promptSetCount = promptBundle.data?.prompts.filter((prompt) => prompt.wasSet && prompt.content.trim()).length
    ?? (detail?.briefingSet ? 1 : 0)
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

  function openBindTarget() {
    const alias = window.prompt("Target alias, for example vps")?.trim()
    if (!alias) return
    const runnerUrl = window.prompt("Runner base URL, for example http://runner:8080")?.trim()
    if (!runnerUrl) return
    const runnerCwd = window.prompt("Initial runner cwd (optional)")?.trim()
    const allowTools = window.prompt("Allowed tools CSV (required, e.g. bash,read_file,glob_files,grep_files)")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (!allowTools?.length) return
    const makeDefault = window.confirm("Make this the default execution target for this session?")
    bindTarget.mutateAsync({
      alias,
      runnerUrl,
      ...(runnerCwd ? { runnerCwd } : {}),
      allowTools,
      ...(makeDefault ? { default: true } : {}),
    })
  }

  return (
    <div className="grid gap-4">
      {heartbeat.error ? <TableError error={heartbeat.error} /> : null}
      {targets.error ? <TableError error={targets.error} /> : null}
      <div className="grid gap-4 xl:grid-cols-3">
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
        <DetailPanel
          title="Execution Targets"
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={bindTarget.isPending}
              onClick={openBindTarget}
            >
              <Plus className="size-3.5" />
              Bind target
            </Button>
          }
        >
          <DetailsGrid placement="main" className="xl:grid-cols-1">
            {targets.isLoading && !targets.data ? (
              <DetailField loading label="Targets" value="" />
            ) : null}
            {(targets.data?.targets ?? []).map((target) => (
              <DetailField
                key={target.alias}
                label={target.label}
                value={
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant="outline">{target.alias}</Badge>
                    <StatusBadge status={target.kind} />
                    <StatusBadge status={target.state} />
                    <Badge variant={targetHealthVariant(target.health)}>
                      {targetHealthLabel(target.health)}
                    </Badge>
                    {target.isDefaultBinding ? (
                      <Badge variant="secondary">Default binding</Badge>
                    ) : null}
                    {target.alias !== "default" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={detachTarget.isPending}
                        onClick={() => detachTarget.mutateAsync(target.alias)}
                      >
                        <Trash2 className="size-3.5" />
                        Detach
                      </Button>
                    ) : null}
                  </div>
                }
              />
            ))}
            {!targets.isLoading && (targets.data?.targets ?? []).length === 0 ? (
              <DetailField label="Targets" value="-" />
            ) : null}
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
              asChild
              variant="ghost"
              size="sm"
            >
              <Link to={sessionTabPath(agentKey, sessionId, "briefing")}>
                <ArrowRightIcon className="size-3.5" />
                Open
              </Link>
            </Button>
          }
        >
          <DetailsGrid placement="main" className="xl:grid-cols-3">
            <DetailField
              loading={loading || promptBundle.isLoading}
              label="Prompts"
              value={`${promptSetCount}/3 set`}
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
