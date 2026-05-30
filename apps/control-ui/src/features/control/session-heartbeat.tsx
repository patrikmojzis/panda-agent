import {useEffect, useMemo, useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {useNavigate, useParams} from "@tanstack/react-router";
import {controlApi} from "../../lib/api";
import {useAuth} from "../../lib/auth";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Input} from "../../components/ui/input";
import {ErrorState, PageSkeleton} from "./states";

const MIN_EVERY_MINUTES = 15;

function formatDate(value: string | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function SessionHeartbeatLookupPage() {
  const navigate = useNavigate();
  const [agentKey, setAgentKey] = useState("");
  const [sessionId, setSessionId] = useState("");
  function openHeartbeat() {
    if (!agentKey.trim() || !sessionId.trim()) return;
    void navigate({to: "/agents/$agentKey/sessions/$sessionId/heartbeat", params: {agentKey: agentKey.trim(), sessionId: sessionId.trim()}});
  }
  return <Card><CardHeader><CardTitle>Session heartbeat</CardTitle><CardDescription>Open a specific agent session heartbeat schedule. Changes affect future scheduled wakes only and do not run the agent immediately.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Session ID" aria-label="Session ID" /><Button onClick={openHeartbeat} disabled={!agentKey.trim() || !sessionId.trim()}>Open</Button></CardContent></Card>;
}

export function SessionHeartbeatPage() {
  const {agentKey, sessionId} = useParams({from: "/app/agents/$agentKey/sessions/$sessionId/heartbeat"});
  const auth = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["control", "session-heartbeat", agentKey, sessionId];
  const query = useQuery({queryKey, queryFn: () => controlApi.getSessionHeartbeat(agentKey, sessionId)});
  const [enabled, setEnabled] = useState(false);
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (query.data) {
      setEnabled(query.data.heartbeat.enabled);
      setEveryMinutes(String(query.data.heartbeat.everyMinutes));
    }
  }, [query.data]);
  const parsedMinutes = Number(everyMinutes);
  const invalid = !Number.isInteger(parsedMinutes) || parsedMinutes < MIN_EVERY_MINUTES;
  const unchanged = query.data ? enabled === query.data.heartbeat.enabled && parsedMinutes === query.data.heartbeat.everyMinutes : true;
  const impact = useMemo(() => {
    if (!query.data) return "";
    const current = query.data.heartbeat;
    if (!current.enabled && enabled) return "This will enable future scheduled wakes.";
    if (current.enabled && !enabled) return "This will disable future scheduled wakes.";
    if (parsedMinutes < current.everyMinutes) return "This reduces the cadence, so future scheduled wakes can happen more often.";
    return "This changes future scheduled wakes only.";
  }, [enabled, parsedMinutes, query.data]);
  const save = useMutation({
    mutationFn: () => controlApi.patchSessionHeartbeat(agentKey, sessionId, {enabled, everyMinutes: parsedMinutes}, auth.csrfToken),
    onSuccess: async () => {
      setMessage("Heartbeat updated.");
      await queryClient.invalidateQueries({queryKey});
    },
  });
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  const heartbeat = query.data?.heartbeat;
  const error = save.error?.message ?? null;
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle>Session heartbeat</CardTitle><CardDescription><span className="font-mono break-all">{agentKey}</span> / <span className="font-mono break-all">{sessionId}</span>. Changing heartbeat affects future scheduled wakes; it does not run the agent immediately.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="grid gap-2 rounded-md border p-3 text-sm md:grid-cols-2"><p>Current status: <strong>{heartbeat?.enabled ? "Enabled" : "Disabled"}</strong></p><p>Cadence: <strong>{heartbeat?.everyMinutes ?? "—"} minutes</strong></p><p>Next fire: <span className="tabular-nums">{formatDate(heartbeat?.nextFireAt)}</span></p><p>Last fire: <span className="tabular-nums">{formatDate(heartbeat?.lastFireAt)}</span></p></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable heartbeat</label><div className="grid gap-2"><label className="text-sm font-medium" htmlFor="heartbeat-every">Cadence in minutes</label><Input id="heartbeat-every" type="number" min={MIN_EVERY_MINUTES} step={1} value={everyMinutes} onChange={(event) => setEveryMinutes(event.target.value)} aria-invalid={invalid} />{invalid ? <p role="alert" className="text-sm text-destructive">Cadence must be a whole number of at least {MIN_EVERY_MINUTES} minutes.</p> : null}</div><p className="text-sm text-muted-foreground">Confirmation: Save sends <span className="font-mono">update-heartbeat</span>. {impact}</p>{message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<div className="flex justify-end"><Button onClick={() => save.mutate()} disabled={save.isPending || invalid || unchanged}>Save heartbeat</Button></div></CardContent></Card>;
}
