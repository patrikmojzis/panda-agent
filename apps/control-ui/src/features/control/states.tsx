import {AlertTriangle} from "lucide-react";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../../components/ui/card";
import {Skeleton} from "../../components/ui/skeleton";

export function PageSkeleton() {
  return <div className="grid gap-4"><Skeleton className="h-24" /><Skeleton className="h-80" /></div>;
}

export function EmptyState({title, description}: {title: string; description: string}) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card>;
}

export function ErrorState({message}: {message: string}) {
  return <Card className="border-destructive/60"><CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="size-5" /> Unable to load Control data</CardTitle><CardDescription role="alert">{message}</CardDescription></CardHeader><CardContent className="text-sm text-muted-foreground">Check that Panda Control is enabled and your session is still valid.</CardContent></Card>;
}
