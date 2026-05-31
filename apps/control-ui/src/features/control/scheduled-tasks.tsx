import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {useNavigate, useParams} from "@tanstack/react-router";
import {controlApi, type ScheduledTask, type ScheduledTaskSchedule} from "../../lib/api";
import {Badge} from "../../components/ui/badge";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Input} from "../../components/ui/input";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "../../components/ui/table";
import {ErrorState, PageSkeleton} from "./states";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function scheduleSummary(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "once") return `Once at ${formatDate(schedule.runAt)}`;
  return `${schedule.cron} (${schedule.timezone})`;
}

function lastRunSummary(task: ScheduledTask) {
  const run = task.recentRuns[0];
  if (!run) return "—";
  return `${run.status} · ${formatDate(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}`;
}

export function ScheduledTasksLookupPage() {
  const navigate = useNavigate();
  const [agentKey, setAgentKey] = useState("");
  const [sessionId, setSessionId] = useState("");
  function openScheduledTasks() {
    if (!agentKey.trim() || !sessionId.trim()) return;
    void navigate({to: "/agents/$agentKey/sessions/$sessionId/scheduled-tasks", params: {agentKey: agentKey.trim(), sessionId: sessionId.trim()}});
  }
  return <Card><CardHeader><CardTitle>Scheduled tasks</CardTitle><CardDescription>Open a specific agent session scheduled task list in read-only mode.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Session ID" aria-label="Session ID" /><Button onClick={openScheduledTasks} disabled={!agentKey.trim() || !sessionId.trim()}>Open</Button></CardContent></Card>;
}

export function ScheduledTasksPage() {
  const {agentKey, sessionId} = useParams({from: "/app/agents/$agentKey/sessions/$sessionId/scheduled-tasks"});
  const query = useQuery({queryKey: ["control", "scheduled-tasks", agentKey, sessionId], queryFn: () => controlApi.getScheduledTasks(agentKey, sessionId)});
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  const scheduledTasks = query.data?.scheduledTasks;
  const tasks = scheduledTasks?.tasks ?? [];
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle>Scheduled tasks</CardTitle><CardDescription><span className="font-mono break-all">{agentKey}</span> / <span className="font-mono break-all">{sessionId}</span>. Task instructions are hidden and this view is read-only.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="rounded-md border p-3 text-sm">Tasks: <strong>{tasks.length}</strong></div>{tasks.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No scheduled tasks are saved for this session yet.</div> : <div className="max-w-full overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Status</TableHead><TableHead>Schedule</TableHead><TableHead>Next fire</TableHead><TableHead>Last run</TableHead></TableRow></TableHeader><TableBody>{tasks.map((task) => <TableRow key={task.id}><TableCell className="max-w-[18rem] break-words font-medium">{task.title}</TableCell><TableCell><div className="flex flex-wrap gap-2"><Badge variant={task.enabled ? "default" : "secondary"}>{task.enabled ? "Enabled" : "Disabled"}</Badge><Badge variant="secondary">{task.lifecycleStatus}</Badge></div></TableCell><TableCell className="max-w-[16rem] break-words"><span className="font-mono text-xs">{scheduleSummary(task.schedule)}</span></TableCell><TableCell className="tabular-nums">{formatDate(task.nextFireAt)}</TableCell><TableCell className="max-w-[14rem] break-words text-sm text-muted-foreground">{lastRunSummary(task)}</TableCell></TableRow>)}</TableBody></Table></div>}</CardContent></Card>;
}
