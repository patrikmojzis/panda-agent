import {useQuery} from "@tanstack/react-query";
import {ScrollText} from "lucide-react";
import {controlApi, type AuditEventSummary} from "../../lib/api";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "../../components/ui/table";
import {EmptyState, ErrorState, PageSkeleton} from "./states";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value));
}

function formatMetadata(event: AuditEventSummary): string {
  const entries = Object.entries(event.metadata);
  if (entries.length === 0) return "—";
  return JSON.stringify(event.metadata);
}

export function AuditEventsPage() {
  const query = useQuery({queryKey: ["control", "audit-events"], queryFn: () => controlApi.auditEvents({limit: 50})});
  const data = query.data?.auditEvents ?? [];
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  if (data.length === 0) return <EmptyState title="No audit events visible" description="Login, logout, and Control mutation events visible to your session will appear here." />;
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle className="flex items-center gap-2"><ScrollText className="size-5" /> Audit events</CardTitle><CardDescription>Read-only sanitized audit trail. Metadata is summarized and does not include private prompt content, tokens, or credential values.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><Table className="table-fixed min-w-[920px]"><TableHeader><TableRow><TableHead>Created</TableHead><TableHead>Event</TableHead><TableHead>Identity</TableHead><TableHead>Session</TableHead><TableHead>Summary</TableHead></TableRow></TableHeader><TableBody>{data.map((event) => <TableRow key={event.id}><TableCell className="w-48 tabular-nums text-muted-foreground">{formatDate(event.createdAt)}</TableCell><TableCell className="w-56 break-all font-mono">{event.eventType}</TableCell><TableCell className="w-48 break-all font-mono text-muted-foreground">{event.identityId ?? "—"}</TableCell><TableCell className="w-48 break-all font-mono text-muted-foreground">{event.sessionId ?? "—"}</TableCell><TableCell className="break-words font-mono text-xs">{formatMetadata(event)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>;
}
