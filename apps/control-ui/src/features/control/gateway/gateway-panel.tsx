import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Eye, Pencil, Plus, RotateCw, Trash2 } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableMultiSelectFilter,
  TableSelectFilter,
  booleanFilterValueSetter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import {
  useGatewayDevices,
  useGatewayEventTypes,
  useGatewaySources,
  useScopedGatewayEvents,
} from "@/features/control/api/queries"
import {
  enabledFilterOptions,
  formatDate,
  humanize,
  mobileHiddenColumns,
  StatusBadge,
  TokenBadges,
  TruncatedText,
} from "@/features/control/control-display"
import { formatBytes } from "@/features/control/formatting"
import {
  useGatewayDeviceSheet,
  useGatewayEventTypeSheet,
  useGatewayOneTimeSecretStore,
  useGatewaySourceSheet,
  gatewayEventTypeToFormValues,
} from "@/features/control/gateway/gateway-form-model"
import { sessionReferenceLabel } from "@/features/control/session-labels"
import {
  controlApi,
  type GatewayDevices,
  type GatewayDeviceRow,
  type GatewayEventRow,
  type GatewayEventTypeRow,
  type GatewaySourceRow,
} from "@/lib/api"
import { useAuth } from "@/lib/auth"

const gatewayDeviceCapabilityOptions = [
  { label: "Push context", value: "push_context" },
  { label: "Upload attachments", value: "upload_attachments" },
  { label: "Claim commands", value: "claim_commands" },
  { label: "Screenshot capture", value: "screenshot.capture" },
]

export function GatewayPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId?: string
}) {
  const auth = useAuth()
  const gatewaySourceSheet = useGatewaySourceSheet()
  const gatewayDeviceSheet = useGatewayDeviceSheet()
  const gatewayEventTypeSheet = useGatewayEventTypeSheet()
  const latestSecret = useGatewayOneTimeSecretStore(
    (state) => state.latestSourceSecret
  )
  const latestDeviceToken = useGatewayOneTimeSecretStore(
    (state) => state.latestDeviceToken
  )
  const setLatestSecret = useGatewayOneTimeSecretStore(
    (state) => state.setLatestSourceSecret
  )
  const sourceTable = useDataTableState(`agent:${agentKey}:gateway-sources`)
  const deviceTable = useDataTableState(`agent:${agentKey}:gateway-devices`, {
    per_page: 10,
    sort_by: "deviceId",
    sort_direction: "asc",
    filterValueSetters: {
      enabled: booleanFilterValueSetter,
    },
  })
  const eventTable = useDataTableState(
    sessionId
      ? `agent:${agentKey}:session:${sessionId}:gateway-events`
      : `agent:${agentKey}:gateway-events`,
    { sort_by: "createdAt", sort_direction: "desc" }
  )
  const eventTypeTable = useDataTableState(`agent:${agentKey}:gateway-event-types`, {
    per_page: 10,
    sort_by: "type",
    sort_direction: "asc",
  })
  const [deviceSourceId, setDeviceSourceId] = React.useState("")
  const [selectedEvent, setSelectedEvent] =
    React.useState<GatewayEventRow | null>(null)
  const sources = useGatewaySources(agentKey, sourceTable.params, {
    enabled: !sessionId,
  })
  const focusSources = useGatewaySources(
    agentKey,
    {
      per_page: 100,
      sort_by: "sourceId",
      sort_direction: "asc",
    },
    { enabled: !sessionId, staleTime: 30_000 }
  )
  const sourceRows = React.useMemo(
    () => sources.data?.data ?? [],
    [sources.data?.data]
  )
  const focusSourceRows = React.useMemo(
    () => focusSources.data?.data ?? sourceRows,
    [focusSources.data?.data, sourceRows]
  )
  const effectiveDeviceSourceId =
    !sessionId && focusSourceRows.length > 0
      ? focusSourceRows.some((source) => source.sourceId === deviceSourceId)
        ? deviceSourceId
        : focusSourceRows[0]!.sourceId
      : ""
  const devices = useGatewayDevices(
    agentKey,
    effectiveDeviceSourceId,
    deviceTable.params,
    { enabled: Boolean(effectiveDeviceSourceId) }
  )
  const eventTypes = useGatewayEventTypes(
    agentKey,
    effectiveDeviceSourceId,
    eventTypeTable.params,
    { enabled: Boolean(effectiveDeviceSourceId && !sessionId) }
  )
  const events = useScopedGatewayEvents(agentKey, sessionId, eventTable.params)
  const deviceRows = devices.data?.data ?? devices.data?.devices ?? []
  const deviceResponse = React.useMemo<GatewayDevices | undefined>(() => {
    if (!devices.data) return undefined
    return {
      ...devices.data,
      data: deviceRows,
      meta: devices.data.meta ?? {
        current_page: deviceTable.pagination.pageIndex + 1,
        last_page: 1,
        per_page: deviceTable.pagination.pageSize,
        total: deviceRows.length,
      },
      devices: devices.data.devices ?? deviceRows,
    }
  }, [
    devices.data,
    deviceRows,
    deviceTable.pagination.pageIndex,
    deviceTable.pagination.pageSize,
  ])
  const selectedDeviceSource = focusSourceRows.find(
    (source) => source.sourceId === effectiveDeviceSourceId
  )
  const eventSourceFilter =
    typeof eventTable.params.sourceId === "string"
      ? eventTable.params.sourceId
      : ""
  const eventSourceLabel = eventSourceFilter
    ? (focusSourceRows.find((source) => source.sourceId === eventSourceFilter)
        ?.name ?? eventSourceFilter)
    : "All sources"
  const gatewayEventSourceOptions = React.useMemo(
    () =>
      focusSourceRows.map((source) => ({
        label: gatewaySourceOptionLabel(source),
        value: source.sourceId,
      })),
    [focusSourceRows]
  )

  React.useEffect(() => {
    if (sessionId || !eventSourceFilter) return
    if (eventSourceFilter === deviceSourceId) return
    if (!focusSourceRows.some((source) => source.sourceId === eventSourceFilter))
      return
    setDeviceSourceId(eventSourceFilter)
  }, [deviceSourceId, eventSourceFilter, focusSourceRows, sessionId])

  function selectGatewaySource(sourceId: string) {
    setDeviceSourceId(sourceId)
    if (sessionId) return
    eventTable.setColumnFilters((previous) => [
      ...previous.filter((filter) => filter.id !== "sourceId"),
      { id: "sourceId", value: sourceId },
    ])
    eventTable.setPagination((previous) =>
      previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 }
    )
  }

  const rotate = useToastMutation({
    mutationFn: (sourceId: string) =>
      controlApi.rotateGatewaySource(agentKey, sourceId, auth.csrfToken),
    success: "Gateway secret rotated",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  React.useEffect(() => {
    if (rotate.data?.clientSecret) setLatestSecret(rotate.data.clientSecret)
  }, [rotate.data, setLatestSecret])
  const setSuspended = useToastMutation({
    mutationFn: ({
      sourceId,
      suspended,
    }: {
      sourceId: string
      suspended: boolean
    }) =>
      controlApi.setGatewaySourceSuspended(
        agentKey,
        sourceId,
        suspended,
        "control-ui",
        auth.csrfToken
      ),
    success: "Gateway source updated",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const setDeviceEnabled = useToastMutation({
    mutationFn: ({
      sourceId,
      deviceId,
      enabled,
    }: {
      sourceId: string
      deviceId: string
      enabled: boolean
    }) =>
      controlApi.setGatewayDeviceEnabled(
        agentKey,
        sourceId,
        deviceId,
        enabled,
        auth.csrfToken
      ),
    success: "Gateway device updated",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const disallowEventType = useToastMutation({
    mutationFn: ({ sourceId, type }: { sourceId: string; type: string }) =>
      controlApi.deleteGatewayEventType(agentKey, sourceId, type, auth.csrfToken),
    success: "Gateway event type disallowed",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<GatewaySourceRow>[] = [
    {
      accessorKey: "sourceId",
      meta: { label: "Source", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{row.original.sourceId}</Cell>,
    },
    {
      accessorKey: "name",
      meta: { label: "Name", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.name}</Cell>,
    },
    {
      accessorKey: "status",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "sessionId",
      meta: { label: "Session", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText
          value={sessionReferenceLabel(undefined, row.original.sessionId)}
          className="max-w-64"
        />
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for gateway source ${row.original.sourceId}`}
          actions={[
            {
              label: "Focus source",
              onSelect: () => selectGatewaySource(row.original.sourceId),
            },
            {
              label: "Allow event type",
              icon: <Plus className="size-4" />,
              onSelect: () => {
                setDeviceSourceId(row.original.sourceId)
                gatewayEventTypeSheet.setOpen(true, {
                  context: { agentKey, sourceId: row.original.sourceId },
                  defaultData: { sourceId: row.original.sourceId },
                })
              },
            },
            {
              label: "Register device",
              icon: <Plus className="size-4" />,
              onSelect: () => {
                setDeviceSourceId(row.original.sourceId)
                gatewayDeviceSheet.setOpen(true, {
                  context: { agentKey, sourceId: row.original.sourceId },
                  defaultData: { sourceId: row.original.sourceId },
                })
              },
            },
            {
              label: "Rotate secret",
              icon: <RotateCw className="size-4" />,
              pending: rotate.isPending,
              confirm: {
                title: "Rotate source secret",
                description: `Rotate ${row.original.sourceId}? The old secret stops working.`,
                confirmLabel: "Rotate secret",
                entityLabel: "Gateway source",
                itemLabel: row.original.sourceId,
              },
              onSelect: () => rotate.mutateAsync(row.original.sourceId),
            },
            {
              label: row.original.status === "active" ? "Suspend" : "Resume",
              pending: setSuspended.isPending,
              confirm: {
                title:
                  row.original.status === "active"
                    ? "Suspend source"
                    : "Resume source",
                description: `${row.original.status === "active" ? "Suspend" : "Resume"} ${row.original.sourceId}.`,
                confirmLabel:
                  row.original.status === "active"
                    ? "Suspend source"
                    : "Resume source",
                entityLabel: "Gateway source",
                itemLabel: row.original.sourceId,
              },
              onSelect: () =>
                setSuspended.mutateAsync({
                  sourceId: row.original.sourceId,
                  suspended: row.original.status === "active",
                }),
            },
          ]}
        />
      ),
    },
  ]
  const eventTypeColumns: ColumnDef<GatewayEventTypeRow>[] = [
    {
      accessorKey: "type",
      meta: { label: "Event type", maxWidthClassName: "max-w-64" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{row.original.type}</Cell>,
    },
    {
      accessorKey: "delivery",
      meta: { label: "Delivery" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.delivery} />,
    },
    {
      accessorKey: "updatedAt",
      meta: { label: "Updated", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.updatedAt)}</Cell>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for gateway event type ${row.original.type}`}
          actions={[
            {
              label: "Edit delivery",
              icon: <Pencil className="size-4" />,
              onSelect: () =>
                gatewayEventTypeSheet.setOpen(true, {
                  context: { agentKey, sourceId: row.original.sourceId },
                  defaultData: gatewayEventTypeToFormValues(row.original),
                  entity: row.original,
                }),
            },
            {
              label: "Disallow",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: disallowEventType.isPending,
              confirm: {
                title: "Disallow event type",
                description: `Disallow ${row.original.type} for source ${row.original.sourceId}? Future events of this type will be rejected; historical events are kept.`,
                confirmLabel: "Disallow event type",
                entityLabel: "Gateway event type",
                itemLabel: `${row.original.sourceId}:${row.original.type}`,
              },
              onSelect: () =>
                disallowEventType.mutateAsync({
                  sourceId: row.original.sourceId,
                  type: row.original.type,
                }),
            },
          ]}
        />
      ),
    },
  ]
  const deviceColumns: ColumnDef<GatewayDeviceRow>[] = [
    {
      accessorKey: "deviceId",
      meta: { label: "Device", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell highlighted>{row.original.deviceId}</Cell>,
    },
    {
      accessorKey: "label",
      meta: { label: "Label", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.label}</Cell>,
    },
    {
      accessorKey: "enabled",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <StatusBadge status={row.original.enabled ? "enabled" : "disabled"} />
      ),
    },
    {
      accessorKey: "capabilities",
      meta: { label: "Capabilities", wrap: true, maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => (
        <TokenBadges values={row.original.capabilities} className="max-w-64" />
      ),
    },
    {
      accessorKey: "lastSeenAt",
      meta: { label: "Last seen", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.lastSeenAt)}</Cell>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => {
        const enabled = row.original.enabled
        return (
          <RowActionsMenu
            triggerLabel={`Open actions for gateway device ${row.original.deviceId}`}
            actions={[
              {
                label: enabled ? "Disable device" : "Enable device",
                pending: setDeviceEnabled.isPending,
                destructive: enabled,
                confirm: {
                  title: enabled
                    ? "Disable gateway device"
                    : "Enable gateway device",
                  description: `${enabled ? "Disable" : "Enable"} ${row.original.deviceId} for source ${row.original.sourceId}.`,
                  confirmLabel: enabled ? "Disable device" : "Enable device",
                  entityLabel: "Gateway device",
                  itemLabel: `${row.original.sourceId}:${row.original.deviceId}`,
                },
                onSelect: () =>
                  setDeviceEnabled.mutateAsync({
                    deviceId: row.original.deviceId,
                    enabled: !enabled,
                    sourceId: row.original.sourceId,
                  }),
              },
            ]}
          />
        )
      },
    },
  ]
  const eventColumns: ColumnDef<GatewayEventRow>[] = [
    {
      accessorKey: "sourceId",
      meta: { label: "Source", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.sourceId}</Cell>,
    },
    {
      accessorKey: "type",
      meta: { label: "Type", maxWidthClassName: "max-w-64" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{row.original.type}</Cell>,
    },
    {
      accessorKey: "status",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "textBytes",
      meta: { label: "Bytes", valueType: "number" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatBytes(row.original.textBytes)}</Cell>,
    },
    {
      accessorKey: "createdAt",
      meta: { label: "Created", valueType: "datetime", align: "right" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{formatDate(row.original.createdAt)}</Cell>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      meta: { linkEnabled: false, align: "right" },
      cell: ({ row }) => (
        <RowActionsMenu
          triggerLabel={`Open actions for gateway event ${row.original.id}`}
          actions={[
            {
              label: "Inspect",
              icon: <Eye className="size-4" />,
              onSelect: () => setSelectedEvent(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <div className="grid min-w-0 gap-4">
      {!sessionId ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() =>
              gatewaySourceSheet.setOpen(true, {
                context: { agentKey },
              })
            }
          >
            <Plus className="size-4" />
            Create source
          </Button>
        </div>
      ) : (
        <div className="border bg-muted/20 p-3">
          <div className="text-sm font-medium">Session gateway events</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Source, device, and event-type management lives on the agent Gateway
            tab. This workspace only shows events routed into this session.
          </div>
        </div>
      )}
      {!sessionId && latestSecret ? (
        <div className="border border-primary p-3 text-xs">
          <div className="mb-1 font-medium">New secret</div>
          <code className="break-all">{latestSecret}</code>
        </div>
      ) : null}
      {!sessionId ? (
        <DataTableView
          columns={columns}
          response={sources.data}
          state={sourceTable}
          error={sources.error}
          isFetching={sources.isFetching}
          isLoading={sources.isLoading}
          isPlaceholderData={sources.isPlaceholderData}
          onRetry={() => void sources.refetch()}
          rowKey={(row) => row.sourceId}
          emptyLabel="No gateway sources for this agent."
          emptyDescription="Create a source before registering devices or accepting gateway events."
          emptyAction={
            <Button
              size="sm"
              onClick={() =>
                gatewaySourceSheet.setOpen(true, {
                  context: { agentKey },
                })
              }
            >
              <Plus className="size-4" />
              Create source
            </Button>
          }
          mobileColumnVisibility={mobileHiddenColumns("name", "sessionId")}
        />
      ) : null}
      {!sessionId ? (
        <GatewaySourceFocus
          eventSourceFilter={eventSourceFilter}
          eventSourceLabel={eventSourceLabel}
          isLoading={focusSources.isLoading}
          onSelectSource={selectGatewaySource}
          selectedSource={selectedDeviceSource}
          selectedSourceId={effectiveDeviceSourceId}
          sources={focusSourceRows}
        />
      ) : null}
      {!sessionId ? (
        <div className="grid gap-3 border p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium">Gateway devices</div>
              <div className="text-xs text-muted-foreground">
                {effectiveDeviceSourceId ? (
                  <>
                    Source{" "}
                    <code>
                      {selectedDeviceSource?.name ?? effectiveDeviceSourceId}
                    </code>
                  </>
                ) : sources.isLoading ? (
                  "Loading sources..."
                ) : (
                  "Create a gateway source before registering devices."
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!effectiveDeviceSourceId}
              onClick={() =>
                gatewayDeviceSheet.setOpen(true, {
                  context: { agentKey, sourceId: effectiveDeviceSourceId },
                  defaultData: { sourceId: effectiveDeviceSourceId },
                })
              }
            >
              <Plus className="size-4" />
              Register device
            </Button>
          </div>
          {latestDeviceToken ? (
            <div className="border border-primary p-3 text-xs">
              <div className="mb-1 font-medium">New device token</div>
              <code className="break-all">{latestDeviceToken}</code>
            </div>
          ) : null}
          {effectiveDeviceSourceId ? (
            <DataTableView
              columns={deviceColumns}
              response={deviceResponse}
              state={deviceTable}
              error={devices.error}
              filters={
                <GatewayDeviceFilters
                  state={deviceTable}
                  capabilityOptions={gatewayDeviceCapabilityOptions}
                />
              }
              isFetching={devices.isFetching}
              isLoading={devices.isLoading}
              isPlaceholderData={devices.isPlaceholderData}
              onRetry={() => void devices.refetch()}
              rowKey={(row) => `${row.sourceId}:${row.deviceId}`}
              emptyLabel="No devices for this source."
              mobileColumnVisibility={mobileHiddenColumns(
                "label",
                "capabilities",
                "lastSeenAt"
              )}
            />
          ) : null}
        </div>
      ) : null}
      {!sessionId ? (
        <div className="grid gap-3 border p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium">Allowed event types</div>
              <div className="text-xs text-muted-foreground">
                {effectiveDeviceSourceId ? (
                  <>
                    Source{" "}
                    <code>
                      {selectedDeviceSource?.name ?? effectiveDeviceSourceId}
                    </code>
                  </>
                ) : sources.isLoading ? (
                  "Loading sources..."
                ) : (
                  "Create a gateway source before allowing event types."
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!effectiveDeviceSourceId}
              onClick={() =>
                gatewayEventTypeSheet.setOpen(true, {
                  context: { agentKey, sourceId: effectiveDeviceSourceId },
                  defaultData: { sourceId: effectiveDeviceSourceId },
                })
              }
            >
              <Plus className="size-4" />
              Allow event type
            </Button>
          </div>
          {effectiveDeviceSourceId ? (
            <DataTableView
              columns={eventTypeColumns}
              response={eventTypes.data}
              state={eventTypeTable}
              error={eventTypes.error}
              isFetching={eventTypes.isFetching}
              isLoading={eventTypes.isLoading}
              onRetry={() => void eventTypes.refetch()}
              rowKey={(row) => `${row.sourceId}:${row.type}`}
              emptyLabel="No event types allowed for this source."
              emptyDescription="Gateway rejects unexpected event types until they are explicitly allowed."
              emptyAction={
                <Button
                  size="sm"
                  onClick={() =>
                    gatewayEventTypeSheet.setOpen(true, {
                      context: { agentKey, sourceId: effectiveDeviceSourceId },
                      defaultData: { sourceId: effectiveDeviceSourceId },
                    })
                  }
                >
                  <Plus className="size-4" />
                  Allow event type
                </Button>
              }
              mobileColumnVisibility={mobileHiddenColumns("updatedAt")}
            />
          ) : null}
        </div>
      ) : null}
      <div className="border p-3">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {sessionId ? "Session gateway events" : "Gateway events"}
            </div>
            <div className="text-xs text-muted-foreground">
              {sessionId
                ? "Events routed into this session."
                : eventSourceFilter
                  ? `Filtered to ${eventSourceLabel}. Clear filters to inspect all sources.`
                  : "Showing events across all gateway sources."}
            </div>
          </div>
          {!sessionId &&
          effectiveDeviceSourceId &&
          eventSourceFilter !== effectiveDeviceSourceId ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => selectGatewaySource(effectiveDeviceSourceId)}
            >
              Follow focused source
            </Button>
          ) : null}
        </div>
        <DataTableView
          columns={eventColumns}
          response={events.data}
          state={eventTable}
          error={events.error}
          isFetching={events.isFetching}
          isLoading={events.isLoading}
          isPlaceholderData={events.isPlaceholderData}
          onRetry={() => void events.refetch()}
          rowKey={(row) => row.id}
          filters={
            !sessionId ? (
              <GatewayEventFilters
                state={eventTable}
                sourceOptions={gatewayEventSourceOptions}
              />
            ) : undefined
          }
          emptyLabel={
            sessionId
              ? "No gateway events routed to this session."
              : "No gateway events for this agent."
          }
          mobileColumnVisibility={mobileHiddenColumns("type", "createdAt")}
        />
      </div>
      <GatewayEventDetailsSheet
        event={selectedEvent}
        setEvent={setSelectedEvent}
      />
    </div>
  )
}

function GatewayEventDetailsSheet({
  event,
  setEvent,
}: {
  event: GatewayEventRow | null
  setEvent: (event: GatewayEventRow | null) => void
}) {
  return (
    <Sheet open={Boolean(event)} onOpenChange={(open) => !open && setEvent(null)}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Gateway Event</SheetTitle>
          <SheetDescription>
            {event
              ? `${humanize(event.type)} - ${formatDate(event.createdAt) ?? "-"}`
              : "Gateway event delivery details"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {event ? (
            <div className="grid gap-4">
              <section className="grid gap-3 border p-3">
                <div className="text-sm font-medium">Delivery</div>
                <GatewayEventDetailRow
                  label="Status"
                  value={<StatusBadge status={event.status} />}
                />
                <GatewayEventDetailRow label="Type" value={event.type} mono />
                <GatewayEventDetailRow label="Created" value={formatDate(event.createdAt) ?? "-"} />
                <GatewayEventDetailRow label="Reason" value={event.reason ?? "-"} />
                <GatewayEventDetailRow label="Delivery requested" value={humanize(event.deliveryRequested)} />
                <GatewayEventDetailRow label="Delivery effective" value={humanize(event.deliveryEffective)} />
              </section>
              <section className="grid gap-3 border p-3">
                <div className="text-sm font-medium">Identifiers</div>
                <GatewayEventDetailRow label="Event id" value={event.id} mono />
                <GatewayEventDetailRow label="Source" value={event.sourceId} mono />
                <GatewayEventDetailRow label="Thread" value={event.threadId ?? "-"} mono />
                <GatewayEventDetailRow label="Text bytes" value={formatBytes(event.textBytes)} />
                <GatewayEventDetailRow label="Text sha256" value={event.textSha256} mono />
              </section>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function GatewayEventDetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? "break-all font-mono text-xs" : "break-words text-sm font-medium"}>
        {value}
      </div>
    </div>
  )
}

function GatewaySourceFocus({
  eventSourceFilter,
  eventSourceLabel,
  isLoading,
  onSelectSource,
  selectedSource,
  selectedSourceId,
  sources,
}: {
  eventSourceFilter: string
  eventSourceLabel: string
  isLoading: boolean
  onSelectSource: (sourceId: string) => void
  selectedSource?: GatewaySourceRow
  selectedSourceId: string
  sources: GatewaySourceRow[]
}) {
  return (
    <div className="grid gap-3 border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium">Source focus</div>
          <div className="text-xs text-muted-foreground">
            Devices and allowed event types use this source. Selecting a source
            also applies the event source filter.
          </div>
        </div>
        <Select
          value={selectedSourceId}
          onValueChange={onSelectSource}
          disabled={isLoading || sources.length === 0}
        >
          <SelectTrigger
            className="w-full sm:w-80"
            aria-label="Focused gateway source"
          >
            <SelectValue
              placeholder={isLoading ? "Loading sources" : "Choose source"}
            />
          </SelectTrigger>
          <SelectContent align="end">
            {sources.map((source) => (
              <SelectItem key={source.sourceId} value={source.sourceId}>
                {gatewaySourceOptionLabel(source)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selectedSource ? (
        <div className="grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-4">
          <div className="min-w-0">
            <div className="font-medium text-foreground">Status</div>
            <div className="mt-1">
              <StatusBadge status={selectedSource.status} />
            </div>
          </div>
          <div className="min-w-0">
            <div className="font-medium text-foreground">Route</div>
            <div className="mt-1 truncate">
              {selectedSource.sessionId
                ? sessionReferenceLabel(undefined, selectedSource.sessionId)
                : "Agent default"}
            </div>
          </div>
          <div className="min-w-0">
            <div className="font-medium text-foreground">Source id</div>
            <code className="mt-1 block truncate">{selectedSource.sourceId}</code>
          </div>
          <div className="min-w-0">
            <div className="font-medium text-foreground">Events filter</div>
            <div className="mt-1 truncate">
              {eventSourceFilter ? eventSourceLabel : "All sources"}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function gatewaySourceOptionLabel(source: GatewaySourceRow) {
  const name = source.name?.trim() || source.sourceId
  const route = source.sessionId
    ? `session ${source.sessionId.slice(0, 8)}`
    : "agent default"
  return `${name} · ${source.sourceId} · ${route}`
}

function GatewayDeviceFilters({
  state,
  capabilityOptions,
}: {
  state: DataTableState
  capabilityOptions: Array<{ label: string; value: string }>
}) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="enabled"
        label="Status"
        allLabel="All statuses"
        options={enabledFilterOptions}
        triggerClassName="w-36"
      />
      <TableMultiSelectFilter
        state={state}
        id="capabilities"
        label="Capabilities"
        allLabel="All capabilities"
        options={capabilityOptions}
        triggerClassName="w-44"
      />
    </>
  )
}

function GatewayEventFilters({
  state,
  sourceOptions,
}: {
  state: DataTableState
  sourceOptions: Array<{ label: string; value: string }>
}) {
  return (
    <TableSelectFilter
      state={state}
      id="sourceId"
      label="Source"
      allLabel="All sources"
      options={sourceOptions}
      triggerClassName="w-56"
    />
  )
}
