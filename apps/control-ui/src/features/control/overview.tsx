import {useQuery} from "@tanstack/react-query";
import {Bot, KeyRound, PlayCircle, Users} from "lucide-react";
import {controlApi} from "../../lib/api";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {ErrorState, PageSkeleton} from "./states";

const cards = [
  {key: "agents", label: "Active agents", icon: Bot},
  {key: "sessions", label: "Sessions", icon: Users},
  {key: "runningRuns", label: "Running runs", icon: PlayCircle},
  {key: "credentialsPresent", label: "Credential entries", icon: KeyRound},
] as const;

export function OverviewPage() {
  const query = useQuery({queryKey: ["control", "overview"], queryFn: controlApi.overview});
  if (!query.data && query.isLoading) return <PageSkeleton />;
  if (!query.data && query.error) return <ErrorState message={query.error.message} />;
  const data = query.data;
  if (!data) return null;
  return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{cards.map(({key, label, icon: Icon}) => <Card key={key}><CardHeader className="flex flex-row items-center justify-between gap-2 pb-2"><CardDescription>{label}</CardDescription><Icon className="size-4 text-muted-foreground" /></CardHeader><CardContent><CardTitle className="text-3xl tabular-nums">{data[key]}</CardTitle></CardContent></Card>)}</div>;
}
