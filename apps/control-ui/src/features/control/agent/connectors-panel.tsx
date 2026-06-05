import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Link2, Mail, MessageCircle, Pencil, Plug, Plus, RouteIcon, ShieldCheck, Trash2, UserRound } from "lucide-react"

import {
  Cell,
  DataTableView,
  RowActionsMenu,
  TableSelectFilter,
  renderColumnHeader,
  type DataTableState,
  useDataTableState,
} from "@/components/common/data-table"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToastMutation } from "@/features/control/api/mutations"
import { controlKeys } from "@/features/control/api/query-key-factory"
import {
  useAgentBindings,
  useAgentChannelActorPairings,
  useAgentConnectors,
  useAgentDiscordActorPairings,
  useAgentEmailAllowedRecipients,
  useAgentEmailRoutes,
  useAgentSessions,
} from "@/features/control/api/queries"
import {
  StatusBadge,
  TokenBadges,
  TruncatedText,
  formatDate,
  humanize,
  mobileHiddenColumns,
} from "@/features/control/control-display"
import {
  connectorToDiscordFormValues,
  connectorToEmailFormValues,
  emailRouteToFormValues,
} from "@/features/control/forms/form-values"
import {
  useBindingSheet,
  useChannelActorPairingSheet,
  useDiscordActorPairingSheet,
  useDiscordConnectorSheet,
  useEmailAllowedRecipientSheet,
  useEmailConnectorSheet,
  useEmailRouteSheet,
} from "@/features/control/forms/use-control-form-sheets"
import {
  sessionPickerLabel,
  sessionReferenceLabel,
} from "@/features/control/session-labels"
import {
  controlApi,
  type BindingRow,
  type ChannelActorPairingRow,
  type ConnectorRow,
  type DiscordActorPairingRow,
  type EmailAllowedRecipientRow,
  type EmailRouteRow,
} from "@/lib/api"
import { useAuth } from "@/lib/auth"

const connectorSourceFilterOptions = [
  { label: "Discord", value: "discord" },
  { label: "Email", value: "email" },
  { label: "Telegram", value: "telegram" },
]

const connectorStatusFilterOptions = [
  { label: "Enabled", value: "enabled" },
  { label: "Disabled", value: "disabled" },
  { label: "Error", value: "error" },
  { label: "Revoked", value: "revoked" },
]

const bindingSourceFilterOptions = [
  { label: "Discord", value: "discord" },
  { label: "Email", value: "email" },
  { label: "Telegram", value: "telegram" },
]

const channelActorSourceFilterOptions = [
  { label: "Telegram", value: "telegram" },
  { label: "WhatsApp", value: "whatsapp" },
]

export function ConnectorsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const bindingSheet = useBindingSheet()
  const discordSheet = useDiscordConnectorSheet()
  const emailSheet = useEmailConnectorSheet()
  const table = useDataTableState(`agent:${agentKey}:connectors`)
  const connectors = useAgentConnectors(agentKey, table.params)
  const setEnabled = useToastMutation({
    mutationFn: ({ row, enabled }: { row: ConnectorRow; enabled: boolean }) =>
      controlApi.setConnectorEnabled(agentKey, row, enabled, auth.csrfToken),
    success: "Connector updated",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<ConnectorRow>[] = [
    {
      accessorKey: "source",
      meta: { label: "Source", maxWidthClassName: "max-w-28" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{humanize(row.original.source)}</Cell>,
    },
    {
      accessorKey: "accountKey",
      meta: { label: "Account", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <ConnectorAccountCell connector={row.original} />,
    },
    {
      accessorKey: "connectorKey",
      meta: { label: "Connector key", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <Cell className="font-mono text-xs">{row.original.connectorKey}</Cell>
      ),
    },
    {
      accessorKey: "status",
      meta: { label: "Status" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "secretKeys",
      meta: { label: "Credential keys", wrap: true, maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: false,
      cell: ({ row }) => (
        <TokenBadges
          values={
            row.original.secretKeys.length > 0
              ? row.original.secretKeys
              : row.original.email?.credentialKeys ?? []
          }
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
      cell: ({ row }) => {
        const enabled = row.original.status !== "disabled"
        const editable =
          row.original.source === "discord" || row.original.source === "email"
        return (
          <RowActionsMenu
            triggerLabel={`Open actions for connector ${row.original.accountKey}`}
            actions={[
              {
                label: "Bind conversation",
                icon: <Link2 className="size-4" />,
                onSelect: () =>
                  bindingSheet.setOpen(true, {
                    context: { agentKey },
                    defaultData: {
                      connectorKey: row.original.connectorKey,
                      source: row.original.source,
                    },
                  }),
              },
              {
                label: "Edit",
                icon: <Pencil className="size-4" />,
                disabled: !editable,
                onSelect: () => {
                  if (row.original.source === "email") {
                    emailSheet.setOpen(true, {
                      context: { agentKey },
                      defaultData: connectorToEmailFormValues(row.original),
                      entity: row.original,
                    })
                    return
                  }
                  discordSheet.setOpen(true, {
                    context: { agentKey },
                    defaultData: connectorToDiscordFormValues(row.original),
                    entity: row.original,
                  })
                },
              },
              {
                label: enabled ? "Disable connector" : "Enable connector",
                disabled: setEnabled.isPending,
                pending: setEnabled.isPending,
                destructive: enabled,
                confirm: {
                  title: enabled ? "Disable connector" : "Enable connector",
                  description: `${enabled ? "Disable" : "Enable"} ${row.original.accountKey} for ${row.original.source}.`,
                  confirmLabel: enabled
                    ? "Disable connector"
                    : "Enable connector",
                  entityLabel: "Connector",
                  itemLabel: `${row.original.source}:${row.original.accountKey}`,
                },
                onSelect: () =>
                  setEnabled.mutateAsync({
                    row: row.original,
                    enabled: !enabled,
                  }),
              },
            ]}
          />
        )
      },
    },
  ]

  return (
    <div className="grid min-w-0 gap-6">
      <section className="grid min-w-0 gap-3">
        <h2 className="text-sm font-semibold">Connector accounts</h2>
        <DataTableView
          columns={columns}
          response={connectors.data}
          state={table}
          error={connectors.error}
          filters={<ConnectorFilters state={table} />}
          isFetching={connectors.isFetching}
          isLoading={connectors.isLoading}
          isPlaceholderData={connectors.isPlaceholderData}
          onRetry={() => void connectors.refetch()}
          rowKey={(row) => row.id}
          emptyLabel="No connector accounts for this agent."
          emptyDescription="Add Discord or email accounts here, or store Telegram accounts with the CLI before creating channel bindings."
          emptyAction={
            <ConnectorPrerequisiteActions
              onAddDiscord={() =>
                discordSheet.setOpen(true, { context: { agentKey } })
              }
              onAddEmail={() =>
                emailSheet.setOpen(true, { context: { agentKey } })
              }
            />
          }
          mobileColumnVisibility={mobileHiddenColumns(
            "connectorKey",
            "secretKeys"
          )}
          toolbarActions={
            <ConnectorAccountCreateMenu
              onAddDiscord={() =>
                discordSheet.setOpen(true, { context: { agentKey } })
              }
              onAddEmail={() =>
                emailSheet.setOpen(true, { context: { agentKey } })
              }
            />
          }
        />
      </section>
      <DiscordActorPairingsPanel agentKey={agentKey} />
      <ChannelActorPairingsPanel agentKey={agentKey} />
      <EmailRoutesPanel agentKey={agentKey} />
      <EmailAllowedRecipientsPanel agentKey={agentKey} />
    </div>
  )
}

function DiscordActorPairingsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const pairingSheet = useDiscordActorPairingSheet()
  const discordSheet = useDiscordConnectorSheet()
  const table = useDataTableState(`agent:${agentKey}:discord-actor-pairings`)
  const pairings = useAgentDiscordActorPairings(agentKey, table.params)
  const discordAccounts = useAgentConnectors(
    agentKey,
    {
      page: 1,
      per_page: 100,
      sort_by: "accountKey",
      sort_direction: "asc",
      source: "discord",
    },
    { staleTime: 30_000 }
  )
  const accountOptions = React.useMemo(
    () =>
      (discordAccounts.data?.data ?? [])
        .filter((connector) => connector.source === "discord")
        .map((connector) => ({
          label: connector.displayName ?? connector.accountKey,
          value: connector.accountKey,
        })),
    [discordAccounts.data?.data]
  )
  const hasDiscordAccounts = (discordAccounts.data?.meta.total ?? 0) > 0
  const remove = useToastMutation({
    mutationFn: (row: DiscordActorPairingRow) =>
      controlApi.deleteDiscordActorPairing(agentKey, row, auth.csrfToken),
    success: "Discord actor pairing removed",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<DiscordActorPairingRow>[] = [
    {
      accessorKey: "accountKey",
      meta: { label: "Account", maxWidthClassName: "max-w-64" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <Cell highlighted className="font-mono text-xs">
          {row.original.accountKey}
        </Cell>
      ),
    },
    {
      accessorKey: "externalActorId",
      meta: { label: "Discord user id", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <Cell className="font-mono text-xs">{row.original.externalActorId}</Cell>
      ),
    },
    {
      accessorKey: "identityHandle",
      meta: { label: "Identity", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate font-medium">{row.original.identityHandle}</span>
          <span className="truncate text-xs text-muted-foreground">
            {row.original.identityDisplayName}
          </span>
        </div>
      ),
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
          triggerLabel={`Open actions for Discord actor ${row.original.externalActorId}`}
          actions={[
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: remove.isPending,
              confirm: {
                title: "Delete Discord actor pairing",
                description:
                  "This prevents the selected Discord user from resolving to this Panda identity for the selected account.",
                confirmLabel: "Delete pairing",
                entityLabel: "Discord actor",
                itemLabel: `${row.original.accountKey}:${row.original.externalActorId} -> ${row.original.identityHandle}`,
              },
              onSelect: () => remove.mutateAsync(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="text-sm font-semibold">Discord actor pairings</h2>
      <DataTableView
        columns={columns}
        response={pairings.data}
        state={table}
        error={pairings.error}
        filters={
          <DiscordAccountFilter state={table} accountOptions={accountOptions} />
        }
        isFetching={pairings.isFetching}
        isLoading={pairings.isLoading}
        isPlaceholderData={pairings.isPlaceholderData}
        onRetry={() => void pairings.refetch()}
        rowKey={(row) => `${row.accountKey}:${row.externalActorId}`}
        emptyLabel="No Discord actor pairings."
        emptyDescription={
          hasDiscordAccounts
            ? "Pair numeric Discord user ids to Panda identities for inbound actor resolution."
            : "Add a Discord account before pairing Discord users to identities."
        }
        emptyAction={
          discordAccounts.isLoading ? (
            <Button size="sm" disabled>
              Checking accounts
            </Button>
          ) : hasDiscordAccounts ? (
            <Button size="sm" onClick={openActorPairing}>
              <UserRound className="size-4" />
              Pair actor
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                discordSheet.setOpen(true, { context: { agentKey } })
              }
            >
              <Plug className="size-4" />
              Add Discord account
            </Button>
          )
        }
        mobileColumnVisibility={mobileHiddenColumns("updatedAt")}
        toolbarActions={
          discordAccounts.isLoading ? (
            <Button size="sm" variant="outline" disabled>
              <UserRound className="size-4" />
              Checking accounts
            </Button>
          ) : hasDiscordAccounts ? (
            <Button size="sm" onClick={openActorPairing}>
              <UserRound className="size-4" />
              Pair actor
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                discordSheet.setOpen(true, { context: { agentKey } })
              }
            >
              <Plug className="size-4" />
              Add Discord account
            </Button>
          )
        }
      />
    </section>
  )

  function openActorPairing() {
    pairingSheet.setOpen(true, { context: { agentKey } })
  }
}

function ChannelActorPairingsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const pairingSheet = useChannelActorPairingSheet()
  const table = useDataTableState(`agent:${agentKey}:channel-actor-pairings`)
  const pairings = useAgentChannelActorPairings(agentKey, table.params)
  const remove = useToastMutation({
    mutationFn: (row: ChannelActorPairingRow) =>
      controlApi.deleteChannelActorPairing(agentKey, row, auth.csrfToken),
    success: "Channel actor pairing removed",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<ChannelActorPairingRow>[] = [
    {
      accessorKey: "source",
      meta: { label: "Source", maxWidthClassName: "max-w-32" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell>{humanize(row.original.source)}</Cell>,
    },
    {
      accessorKey: "connectorKey",
      meta: { label: "Connector", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <Cell highlighted className="font-mono text-xs">
          {row.original.connectorKey}
        </Cell>
      ),
    },
    {
      accessorKey: "externalActorId",
      meta: { label: "Actor", maxWidthClassName: "max-w-80" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <TruncatedText
          value={row.original.externalActorId}
          className="max-w-72 font-mono text-xs"
        />
      ),
    },
    {
      accessorKey: "identityHandle",
      meta: { label: "Identity", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate font-medium">{row.original.identityHandle}</span>
          <span className="truncate text-xs text-muted-foreground">
            {row.original.identityDisplayName}
          </span>
        </div>
      ),
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
          triggerLabel={`Open actions for ${row.original.source} actor ${row.original.externalActorId}`}
          actions={[
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: remove.isPending,
              confirm: {
                title: "Delete channel actor pairing",
                description:
                  "This prevents the selected Telegram or WhatsApp actor from resolving to this Panda identity.",
                confirmLabel: "Delete pairing",
                entityLabel: "Channel actor",
                itemLabel: `${row.original.source}:${row.original.connectorKey}:${row.original.externalActorId} -> ${row.original.identityHandle}`,
              },
              onSelect: () => remove.mutateAsync(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="text-sm font-semibold">Telegram and WhatsApp actors</h2>
      <DataTableView
        columns={columns}
        response={pairings.data}
        state={table}
        error={pairings.error}
        filters={<ChannelActorPairingFilters state={table} />}
        isFetching={pairings.isFetching}
        isLoading={pairings.isLoading}
        isPlaceholderData={pairings.isPlaceholderData}
        onRetry={() => void pairings.refetch()}
        rowKey={(row) =>
          `${row.source}:${row.connectorKey}:${row.externalActorId}`
        }
        emptyLabel="No Telegram or WhatsApp actors."
        emptyDescription="Pair channel actors to identities already paired with this agent."
        emptyAction={
          <Button size="sm" onClick={openActorPairing}>
            <MessageCircle className="size-4" />
            Pair actor
          </Button>
        }
        mobileColumnVisibility={mobileHiddenColumns("connectorKey", "updatedAt")}
        toolbarActions={
          <Button size="sm" onClick={openActorPairing}>
            <MessageCircle className="size-4" />
            Pair actor
          </Button>
        }
      />
    </section>
  )

  function openActorPairing() {
    pairingSheet.setOpen(true, { context: { agentKey } })
  }
}

function EmailRoutesPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const routeSheet = useEmailRouteSheet()
  const emailSheet = useEmailConnectorSheet()
  const table = useDataTableState(`agent:${agentKey}:email-routes`)
  const routes = useAgentEmailRoutes(agentKey, table.params)
  const emailAccounts = useAgentConnectors(
    agentKey,
    {
      page: 1,
      per_page: 100,
      sort_by: "accountKey",
      sort_direction: "asc",
      source: "email",
    },
    { staleTime: 30_000 }
  )
  const accountOptions = React.useMemo(
    () =>
      (emailAccounts.data?.data ?? [])
        .filter((connector) => connector.source === "email")
        .map((connector) => ({
          label: connector.displayName ?? connector.accountKey,
          value: connector.accountKey,
        })),
    [emailAccounts.data?.data]
  )
  const hasEmailAccounts = (emailAccounts.data?.meta.total ?? 0) > 0
  const remove = useToastMutation({
    mutationFn: (row: EmailRouteRow) =>
      controlApi.deleteEmailRoute(agentKey, row, auth.csrfToken),
    success: "Email route deleted",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<EmailRouteRow>[] = [
    {
      accessorKey: "accountKey",
      meta: { label: "Account", maxWidthClassName: "max-w-64" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <Cell highlighted className="font-mono text-xs">
          {row.original.accountKey}
        </Cell>
      ),
    },
    {
      accessorKey: "mailbox",
      meta: { label: "Mailbox", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <Cell>{row.original.mailbox ?? "Account fallback"}</Cell>
      ),
    },
    {
      accessorKey: "sessionLabel",
      meta: { label: "Session", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText
          value={sessionReferenceLabel(
            row.original.sessionLabel,
            row.original.sessionId
          )}
        />
      ),
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
          triggerLabel={`Open actions for email route ${row.original.accountKey}`}
          actions={[
            {
              label: "Edit",
              icon: <Pencil className="size-4" />,
              onSelect: () =>
                routeSheet.setOpen(true, {
                  context: { agentKey },
                  defaultData: emailRouteToFormValues(row.original),
                  entity: row.original,
                }),
            },
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: remove.isPending,
              confirm: {
                title: "Delete email route",
                description: "Remove this deterministic inbound email route.",
                confirmLabel: "Delete route",
                entityLabel: "Email route",
                itemLabel: `${row.original.accountKey}:${row.original.mailbox ?? "<account>"}`,
              },
              onSelect: () => remove.mutateAsync(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="text-sm font-semibold">Email routes</h2>
      <DataTableView
        columns={columns}
        response={routes.data}
        state={table}
        error={routes.error}
        filters={
          <EmailAccountFilter state={table} accountOptions={accountOptions} />
        }
        isFetching={routes.isFetching}
        isLoading={routes.isLoading}
        isPlaceholderData={routes.isPlaceholderData}
        onRetry={() => void routes.refetch()}
        rowKey={(row) => row.id}
        getLink={(row) =>
          `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(row.sessionId)}`
        }
        emptyLabel="No email routes for this agent."
        emptyDescription="Inbound mail falls back to the agent main session."
        emptyAction={
          emailAccounts.isLoading ? (
            <Button size="sm" disabled>
              Checking accounts
            </Button>
          ) : hasEmailAccounts ? (
            <Button size="sm" onClick={openEmailRoute}>
              <RouteIcon className="size-4" />
              Add route
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => emailSheet.setOpen(true, { context: { agentKey } })}
            >
              <Mail className="size-4" />
              Add email account
            </Button>
          )
        }
        mobileColumnVisibility={mobileHiddenColumns("updatedAt")}
        toolbarActions={
          emailAccounts.isLoading ? (
            <Button size="sm" variant="outline" disabled>
              <RouteIcon className="size-4" />
              Checking accounts
            </Button>
          ) : hasEmailAccounts ? (
            <Button size="sm" onClick={openEmailRoute}>
              <RouteIcon className="size-4" />
              Add route
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => emailSheet.setOpen(true, { context: { agentKey } })}
            >
              <Mail className="size-4" />
              Add email account
            </Button>
          )
        }
      />
    </section>
  )

  function openEmailRoute() {
    routeSheet.setOpen(true, { context: { agentKey } })
  }
}

function EmailAllowedRecipientsPanel({ agentKey }: { agentKey: string }) {
  const auth = useAuth()
  const allowSheet = useEmailAllowedRecipientSheet()
  const emailSheet = useEmailConnectorSheet()
  const table = useDataTableState(`agent:${agentKey}:email-allowlist`)
  const recipients = useAgentEmailAllowedRecipients(agentKey, table.params)
  const emailAccounts = useAgentConnectors(
    agentKey,
    {
      page: 1,
      per_page: 100,
      sort_by: "accountKey",
      sort_direction: "asc",
      source: "email",
    },
    { staleTime: 30_000 }
  )
  const accountOptions = React.useMemo(
    () =>
      (emailAccounts.data?.data ?? [])
        .filter((connector) => connector.source === "email")
        .map((connector) => ({
          label: connector.displayName ?? connector.accountKey,
          value: connector.accountKey,
        })),
    [emailAccounts.data?.data]
  )
  const hasEmailAccounts = (emailAccounts.data?.meta.total ?? 0) > 0
  const remove = useToastMutation({
    mutationFn: (row: EmailAllowedRecipientRow) =>
      controlApi.deleteEmailAllowedRecipient(agentKey, row, auth.csrfToken),
    success: "Allowed recipient removed",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<EmailAllowedRecipientRow>[] = [
    {
      accessorKey: "accountKey",
      meta: { label: "Account", maxWidthClassName: "max-w-64" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => (
        <Cell highlighted className="font-mono text-xs">
          {row.original.accountKey}
        </Cell>
      ),
    },
    {
      accessorKey: "address",
      meta: { label: "Recipient", maxWidthClassName: "max-w-80" },
      header: renderColumnHeader,
      enableSorting: true,
      enableHiding: false,
      cell: ({ row }) => <Cell>{row.original.address}</Cell>,
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
          triggerLabel={`Open actions for allowed recipient ${row.original.address}`}
          actions={[
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: remove.isPending,
              confirm: {
                title: "Remove allowed recipient",
                description:
                  "This prevents the selected email account from sending to this exact address.",
                confirmLabel: "Remove recipient",
                entityLabel: "Recipient",
                itemLabel: `${row.original.accountKey}:${row.original.address}`,
              },
              onSelect: () => remove.mutateAsync(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="text-sm font-semibold">Email send allowlist</h2>
      <DataTableView
        columns={columns}
        response={recipients.data}
        state={table}
        error={recipients.error}
        filters={
          <EmailAccountFilter state={table} accountOptions={accountOptions} />
        }
        isFetching={recipients.isFetching}
        isLoading={recipients.isLoading}
        isPlaceholderData={recipients.isPlaceholderData}
        onRetry={() => void recipients.refetch()}
        rowKey={(row) => `${row.accountKey}:${row.address}`}
        emptyLabel="No allowed email recipients."
        emptyDescription={
          hasEmailAccounts
            ? "Add exact recipient addresses that this agent may send to."
            : "Add an email account before managing send allowlists."
        }
        emptyAction={
          emailAccounts.isLoading ? (
            <Button size="sm" disabled>
              Checking accounts
            </Button>
          ) : hasEmailAccounts ? (
            <Button size="sm" onClick={openAllowedRecipient}>
              <ShieldCheck className="size-4" />
              Add recipient
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => emailSheet.setOpen(true, { context: { agentKey } })}
            >
              <Mail className="size-4" />
              Add email account
            </Button>
          )
        }
        mobileColumnVisibility={mobileHiddenColumns("createdAt")}
        toolbarActions={
          emailAccounts.isLoading ? (
            <Button size="sm" variant="outline" disabled>
              <ShieldCheck className="size-4" />
              Checking accounts
            </Button>
          ) : hasEmailAccounts ? (
            <Button size="sm" onClick={openAllowedRecipient}>
              <ShieldCheck className="size-4" />
              Add recipient
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => emailSheet.setOpen(true, { context: { agentKey } })}
            >
              <Mail className="size-4" />
              Add email account
            </Button>
          )
        }
      />
    </section>
  )

  function openAllowedRecipient() {
    allowSheet.setOpen(true, { context: { agentKey } })
  }
}

export function BindingsPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId?: string
}) {
  const auth = useAuth()
  const bindingSheet = useBindingSheet()
  const discordSheet = useDiscordConnectorSheet()
  const emailSheet = useEmailConnectorSheet()
  const table = useDataTableState(
    sessionId
      ? `agent:${agentKey}:session:${sessionId}:bindings`
      : `agent:${agentKey}:bindings`
  )
  const bindingParams = React.useMemo(
    () => ({ ...table.params, ...(sessionId ? { session_id: sessionId } : {}) }),
    [sessionId, table.params]
  )
  const bindings = useAgentBindings(agentKey, bindingParams)
  const connectorAccounts = useAgentConnectors(
    agentKey,
    {
      page: 1,
      per_page: 100,
      sort_by: "accountKey",
      sort_direction: "asc",
    },
    { staleTime: 30_000 }
  )
  const sessions = useAgentSessions(
    agentKey,
    {
      per_page: 100,
      sort_by: "updatedAt",
      sort_direction: "desc",
    },
    { enabled: !sessionId, staleTime: 30_000 }
  )
  const sessionFilterOptions = React.useMemo(
    () =>
      (sessions.data?.data ?? []).map((session) => ({
        label: sessionPickerLabel(session),
        value: session.id,
      })),
    [sessions.data?.data]
  )
  const hasConnectorAccounts = (connectorAccounts.data?.meta.total ?? 0) > 0
  const connectorPrerequisiteLoading = connectorAccounts.isLoading
  const canBindConversation =
    !connectorPrerequisiteLoading && hasConnectorAccounts
  const remove = useToastMutation({
    mutationFn: (row: BindingRow) =>
      controlApi.deleteBinding(agentKey, row, auth.csrfToken),
    success: "Binding deleted",
    invalidate: controlKeys.agents.detail(agentKey),
  })
  const columns: ColumnDef<BindingRow>[] = [
    {
      accessorKey: "source",
      meta: { label: "Source", maxWidthClassName: "max-w-28" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => <Cell>{humanize(row.original.source)}</Cell>,
    },
    {
      accessorKey: "connectorKey",
      meta: { label: "Connector", maxWidthClassName: "max-w-56" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <Cell highlighted className="font-mono text-xs">
          {row.original.connectorKey}
        </Cell>
      ),
    },
    {
      accessorKey: "externalConversationId",
      meta: { label: "External id", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText
          value={row.original.externalConversationId}
          className="max-w-64 font-mono text-xs"
        />
      ),
    },
    {
      accessorKey: "sessionLabel",
      meta: { label: "Session", maxWidthClassName: "max-w-72" },
      header: renderColumnHeader,
      enableSorting: true,
      cell: ({ row }) => (
        <TruncatedText
          value={sessionReferenceLabel(
            row.original.sessionLabel,
            row.original.sessionId
          )}
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
          triggerLabel={`Open actions for binding ${row.original.externalConversationId}`}
          actions={[
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              pending: remove.isPending,
              confirm: {
                title: "Delete binding",
                description: "Remove this channel binding.",
                confirmLabel: "Delete binding",
                entityLabel: "Channel binding",
                itemLabel: `${row.original.source}:${row.original.connectorKey}:${row.original.externalConversationId}`,
              },
              onSelect: () => remove.mutateAsync(row.original),
            },
          ]}
        />
      ),
    },
  ]

  return (
    <DataTableView
      columns={columns}
      response={bindings.data}
      state={table}
      error={bindings.error}
      filters={
        <BindingFilters
          state={table}
          sessionOptions={sessionId ? undefined : sessionFilterOptions}
        />
      }
      isFetching={bindings.isFetching}
      isLoading={bindings.isLoading}
      isPlaceholderData={bindings.isPlaceholderData}
      onRetry={() => void bindings.refetch()}
      rowKey={(row) =>
        `${row.source}:${row.connectorKey}:${row.externalConversationId}`
      }
      getLink={(row) =>
        `/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(row.sessionId)}`
      }
      emptyLabel={
        sessionId
          ? "No channel bindings for this session."
          : "No channel bindings for this agent."
      }
      emptyDescription={
        hasConnectorAccounts
          ? "Bind an external channel or conversation to a visible session."
          : "Add a connector account before binding an external conversation."
      }
      emptyAction={
        canBindConversation ? (
          <Button size="sm" onClick={openBindConversation}>
            <Plus className="size-4" />
            Bind conversation
          </Button>
        ) : connectorPrerequisiteLoading ? (
          <Button size="sm" disabled>
            Checking connectors
          </Button>
        ) : (
          <ConnectorPrerequisiteActions
            onAddDiscord={() =>
              discordSheet.setOpen(true, { context: { agentKey } })
            }
            onAddEmail={() =>
              emailSheet.setOpen(true, { context: { agentKey } })
            }
          />
        )
      }
      mobileColumnVisibility={mobileHiddenColumns(
        "source",
        "externalConversationId"
      )}
      toolbarActions={
        canBindConversation ? (
          <Button size="sm" onClick={openBindConversation}>
            <Plus className="size-4" />
            Bind conversation
          </Button>
        ) : connectorPrerequisiteLoading ? (
          <Button
            size="sm"
            variant="outline"
            disabled
          >
            <Plus className="size-4" />
            Checking connectors
          </Button>
        ) : (
          <ConnectorAccountCreateMenu
            label="Add connector first"
            variant="outline"
            onAddDiscord={() =>
              discordSheet.setOpen(true, { context: { agentKey } })
            }
            onAddEmail={() =>
              emailSheet.setOpen(true, { context: { agentKey } })
            }
          />
        )
      }
    />
  )

  function openBindConversation() {
    bindingSheet.setOpen(true, {
      context: { agentKey, sessionId },
      defaultData: { sessionId: sessionId ?? "" },
    })
  }
}

function ConnectorPrerequisiteActions({
  onAddDiscord,
  onAddEmail,
}: {
  onAddDiscord: () => void
  onAddEmail: () => void
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" onClick={onAddDiscord}>
        <Plus className="size-4" />
        Add Discord account
      </Button>
      <Button size="sm" variant="outline" onClick={onAddEmail}>
        <Mail className="size-4" />
        Add Email account
      </Button>
    </div>
  )
}

function ConnectorAccountCreateMenu({
  label = "Add account",
  onAddDiscord,
  onAddEmail,
  variant = "default",
}: {
  label?: string
  onAddDiscord: () => void
  onAddEmail: () => void
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant={variant}>
          <Plus className="size-4" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Connector source</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onAddDiscord}>
            <Plug className="size-4" />
            Discord account
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddEmail}>
            <Mail className="size-4" />
            Email account
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ConnectorFilters({ state }: { state: DataTableState }) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="source"
        label="Source"
        allLabel="All sources"
        options={connectorSourceFilterOptions}
        triggerClassName="w-36"
      />
      <TableSelectFilter
        state={state}
        id="status"
        label="Status"
        allLabel="All statuses"
        options={connectorStatusFilterOptions}
        triggerClassName="w-36"
      />
    </>
  )
}

function BindingFilters({
  state,
  sessionOptions,
}: {
  state: DataTableState
  sessionOptions?: Array<{ label: string; value: string }>
}) {
  return (
    <>
      <TableSelectFilter
        state={state}
        id="source"
        label="Source"
        allLabel="All sources"
        options={bindingSourceFilterOptions}
        triggerClassName="w-36"
      />
      {sessionOptions ? (
        <TableSelectFilter
          state={state}
          id="session_id"
          label="Session"
          allLabel="All sessions"
          options={sessionOptions}
          triggerClassName="w-56"
        />
      ) : null}
    </>
  )
}

function ChannelActorPairingFilters({ state }: { state: DataTableState }) {
  return (
    <TableSelectFilter
      state={state}
      id="source"
      label="Source"
      allLabel="All sources"
      options={channelActorSourceFilterOptions}
      triggerClassName="w-40"
    />
  )
}

function EmailAccountFilter({
  accountOptions,
  state,
}: {
  accountOptions: Array<{ label: string; value: string }>
  state: DataTableState
}) {
  if (accountOptions.length === 0) return null
  return (
    <TableSelectFilter
      state={state}
      id="accountKey"
      label="Account"
      allLabel="All accounts"
      options={accountOptions}
      triggerClassName="w-48"
    />
  )
}

function DiscordAccountFilter({
  accountOptions,
  state,
}: {
  accountOptions: Array<{ label: string; value: string }>
  state: DataTableState
}) {
  if (accountOptions.length === 0) return null
  return (
    <TableSelectFilter
      state={state}
      id="accountKey"
      label="Account"
      allLabel="All accounts"
      options={accountOptions}
      triggerClassName="w-48"
    />
  )
}

function ConnectorAccountCell({ connector }: { connector: ConnectorRow }) {
  const detail =
    connector.email?.fromAddress ??
    connector.displayName ??
    connector.externalUsername ??
    connector.connectorKey

  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="truncate font-semibold">{connector.accountKey}</span>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}
