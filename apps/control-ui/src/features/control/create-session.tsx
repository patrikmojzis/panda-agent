import {useState} from "react";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {Link} from "@tanstack/react-router";
import {controlApi} from "../../lib/api";
import {useAuth} from "../../lib/auth";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Input} from "../../components/ui/input";

export function CreateSessionPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [agentKey, setAgentKey] = useState("");
  const [sessionRef, setSessionRef] = useState("");
  const [alias, setAlias] = useState("");
  const [displayName, setDisplayName] = useState("");
  const create = useMutation({
    mutationFn: () => controlApi.createSession(agentKey.trim(), {
      ...(sessionRef.trim() ? {sessionRef: sessionRef.trim()} : {}),
      ...(alias.trim() ? {alias: alias.trim()} : {}),
      ...(displayName.trim() ? {displayName: displayName.trim()} : {}),
    }, auth.csrfToken),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ["control", "home"]}),
        queryClient.invalidateQueries({queryKey: ["control", "agents"]}),
      ]);
    },
  });

  if (auth.session?.role !== "admin") {
    return <Card><CardHeader><CardTitle>Create session</CardTitle><CardDescription>Only Control admins can create sessions.</CardDescription></CardHeader></Card>;
  }

  const created = create.data?.session;
  return <Card><CardHeader><CardTitle>Create session</CardTitle><CardDescription>Create an empty branch session and initial current thread. No briefing or prompt content is added.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="grid gap-3 md:grid-cols-2"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Input value={sessionRef} onChange={(event) => setSessionRef(event.target.value)} placeholder="Optional session ref" aria-label="Session ref" /><Input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="Optional alias" aria-label="Alias" /><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Optional display name" aria-label="Display name" /></div>{create.error ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}{created ? <div role="status" className="rounded-md border bg-secondary/40 p-3 text-sm"><p className="font-medium">Created {created.kind} session</p><p className="mt-1 break-all font-mono text-muted-foreground">{created.sessionId}</p><p className="break-all font-mono text-muted-foreground">Thread {created.threadId}</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" asChild><Link to="/agents/$agentKey/sessions/$sessionId/todos" params={{agentKey: created.agentKey, sessionId: created.sessionId}}>Todos</Link></Button><Button variant="outline" size="sm" asChild><Link to="/agents/$agentKey/sessions/$sessionId/heartbeat" params={{agentKey: created.agentKey, sessionId: created.sessionId}}>Heartbeat</Link></Button><Button variant="outline" size="sm" asChild><Link to="/agents/$agentKey/sessions/$sessionId/briefing" params={{agentKey: created.agentKey, sessionId: created.sessionId}}>Briefing</Link></Button></div></div> : null}<div className="flex justify-end"><Button onClick={() => create.mutate()} disabled={create.isPending || !agentKey.trim()}>{create.isPending ? "Creating…" : "Create session"}</Button></div></CardContent></Card>;
}
