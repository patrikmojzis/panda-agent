import { Spinner } from "@/components/ui/spinner"

type LoadingIndicatorProps = {
  isFetching: boolean
  isLoading: boolean
  isPlaceholderData?: boolean
  hasData: boolean
}

export default function LoadingIndicator({ isFetching, isPlaceholderData }: LoadingIndicatorProps) {
  if (isPlaceholderData && isFetching) {
    return (
      <div className="absolute inset-0 top-10 z-10 flex items-center justify-center gap-2 bg-background/70">
        <Spinner className="size-4" />
        <span className="text-xs text-muted-foreground">Loading data...</span>
      </div>
    )
  }

  return null
}
