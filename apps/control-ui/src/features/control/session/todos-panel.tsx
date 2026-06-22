import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useSessionTodo } from "@/features/control/api/queries"
import {
  Metric,
  StatusBadge,
} from "@/features/control/control-display"
import {
  DetailField,
  DetailPanel,
  TableError,
} from "@/features/control/detail-primitives"
import { formatDate } from "@/features/control/formatting"
import type { SessionTodo, SessionTodoStatus } from "@/lib/api"

const TODO_STATUSES: SessionTodoStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "done",
]

const TODO_STATUS_LABELS: Record<SessionTodoStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
}

export function TodosPanel({
  agentKey,
  sessionId,
}: {
  agentKey: string
  sessionId: string
}) {
  const query = useSessionTodo(agentKey, sessionId)
  const todo = query.data?.todo
  const items = todo?.items ?? []

  if (!todo && query.error) return <TableError error={query.error} />

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="grid min-w-0 gap-4">
        <div className="border border-dashed bg-muted/10 p-3 text-xs text-muted-foreground">
          <div className="text-sm font-medium text-foreground">
            Runtime Internal State
          </div>
          <p className="mt-1">
            Read-only todo context maintained by the agent via todo_update.
            It is shown for debugging, not as an operator task queue.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <Metric
            label="Items"
            value={
              query.isLoading ? <Skeleton className="h-4 w-8" /> : items.length
            }
          />
          {TODO_STATUSES.map((status) => (
            <Metric
              key={status}
              label={TODO_STATUS_LABELS[status]}
              value={todoCountValue(todo, status, query.isLoading)}
            />
          ))}
        </div>
        <DetailPanel
          title="Internal State: Todo Context"
          action={
            query.isFetching && todo ? (
              <Badge variant="outline">Refreshing</Badge>
            ) : null
          }
        >
          <TodoItemsList loading={query.isLoading && !todo} todo={todo} />
        </DetailPanel>
      </div>
      <DetailPanel title="Todo Context Metadata">
        <div className="grid gap-3">
          <DetailField
            loading={query.isLoading && !todo}
            label="Session"
            value={todo?.sessionId ?? sessionId}
          />
          <DetailField
            loading={query.isLoading && !todo}
            label="Status"
            value={items.length > 0 ? "Populated" : "Empty"}
          />
          <DetailField
            loading={query.isLoading && !todo}
            label="Hash"
            value={
              todo?.itemsHash ? (
                <span className="font-mono text-xs break-all">
                  {todo.itemsHash}
                </span>
              ) : (
                "-"
              )
            }
          />
          <DetailField
            loading={query.isLoading && !todo}
            label="Created"
            value={formatDate(todo?.createdAt)}
          />
          <DetailField
            loading={query.isLoading && !todo}
            label="Updated"
            value={formatDate(todo?.updatedAt)}
          />
        </div>
      </DetailPanel>
    </div>
  )
}

function TodoItemsList({
  loading,
  todo,
}: {
  loading: boolean
  todo?: SessionTodo
}) {
  if (loading) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  const items = todo?.items ?? []
  if (items.length === 0) {
    return (
      <div className="border border-dashed bg-muted/10 p-6 text-sm text-muted-foreground">
        No todo context items are saved for this session.
      </div>
    )
  }

  return (
    <ol className="grid gap-2">
      {items.map((item, index) => (
        <li key={`${index}:${item.status}`} className="border bg-card p-3 text-sm">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
            <div className="shrink-0">
              <StatusBadge status={item.status} />
            </div>
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              {item.content}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function todoCountValue(
  todo: SessionTodo | undefined,
  status: SessionTodoStatus,
  loading: boolean
) {
  if (loading && !todo) return <Skeleton className="h-4 w-8" />
  return todo?.counts[status] ?? 0
}
