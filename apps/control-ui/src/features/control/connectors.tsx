import {useState} from "react";
import {useNavigate, useParams} from "@tanstack/react-router";
import {useQuery} from "@tanstack/react-query";
import {Cable} from "lucide-react";
import {Badge} from "../../components/ui/badge";
import {Button} from "../../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Input} from "../../components/ui/input";
import {Skeleton} from "../../components/ui/skeleton";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "../../components/ui/table";
import {controlApi} from "../../lib/api";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function statusVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "enabled") return "default";
  if (status === "error" || status === "revoked") return "destructive";
  return "secondary";
}

export function ConnectorAccountsLookupPage() {
  const navigate = useNavigate();
  const [agentKey, setAgentKey] = useState("");
  async function openConnectors() {
    await navigate({to: "/agents/$agentKey/connectors", params: {agentKey: agentKey.trim()}});
  }
  return <Card><CardHeader><CardTitle>Connector accounts</CardTitle><CardDescription>Open read-only connector account metadata for an agent. Secret values, config, and metadata are hidden.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[1fr_auto]"><Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="Agent key" aria-label="Agent key" autoFocus /><Button onClick={() => void openConnectors()} disabled={!agentKey.trim()}>Open</Button></CardContent></Card>;
}

export function ConnectorAccountsPage() {
  const {agentKey} = useParams({from: "/app/agents/$agentKey/connectors"});
  const query = useQuery({queryKey: ["connector-accounts", agentKey], queryFn: () => controlApi.getConnectorAccounts(agentKey)});
  if (query.isLoading) return <Skeleton className="h-56" />;
  if (query.isError) return <Card><CardHeader><CardTitle>Connector accounts unavailable</CardTitle></CardHeader><CardContent><p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : "Unable to load connector accounts."}</p></CardContent></Card>;
  const connectors = query.data?.connectors;
  if (!connectors) return null;
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle className="flex items-center gap-2"><Cable className="size-5" /> Connector accounts</CardTitle><CardDescription><span className="font-mono break-all">{agentKey}</span>. Read-only account metadata only; raw config, metadata, and secret values are never shown.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="grid gap-2 rounded-md border p-3 text-sm md:grid-cols-3"><p>Total: <strong>{connectors.summary.total}</strong></p><p>Agent-owned: <strong>{connectors.summary.agentOwned}</strong></p><p>System-owned: <strong>{connectors.summary.systemOwned}</strong></p></div>{connectors.accounts.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No connector accounts are visible for this agent.</div> : <div className="max-w-full overflow-x-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Connector</TableHead><TableHead>Status</TableHead><TableHead>Owner</TableHead><TableHead>External</TableHead><TableHead>Secrets</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>{connectors.accounts.map((account) => <TableRow key={account.id}><TableCell className="max-w-[16rem] break-words"><div className="font-medium">{account.displayName ?? account.accountKey}</div><div className="font-mono text-xs text-muted-foreground break-all">{account.source}/{account.accountKey}</div></TableCell><TableCell className="max-w-[14rem] break-all font-mono text-xs">{account.connectorKey}</TableCell><TableCell><Badge variant={statusVariant(account.status)}>{account.status}</Badge></TableCell><TableCell className="text-sm"><div>{account.ownerKind}</div>{account.ownerAgentKey ? <div className="font-mono text-xs text-muted-foreground break-all">{account.ownerAgentKey}</div> : null}</TableCell><TableCell className="max-w-[14rem] break-words text-sm"><div>{account.externalUsername ?? "—"}</div>{account.externalAccountId ? <div className="font-mono text-xs text-muted-foreground break-all">{account.externalAccountId}</div> : null}</TableCell><TableCell className="max-w-[14rem] break-words text-sm">{account.secretKeys.length === 0 ? "—" : account.secretKeys.map((secret) => <Badge key={secret.secretKey} variant="secondary" className="mr-1 mb-1">{secret.secretKey}</Badge>)}</TableCell><TableCell className="tabular-nums text-sm">{formatDate(account.updatedAt)}</TableCell></TableRow>)}</TableBody></Table></div>}</CardContent></Card>;
}
