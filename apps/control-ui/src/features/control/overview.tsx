import {Link} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {AlarmClock, AlertTriangle, Bot, CheckCircle2, HeartPulse, ListTodo, ScrollText, ShieldCheck} from "lucide-react";
import {controlApi, type HomeAttentionItem, type HomeSessionSummary} from "../../lib/api";
import {Badge} from "../../components/ui/badge";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {ErrorState, PageSkeleton} from "./states";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not scheduled";
  return new Date(value).toLocaleString();
}

function attentionVariant(severity: HomeAttentionItem["severity"]): "default" | "secondary" | "destructive" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "default";
  return "secondary";
}

function AttentionCard({item}: {item: HomeAttentionItem}) {
  return <Card className="min-w-0"><CardHeader className="gap-2"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="break-words text-base">{item.sessionLabel}</CardTitle><CardDescription className="break-all">{item.agentKey} / {item.sessionId}</CardDescription></div><Badge variant={attentionVariant(item.severity)}>{item.severity}</Badge></div></CardHeader><CardContent className="grid gap-3 text-sm"><p className="break-words">{item.summary}</p><div className="flex flex-wrap gap-2 text-xs text-muted-foreground">{item.dueAt ? <span>Due {formatDate(item.dueAt)}</span> : null}{item.createdAt ? <span>Seen {formatDate(item.createdAt)}</span> : null}</div><Button asChild size="sm" variant="outline"><Link to={item.targetRoute}>Open</Link></Button></CardContent></Card>;
}

function SessionCard({session}: {session: HomeSessionSummary}) {
  return <Card className="min-w-0"><CardHeader><CardTitle className="break-words text-base">{session.label}</CardTitle><CardDescription className="break-all">{session.agentKey} / {session.sessionId} · {session.kind}</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm"><div className="grid gap-2 sm:grid-cols-2"><div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Heartbeat</p><p className="font-medium">{session.heartbeat.enabled ? "Enabled" : "Disabled"} · every {session.heartbeat.everyMinutes}m</p><p className="break-words text-xs text-muted-foreground">Next: {formatDate(session.heartbeat.nextFireAt)}</p></div><div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Todos</p><p className="font-medium tabular-nums">{session.todoCounts.blocked} blocked · {session.todoCounts.in_progress} active</p><p className="text-xs text-muted-foreground">{session.todoCounts.pending} pending · {session.todoCounts.done} done</p></div></div><div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link to={session.links.todos}><ListTodo className="size-4" /> Todos</Link></Button><Button asChild size="sm" variant="outline"><Link to={session.links.scheduledTasks}><AlarmClock className="size-4" /> Tasks</Link></Button><Button asChild size="sm" variant="outline"><Link to={session.links.heartbeat}><HeartPulse className="size-4" /> Heartbeat</Link></Button></div></CardContent></Card>;
}

export function OverviewPage() {
  const query = useQuery({queryKey: ["control", "home"], queryFn: controlApi.home});
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message="Control Home could not be loaded." />;
  const data = query.data?.home;
  if (!data) return null;

  const healthy = data.status.level === "ok";
  return <div className="grid min-w-0 gap-4">
    <Card className={healthy ? "border-primary/40" : "border-destructive/50"}><CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><div className="min-w-0"><CardTitle className="flex items-center gap-2 text-xl">{healthy ? <CheckCircle2 className="size-5 text-primary" /> : <AlertTriangle className="size-5 text-destructive" />} {healthy ? "Panda looks healthy" : "Panda needs attention"}</CardTitle><CardDescription className="break-words">Generated {formatDate(data.generatedAt)} · {data.scope.role} scope for {data.scope.identityId}</CardDescription></div><Badge variant={healthy ? "default" : "destructive"}>{data.status.level}</Badge></CardHeader><CardContent className="flex flex-wrap gap-2 text-sm text-muted-foreground">{data.status.reasonCodes.length > 0 ? data.status.reasonCodes.map((code) => <Badge key={code} variant="outline">{code}</Badge>) : <span>No urgent issues.</span>}</CardContent></Card>

    <div className="grid gap-4 md:grid-cols-3"><Card><CardHeader><CardDescription>Visible agents</CardDescription><CardTitle className="text-3xl tabular-nums">{data.scope.visibleAgentCount}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Visible sessions</CardDescription><CardTitle className="text-3xl tabular-nums">{data.scope.visibleSessionCount}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Upcoming automations</CardDescription><CardTitle className="text-3xl tabular-nums">{data.upcomingAutomations.length}</CardTitle></CardHeader></Card></div>

    <section className="grid gap-3"><div className="flex items-center gap-2"><ShieldCheck className="size-4" /><h2 className="font-semibold">Attention</h2></div>{data.attentionItems.length > 0 ? <div className="grid gap-3 lg:grid-cols-2">{data.attentionItems.map((item) => <AttentionCard key={item.id} item={item} />)}</div> : <Card><CardHeader><CardTitle>No urgent issues</CardTitle><CardDescription>Blocked todos, failed tasks, overdue automations, and disabled heartbeats will appear here.</CardDescription></CardHeader></Card>}</section>

    <section className="grid gap-3"><div className="flex items-center gap-2"><Bot className="size-4" /><h2 className="font-semibold">Scope</h2></div><Card><CardContent className="grid gap-3 pt-6">{data.scope.agents.length > 0 ? data.scope.agents.map((agent) => <div key={agent.agentKey} className="flex min-w-0 items-center justify-between gap-3 rounded-md border p-3"><div className="min-w-0"><p className="break-words font-medium">{agent.displayName}</p><p className="break-all text-xs text-muted-foreground">{agent.agentKey}</p></div><div className="flex shrink-0 items-center gap-2"><Badge variant={agent.paired ? "secondary" : "outline"}>{agent.paired ? "paired" : "unpaired"}</Badge><span className="text-sm tabular-nums text-muted-foreground">{agent.sessionCount} sessions</span></div></div>) : <p className="text-sm text-muted-foreground">No agents are visible in this Control scope.</p>}</CardContent></Card></section>

    <section className="grid gap-3"><h2 className="font-semibold">Session roster</h2>{data.sessions.length > 0 ? <div className="grid gap-3 xl:grid-cols-2">{data.sessions.map((session) => <SessionCard key={`${session.agentKey}:${session.sessionId}`} session={session} />)}</div> : <Card><CardHeader><CardTitle>No visible sessions</CardTitle><CardDescription>Pair this identity with an agent or use an admin grant to see sessions.</CardDescription></CardHeader></Card>}</section>

    <section className="grid gap-3"><div className="flex items-center gap-2"><AlarmClock className="size-4" /><h2 className="font-semibold">Upcoming automations</h2></div><Card><CardContent className="grid gap-3 pt-6">{data.upcomingAutomations.length > 0 ? data.upcomingAutomations.map((task) => <div key={task.taskId} className="flex min-w-0 flex-col gap-2 rounded-md border p-3 md:flex-row md:items-center md:justify-between"><div className="min-w-0"><p className="break-words font-medium">{task.title}</p><p className="break-all text-xs text-muted-foreground">{task.agentKey} / {task.sessionId} · {task.scheduleKind} · {task.lifecycleStatus}</p></div><Button asChild size="sm" variant="outline"><Link to={task.targetRoute}>{formatDate(task.nextFireAt)}</Link></Button></div>) : <p className="text-sm text-muted-foreground">No scheduled automations are queued for visible sessions.</p>}</CardContent></Card></section>

    <section className="grid gap-3"><div className="flex items-center gap-2"><ScrollText className="size-4" /><h2 className="font-semibold">Recent activity</h2></div><Card><CardContent className="grid gap-3 pt-6">{data.recentActivity.length > 0 ? data.recentActivity.map((event) => <Link key={event.id} to="/audit" className="min-w-0 rounded-md border p-3 hover:bg-secondary"><p className="break-words font-medium">{event.eventType}</p><p className="break-all text-xs text-muted-foreground">{formatDate(event.createdAt)} · {event.identityId ?? "unknown identity"}</p></Link>) : <p className="text-sm text-muted-foreground">No recent Control activity in this scope.</p>}</CardContent></Card></section>
  </div>;
}
