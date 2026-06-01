import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {useNavigate, useParams} from "@tanstack/react-router";
import {Eye} from "lucide-react";
import {controlApi, type WatchSummary} from "../../lib/api";
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

function kindSummary(watch: WatchSummary) {
  return [watch.sourceKind, watch.detectorKind, watch.observationKind].filter(Boolean).join(" / ") || "—";
}

function latestRunSummary(watch: WatchSummary) {
  if (!watch.latestRun) return "—";
  return `${watch.latestRun.status} · ${formatDate(watch.latestRun.finishedAt ?? watch.latestRun.startedAt ?? watch.latestRun.scheduledFor)}`;
}

export function WatchesLookupPage() {
  const navigate = useNavigate();
  const [agentKey, setAgentKey] = useState("");
  const [sessionId, setSessionId] = useState("");
  function openWatches() {
    if (!agentKey.trim() || !sessionId.trim()) return;
    void navigate({to: "/agents/$agentKey/sessions/$sessionId/watches", params: {agentKey: agentKey.trim(), sessionId: sessionId.trim()}});
  }
  return <Card><CardHeader><CardTitle>Watches</CardTitle><CardDescription>Open a specific agent session watch list in read-only mode.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Session ID" aria-label="Session ID" /><Button onClick={openWatches} disabled={!agentKey.trim() || !sessionId.trim()}><Eye className="size-4" /> Open</Button></CardContent></Card>;
}

export function WatchesPage() {
  const {agentKey, sessionId} = useParams({from: "/app/agents/$agentKey/sessions/$sessionId/watches"});
  const query = useQuery({queryKey: ["control", "watches", agentKey, sessionId], queryFn: () => controlApi.getWatches(agentKey, sessionId)});
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  const watches = query.data?.watches.watches ?? [];
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle>Watches</CardTitle><CardDescription><span className="font-mono break-all">{agentKey}</span> / <span className="font-mono break-all">{sessionId}</span>. Source configs, detector configs, state, errors, and event payloads are hidden.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="rounded-md border p-3 text-sm">Watches: <strong>{watches.length}</strong></div>{watches.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No watches are saved for this session yet.</div> : <div className="max-w-full overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Status</TableHead><TableHead>Kinds</TableHead><TableHead>Interval</TableHead><TableHead>Next poll</TableHead><TableHead>Activity</TableHead></TableRow></TableHeader><TableBody>{watches.map((watch) => <TableRow key={watch.id}><TableCell className="max-w-[18rem] break-words font-medium">{watch.title}</TableCell><TableCell><div className="flex flex-wrap gap-2"><Badge variant={watch.enabled ? "default" : "secondary"}>{watch.enabled ? "Enabled" : "Disabled"}</Badge><Badge variant="secondary">{watch.lifecycleStatus}</Badge></div></TableCell><TableCell className="max-w-[16rem] break-words"><span className="font-mono text-xs">{kindSummary(watch)}</span></TableCell><TableCell>{watch.intervalMinutes} min</TableCell><TableCell className="tabular-nums">{formatDate(watch.nextPollAt)}</TableCell><TableCell className="max-w-[16rem] break-words text-sm text-muted-foreground">Runs: {watch.recentRunCount} · Events: {watch.eventCount}<br />Last: {latestRunSummary(watch)}</TableCell></TableRow>)}</TableBody></Table></div>}</CardContent></Card>;
}
