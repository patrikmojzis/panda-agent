import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {useNavigate, useParams} from "@tanstack/react-router";
import {controlApi, type SessionTodoStatus} from "../../lib/api";
import {Badge} from "../../components/ui/badge";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Input} from "../../components/ui/input";
import {ErrorState, PageSkeleton} from "./states";

const STATUS_LABELS: Record<SessionTodoStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_ORDER: SessionTodoStatus[] = ["pending", "in_progress", "blocked", "done"];

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function SessionTodoLookupPage() {
  const navigate = useNavigate();
  const [agentKey, setAgentKey] = useState("");
  const [sessionId, setSessionId] = useState("");
  function openTodos() {
    if (!agentKey.trim() || !sessionId.trim()) return;
    void navigate({to: "/agents/$agentKey/sessions/$sessionId/todos", params: {agentKey: agentKey.trim(), sessionId: sessionId.trim()}});
  }
  return <Card><CardHeader><CardTitle>Session todos</CardTitle><CardDescription>Open a specific agent session todo list in read-only mode.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Session ID" aria-label="Session ID" /><Button onClick={openTodos} disabled={!agentKey.trim() || !sessionId.trim()}>Open</Button></CardContent></Card>;
}

export function SessionTodoPage() {
  const {agentKey, sessionId} = useParams({from: "/app/agents/$agentKey/sessions/$sessionId/todos"});
  const query = useQuery({queryKey: ["control", "session-todos", agentKey, sessionId], queryFn: () => controlApi.getSessionTodo(agentKey, sessionId)});
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  const todo = query.data?.todo;
  const items = todo?.items ?? [];
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle>Session todos</CardTitle><CardDescription><span className="font-mono break-all">{agentKey}</span> / <span className="font-mono break-all">{sessionId}</span>. Todo content is read-only in Control.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="grid gap-2 rounded-md border p-3 text-sm md:grid-cols-3"><p>Items: <strong>{items.length}</strong></p><p>Created: <span className="tabular-nums">{formatDate(todo?.createdAt ?? null)}</span></p><p>Updated: <span className="tabular-nums">{formatDate(todo?.updatedAt ?? null)}</span></p>{todo?.itemsHash ? <p className="break-all md:col-span-3">Hash: <span className="font-mono text-xs">{todo.itemsHash}</span></p> : null}</div>{items.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No todo list has been saved for this session yet.</div> : <div className="grid gap-4">{STATUS_ORDER.map((status) => { const group = items.filter((item) => item.status === status); if (group.length === 0) return null; return <section key={status} className="grid gap-2"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold">{STATUS_LABELS[status]}</h2><Badge variant="secondary">{group.length}</Badge></div><ol className="grid gap-2">{group.map((item, index) => <li key={`${status}-${index}`} className="rounded-md border bg-card p-3 text-sm"><div className="flex flex-wrap items-start gap-2"><Badge>{STATUS_LABELS[item.status]}</Badge><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.content}</p></div></li>)}</ol></section>; })}</div>}</CardContent></Card>;
}
