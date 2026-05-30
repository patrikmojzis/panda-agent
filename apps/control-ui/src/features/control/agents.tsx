import {useMemo} from "react";
import {useQuery} from "@tanstack/react-query";
import {createColumnHelper, flexRender, getCoreRowModel, useReactTable} from "@tanstack/react-table";
import {controlApi, type AgentSummary} from "../../lib/api";
import {Badge} from "../../components/ui/badge";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "../../components/ui/table";
import {EmptyState, ErrorState, PageSkeleton} from "./states";

const columnHelper = createColumnHelper<AgentSummary>();

export function AgentsPage() {
  const query = useQuery({queryKey: ["control", "agents"], queryFn: controlApi.agents});
  const columns = useMemo(() => [
    columnHelper.accessor("agentKey", {header: "Agent key", cell: (info) => <span className="font-mono break-all">{info.getValue()}</span>}),
    columnHelper.accessor("displayName", {header: "Display name"}),
    columnHelper.accessor("status", {header: "Status", cell: (info) => <Badge variant="secondary">{info.getValue()}</Badge>}),
    columnHelper.accessor("sessionCount", {header: "Sessions", cell: (info) => <span className="tabular-nums">{info.getValue()}</span>}),
    columnHelper.accessor("paired", {header: "Paired", cell: (info) => <Badge variant={info.getValue() ? "default" : "outline"}>{info.getValue() ? "yes" : "no"}</Badge>}),
  ], []);
  const data = query.data?.agents ?? [];
  const table = useReactTable({data, columns, getCoreRowModel: getCoreRowModel()});
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  if (data.length === 0) return <EmptyState title="No visible agents" description="Agents will appear here after Control grants and identity pairings allow access." />;
  return <Card className="max-w-full overflow-hidden"><CardHeader><CardTitle>Agents</CardTitle><CardDescription>Read-only status and session counts for agents visible to this Control session.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><Table className="table-fixed min-w-[720px]"> <TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>{group.headers.map((header) => <TableHead key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.map((row) => <TableRow key={row.id}>{row.getVisibleCells().map((cell) => <TableCell key={cell.id} className="break-words">{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}</TableBody></Table></CardContent></Card>;
}
