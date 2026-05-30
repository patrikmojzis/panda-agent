import {useEffect, useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {useNavigate, useParams} from "@tanstack/react-router";
import {controlApi} from "../../lib/api";
import {useAuth} from "../../lib/auth";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Input} from "../../components/ui/input";
import {ErrorState, PageSkeleton} from "./states";

export function SessionBriefingLookupPage() {
  const navigate = useNavigate();
  const [agentKey, setAgentKey] = useState("");
  const [sessionId, setSessionId] = useState("");
  function openBriefing() {
    if (!agentKey.trim() || !sessionId.trim()) return;
    void navigate({to: "/agents/$agentKey/sessions/$sessionId/briefing", params: {agentKey: agentKey.trim(), sessionId: sessionId.trim()}});
  }
  return <Card><CardHeader><CardTitle>Session briefing</CardTitle><CardDescription>Open a specific agent session briefing prompt for viewing, editing, or clearing.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Session ID" aria-label="Session ID" /><Button onClick={openBriefing} disabled={!agentKey.trim() || !sessionId.trim()}>Open</Button></CardContent></Card>;
}

export function SessionBriefingPage() {
  const {agentKey, sessionId} = useParams({from: "/app/agents/$agentKey/sessions/$sessionId/briefing"});
  const auth = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["control", "session-briefing", agentKey, sessionId];
  const query = useQuery({queryKey, queryFn: () => controlApi.getSessionBriefing(agentKey, sessionId)});
  const [content, setContent] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (query.data) setContent(query.data.briefing.content);
  }, [query.data]);
  const save = useMutation({
    mutationFn: () => controlApi.putSessionBriefing(agentKey, sessionId, content, auth.csrfToken),
    onSuccess: async () => {
      setMessage("Briefing saved.");
      await queryClient.invalidateQueries({queryKey});
    },
  });
  const clear = useMutation({
    mutationFn: () => controlApi.clearSessionBriefing(agentKey, sessionId, auth.csrfToken),
    onSuccess: async () => {
      setMessage("Briefing cleared.");
      setContent("");
      await queryClient.invalidateQueries({queryKey});
    },
  });
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  const error = save.error?.message ?? clear.error?.message ?? null;
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle>Session briefing</CardTitle><CardDescription><span className="font-mono break-all">{agentKey}</span> / <span className="font-mono break-all">{sessionId}</span>. Edits update only the fixed session briefing prompt slug.</CardDescription></CardHeader><CardContent className="grid gap-4"><textarea className="min-h-80 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Write the session briefing..." aria-label="Session briefing content" />{message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => { if (window.confirm("Clear this session briefing?")) clear.mutate(); }} disabled={clear.isPending || save.isPending}>Clear</Button><Button onClick={() => save.mutate()} disabled={save.isPending || clear.isPending || !content.trim()}>Save</Button></div></CardContent></Card>;
}
