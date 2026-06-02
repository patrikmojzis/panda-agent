import { Skeleton } from "@/components/ui/skeleton"

export function ScreenSkeleton() {
  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r bg-sidebar p-4 sm:block">
        <div className="mb-6 flex items-center justify-between">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="size-8" />
        </div>
        <div className="grid gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
        <div className="mt-8 grid gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-5/6" />
          <Skeleton className="h-7 w-4/5" />
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <div className="grid gap-6">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-9 w-28" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      </main>
    </div>
  )
}
