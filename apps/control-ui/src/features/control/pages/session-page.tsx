import * as React from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { Pencil, RotateCw, SlidersHorizontal } from "lucide-react"

import {
  DetailPageContent,
  PageHeader,
  type DetailContentTab,
} from "@/components/common/shared/page-layout"
import { RowActionsMenu } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DEFAULT_SESSION_TAB,
  SESSION_RESOURCE_TABS,
  agentPath,
} from "@/app/control-routes"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import { AuditPanel } from "@/features/control/audit/audit-panel"
import { BindingsPanel } from "@/features/control/agent/agent-resource-panels"
import { A2ABindingsPanel } from "@/features/control/session/a2a-panel"
import { short, StatusBadge } from "@/features/control/control-display"
import {
  DetailField,
  DetailPanel,
  DetailSection,
  DetailSectionLabel,
  DetailsGrid,
} from "@/features/control/detail-primitives"
import { formatDate } from "@/features/control/formatting"
import {
  heartbeatConfigToFormValues,
  runtimeConfigToFormValues,
  sessionToFormValues,
} from "@/features/control/forms/form-values"
import {
  useHeartbeatConfigSheet,
  useRuntimeConfigSheet,
  useUpdateSessionSheet,
} from "@/features/control/forms/use-control-form-sheets"
import { GatewayPanel } from "@/features/control/gateway/gateway-panel"
import { RuntimePanel } from "@/features/control/runtime/runtime-panel"
import { AutomationsPanel } from "@/features/control/session/automations-panel"
import { BriefingPanel } from "@/features/control/session/briefing-panel"
import { SessionOverviewPanel } from "@/features/control/session/overview-panel"
import { WatchesPanel } from "@/features/control/session/watches-panel"
import {
  useBriefing,
  useHeartbeat,
  useSessionDetail,
} from "@/features/control/api/queries"
import {
  friendlySessionLabel,
  shortSessionId,
} from "@/features/control/session-labels"
import { controlApi, type SessionDetail } from "@/lib/api"
import { useAuth } from "@/lib/auth"

function SessionPage() {
  const { agentKey = "", sessionId = "" } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get("tab") ?? DEFAULT_SESSION_TAB
  const setTab = React.useCallback(
    (value: string) => setSearchParams({ tab: value }),
    [setSearchParams]
  )
  const session = useSessionDetail(agentKey, sessionId)
  const sessionDetails = session.data?.session
  const pageTitle = friendlySessionLabel(sessionDetails, sessionId)
  const sessionTabs = React.useMemo(
    () => sessionDetailTabs(agentKey, sessionId),
    [agentKey, sessionId]
  )

  return (
    <div>
      <PageHeader
        title={pageTitle}
        breadcrumbs={[
          { label: "Agents", to: "/agents" },
          { label: agentKey, to: agentPath(agentKey) },
          {
            label: `${sessionDetails?.kind ?? "session"} / ${shortSessionId(
              sessionDetails?.id ?? sessionId
            )}`,
          },
        ]}
        actions={
          <SessionHeaderActions
            agentKey={agentKey}
            session={sessionDetails}
            sessionId={sessionId}
          />
        }
      />
      <DetailPageContent
        label="Session sections"
        onValueChange={setTab}
        sidebar={
          <SessionDetailSidebar agentKey={agentKey} sessionId={sessionId} />
        }
        sidebarLabel="Session details"
        tabs={sessionTabs}
        value={tab}
      />
    </div>
  )
}

function sessionDetailTabs(
  agentKey: string,
  sessionId: string
): DetailContentTab[] {
  return SESSION_RESOURCE_TABS.map((tab) => ({
    value: tab.value,
    label: tab.label,
    content: sessionTabContent(agentKey, sessionId, tab.value),
  }))
}

function sessionTabContent(agentKey: string, sessionId: string, value: string) {
  switch (value) {
    case "overview":
      return <SessionOverviewPanel agentKey={agentKey} sessionId={sessionId} />
    case "briefing":
      return <BriefingPanel agentKey={agentKey} sessionId={sessionId} />
    case "bindings":
      return <BindingsPanel agentKey={agentKey} sessionId={sessionId} />
    case "a2a":
      return <A2ABindingsPanel agentKey={agentKey} sessionId={sessionId} />
    case "runtime":
      return <RuntimePanel agentKey={agentKey} sessionId={sessionId} />
    case "automations":
      return <AutomationsPanel agentKey={agentKey} sessionId={sessionId} />
    case "watches":
      return <WatchesPanel agentKey={agentKey} sessionId={sessionId} />
    case "gateway":
      return <GatewayPanel agentKey={agentKey} sessionId={sessionId} />
    case "audit":
      return <AuditPanel agentKey={agentKey} sessionId={sessionId} />
    default:
      return <SessionOverviewPanel agentKey={agentKey} sessionId={sessionId} />
  }
}

function SessionHeaderActions({
  agentKey,
  session,
  sessionId,
}: {
  agentKey: string
  session?: SessionDetail
  sessionId: string
}) {
  const auth = useAuth()
  const updateSessionSheet = useUpdateSessionSheet()
  const runtimeConfigSheet = useRuntimeConfigSheet()
  const heartbeatConfigSheet = useHeartbeatConfigSheet()
  const heartbeat = useHeartbeat(agentKey, sessionId)
  const presence = heartbeat.data?.heartbeat
  const reset = useToastMutation({
    mutationFn: () =>
      controlApi.resetSession(agentKey, sessionId, auth.csrfToken),
    success: "Session reset",
    invalidate: controlKeys.agents.detail(agentKey),
  })

  return (
    <>
      {session ? <Badge variant="outline">{session.kind}</Badge> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!session}
        onClick={() => {
          if (!session) return
          updateSessionSheet.setOpen(true, {
            context: { agentKey, sessionId },
            defaultData: sessionToFormValues(session),
            entity: session,
          })
        }}
      >
        <Pencil className="size-3.5" />
        Edit session
      </Button>
      <RowActionsMenu
        label="Configure"
        triggerLabel="Open session configuration actions"
        actions={[
          {
            disabled: !session,
            icon: <SlidersHorizontal className="size-4" />,
            label: "Runtime defaults",
            onSelect: () => {
              if (!session) return
              runtimeConfigSheet.setOpen(true, {
                context: { agentKey, sessionId },
                defaultData: runtimeConfigToFormValues(session),
                entity: session,
              })
            },
          },
          {
            disabled: !presence,
            icon: <SlidersHorizontal className="size-4" />,
            label: "Wake policy",
            onSelect: () => {
              if (!presence) return
              heartbeatConfigSheet.setOpen(true, {
                context: { agentKey, sessionId },
                defaultData: heartbeatConfigToFormValues(presence),
                entity: presence,
              })
            },
          },
          {
            destructive: true,
            icon: <RotateCw className="size-4" />,
            label: "Reset session",
            pending: reset.isPending,
            confirm: {
              title: "Reset session",
              description:
                "This swaps the current thread while keeping the durable session.",
              confirmLabel: "Reset session",
              entityLabel: "Session",
              itemLabel: sessionId,
            },
            onSelect: () => reset.mutateAsync(undefined),
          },
        ]}
      />
    </>
  )
}

function SessionDetailSidebar({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const session = useSessionDetail(agentKey, sessionId)
  const briefing = useBriefing(agentKey, sessionId)
  const heartbeat = useHeartbeat(agentKey, sessionId)
  const detail = session.data?.session
  const briefingRecord = briefing.data?.briefing
  const presence = heartbeat.data?.heartbeat
  const loading = session.isLoading || heartbeat.isLoading
  const briefingIsSet = Boolean(briefingRecord?.wasSet || detail?.briefingSet)

  return (
    <div className="grid gap-5">
      <DetailSection>
        <DetailSectionLabel>Session</DetailSectionLabel>
        <DetailsGrid>
          <DetailField
            loading={loading}
            label="Kind"
            value={<Badge variant="outline">{detail?.kind ?? "-"}</Badge>}
          />
          <DetailField
            loading={loading}
            label="Session id"
            value={<code>{shortSessionId(detail?.id ?? sessionId)}</code>}
          />
          <DetailField
            loading={loading}
            label="Current thread"
            value={<code>{short(detail?.currentThreadId)}</code>}
          />
          <DetailField
            loading={loading}
            label="Created"
            value={formatDate(detail?.createdAt)}
          />
          <DetailField
            loading={loading}
            label="Updated"
            value={formatDate(detail?.updatedAt)}
          />
        </DetailsGrid>
      </DetailSection>
      <DetailSection>
        <DetailSectionLabel>Configuration state</DetailSectionLabel>
        <div className="grid gap-3">
          <DetailPanel title="Briefing">
            <DetailsGrid>
              <DetailField
                loading={session.isLoading || briefing.isLoading}
                label="Status"
                value={
                  briefingIsSet ? (
                    <StatusBadge status="set" />
                  ) : (
                    <StatusBadge status="empty" />
                  )
                }
              />
              <DetailField
                loading={briefing.isLoading}
                label="Characters"
                value={(
                  briefingRecord?.content.trim().length ?? 0
                ).toLocaleString()}
              />
              <DetailField
                loading={briefing.isLoading}
                label="Updated"
                value={formatDate(briefingRecord?.updatedAt)}
              />
            </DetailsGrid>
          </DetailPanel>
          <DetailPanel title="Runtime defaults">
            <DetailsGrid>
              <DetailField
                loading={loading}
                label="Model"
                value={detail?.runtime.model ?? "default"}
              />
              <DetailField
                loading={loading}
                label="Thinking"
                value={runtimeThinkingLabel(detail)}
              />
              <DetailField
                loading={loading}
                label="Pending wake"
                value={formatDate(detail?.runtime.pendingWakeAt)}
              />
            </DetailsGrid>
          </DetailPanel>
          <DetailPanel title="Wake policy">
            <DetailsGrid>
              <DetailField
                loading={heartbeat.isLoading}
                label="Mode"
                value={<WakeModeBadge enabled={presence?.enabled} />}
              />
              <DetailField
                loading={heartbeat.isLoading}
                label="Every"
                value={presence ? `${presence.everyMinutes} min` : "-"}
              />
              <DetailField
                loading={heartbeat.isLoading}
                label="Next fire"
                value={formatDate(presence?.nextFireAt)}
              />
              <DetailField
                loading={heartbeat.isLoading}
                label="Last fire"
                value={formatDate(presence?.lastFireAt)}
              />
            </DetailsGrid>
          </DetailPanel>
        </div>
      </DetailSection>
    </div>
  )
}

function WakeModeBadge({ enabled }: { enabled?: boolean }) {
  return (
    <Badge variant={enabled ? "outline" : "secondary"}>
      {enabled ? "Automatic" : "Manual"}
    </Badge>
  )
}

function runtimeThinkingLabel(detail?: SessionDetail) {
  return (
    detail?.runtime.thinking ??
    (detail?.runtime.thinkingConfigured ? "off" : "default")
  )
}

export { SessionPage }
export default SessionPage
