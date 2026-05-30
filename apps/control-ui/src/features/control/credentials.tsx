import {useQuery} from "@tanstack/react-query";
import {KeyRound} from "lucide-react";
import {controlApi} from "../../lib/api";
import {Badge} from "../../components/ui/badge";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "../../components/ui/table";
import {EmptyState, ErrorState, PageSkeleton} from "./states";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value));
}

export function CredentialsPage() {
  const query = useQuery({queryKey: ["control", "credentials"], queryFn: controlApi.credentials});
  const data = query.data?.credentials ?? [];
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  if (data.length === 0) return <EmptyState title="No credential metadata visible" description="Credential presence rows will appear here. Secret values and ciphertext are never displayed." />;
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-5" /> Credentials</CardTitle><CardDescription>Presence metadata only. Values, ciphertext, IVs, and tags are intentionally hidden.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><Table className="table-fixed min-w-[760px]"><TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Environment key</TableHead><TableHead>Presence</TableHead><TableHead>Created</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>{data.map((credential) => <TableRow key={`${credential.agentKey}:${credential.envKey}`}><TableCell className="break-all font-mono">{credential.agentKey}</TableCell><TableCell className="break-all font-mono">{credential.envKey}</TableCell><TableCell><Badge>present</Badge></TableCell><TableCell className="tabular-nums text-muted-foreground">{formatDate(credential.createdAt)}</TableCell><TableCell className="tabular-nums text-muted-foreground">{formatDate(credential.updatedAt)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>;
}
