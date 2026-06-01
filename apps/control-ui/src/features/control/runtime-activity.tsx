import {useState} from "react";
import {useParams, useNavigate} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {Activity} from "lucide-react";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Input} from "../../components/ui/input";
import {Skeleton} from "../../components/ui/skeleton";
import {Badge} from "../../components/ui/badge";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "../../components/ui/table";
import {controlApi} from "../../lib/api";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "running") return "default";
  return "secondary";
}

export function RuntimeActivityLookupPage() {
  const navigate = useNavigate();
  const [agentKey, setAgentKey] = useState("");
  const [sessionId, setSessionId] = useState("");
  async function openActivity() {
    await navigate({to: "/agents/$agentKey/sessions/$sessionId/runtime-activity", params: {agentKey: agentKey.trim(), sessionId: sessionId.trim()}});
  }
  return <Card><CardHeader><CardTitle>Runtime activity</CardTitle><CardDescription>Open recent run status for a specific agent session. Transcripts, tool output, and raw errors are hidden.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Session ID" aria-label="Session ID" /><Button onClick={() => void openActivity()} disabled={!agentKey.trim() || !sessionId.trim()}>Open</Button></CardContent></Card>;
}

export function RuntimeActivityPage() {
  const {agentKey, sessionId} = useParams({from: "/app/agents/$agentKey/sessions/$sessionId/runtime-activity"});
  const query = useQuery({queryKey: ["runtime-activity", agentKey, sessionId], queryFn: () => controlApi.getRuntimeActivity(agentKey, sessionId)});
  if (query.isLoading) return <Skeleton className="h-56" />;
  if (query.isError) return <Card><CardHeader><CardTitle>Runtime activity unavailable</CardTitle></CardHeader><CardContent><p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : "Unable to load runtime activity."}</p></CardContent></Card>;
  const activity = query.data?.runtimeActivity;
  if (!activity) return null;
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle className="flex items-center gap-2"><Activity className="size-5" /> Runtime activity</CardTitle><CardDescription><span className="font-mono break-all">{agentKey}</span> / <span className="font-mono break-all">{sessionId}</span>. This view is read-only and hides transcripts, tool inputs/results, stdout/stderr, and raw errors.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="grid gap-2 rounded-md border p-3 text-sm md:grid-cols-3"><p>Running: <strong>{activity.summary.running}</strong></p><p>Completed: <strong>{activity.summary.completed}</strong></p><p>Failed: <strong>{activity.summary.failed}</strong></p><p>Latest start: <span className="tabular-nums">{formatDate(activity.summary.latestStartedAt)}</span></p><p>Latest finish: <span className="tabular-nums">{formatDate(activity.summary.latestFinishedAt)}</span></p></div>{activity.runs.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No runtime runs are recorded for this session yet.</div> : <div className="max-w-full overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead>Finished</TableHead><TableHead>Duration</TableHead><TableHead>Abort requested</TableHead><TableHead>Failure category</TableHead></TableRow></TableHeader><TableBody>{activity.runs.map((run) => <TableRow key={run.id}><TableCell><Badge variant={statusVariant(run.status)}>{run.status}</Badge></TableCell><TableCell className="tabular-nums">{formatDate(run.startedAt)}</TableCell><TableCell className="tabular-nums">{formatDate(run.finishedAt)}</TableCell><TableCell>{formatDuration(run.durationMs)}</TableCell><TableCell className="tabular-nums">{formatDate(run.abortRequestedAt)}</TableCell><TableCell className="max-w-[16rem] break-words text-sm text-muted-foreground">{run.failureCategory ?? "—"}</TableCell></TableRow>)}</TableBody></Table></div>}</CardContent></Card>;
}
