import { Activity, Coins, DatabaseZap, RefreshCw } from "lucide-react"
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts"

import { Button } from "@/components/ui/button"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select"
import { useModelCallUsage } from "@/features/control/api/queries"
import { TableError } from "@/features/control/detail-primitives"
import { formatDate } from "@/features/control/formatting"
import type { ModelCallUsageBucket, ModelCallUsageTotals } from "@/lib/api"
import { cn } from "@/lib/utils"

const CACHE_CHART_CONFIG = {
  cacheReadTokens: { label: "Cached tokens", color: "var(--chart-2)" },
  cacheHitPercent: { label: "Hit rate", color: "var(--chart-1)" },
} satisfies ChartConfig

const VOLUME_CHART_CONFIG = {
  totalTokens: { label: "Total tokens", color: "var(--chart-3)" },
  totalCost: { label: "Cost", color: "var(--chart-4)" },
} satisfies ChartConfig

export function ModelUsagePanel({
  bucketMinutes,
  onBucketMinutesChange,
  onRangeHoursChange,
  rangeHours,
}: {
  bucketMinutes: number
  onBucketMinutesChange: (value: number) => void
  onRangeHoursChange: (value: number) => void
  rangeHours: number
}) {
  const usage = useModelCallUsage(
    { bucket_minutes: bucketMinutes, range_hours: rangeHours },
    { staleTime: 30_000 }
  )
  const data = usage.data?.modelCallUsage
  const chartData = data?.buckets.map(chartBucket) ?? []

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-col gap-3 border bg-muted/10 p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium">Cache and spend over time</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Cache hits are calls with provider-reported cache-read tokens. Coverage is the cached share of prompt tokens.
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <UsageSelect
            label="Period"
            value={rangeHours}
            options={[
              { label: "Last 24 hours", value: 24 },
              { label: "Last 7 days", value: 168 },
              { label: "Last 30 days", value: 720 },
            ]}
            onChange={onRangeHoursChange}
          />
          <UsageSelect
            label="Granularity"
            value={bucketMinutes}
            options={[
              { label: "Hourly", value: 60 },
              { label: "Every 6 hours", value: 360 },
              { label: "Daily", value: 1440 },
            ]}
            onChange={onBucketMinutesChange}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void usage.refetch()}
            disabled={usage.isFetching}
          >
            <RefreshCw className={cn("size-4", usage.isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {usage.error && !data ? <TableError error={usage.error} /> : null}
      {data ? (
        <>
          <UsageSummary totals={data.summary} />
          {data.summary.calls > 0 ? (
            <div className="grid min-w-0 gap-4 2xl:grid-cols-2">
              <UsageChartPanel
                title="Cache performance"
                detail="Cached prompt tokens and call-level hit rate"
              >
                <ChartContainer
                  config={CACHE_CHART_CONFIG}
                  className="h-72 w-full aspect-auto"
                  initialDimension={{ width: 640, height: 288 }}
                >
                  <ComposedChart data={chartData} accessibilityLayer margin={{ left: 4, right: 4, top: 8 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={28} />
                    <YAxis
                      yAxisId="tokens"
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      tickFormatter={formatCompact}
                    />
                    <YAxis
                      yAxisId="rate"
                      orientation="right"
                      domain={[0, 100]}
                      tickLine={false}
                      axisLine={false}
                      width={42}
                      tickFormatter={(value) => `${value}%`}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_value, payload) => payload[0]?.payload?.tooltipLabel ?? ""}
                          formatter={(value, name) => (
                            <TooltipRow
                              label={name === "cacheHitPercent" ? "Hit rate" : "Cached tokens"}
                              value={name === "cacheHitPercent" ? `${Number(value).toFixed(1)}%` : formatNumber(Number(value))}
                            />
                          )}
                        />
                      }
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Area
                      yAxisId="tokens"
                      dataKey="cacheReadTokens"
                      type="monotone"
                      fill="var(--color-cacheReadTokens)"
                      fillOpacity={0.22}
                      stroke="var(--color-cacheReadTokens)"
                      strokeWidth={2}
                    />
                    <Line
                      yAxisId="rate"
                      dataKey="cacheHitPercent"
                      type="monotone"
                      stroke="var(--color-cacheHitPercent)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ChartContainer>
              </UsageChartPanel>

              <UsageChartPanel
                title="Token volume and cost"
                detail="Total provider tokens against reported USD cost"
              >
                <ChartContainer
                  config={VOLUME_CHART_CONFIG}
                  className="h-72 w-full aspect-auto"
                  initialDimension={{ width: 640, height: 288 }}
                >
                  <ComposedChart data={chartData} accessibilityLayer margin={{ left: 4, right: 4, top: 8 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={28} />
                    <YAxis
                      yAxisId="tokens"
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      tickFormatter={formatCompact}
                    />
                    <YAxis
                      yAxisId="cost"
                      orientation="right"
                      tickLine={false}
                      axisLine={false}
                      width={54}
                      tickFormatter={(value) => formatUsd(Number(value))}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_value, payload) => payload[0]?.payload?.tooltipLabel ?? ""}
                          formatter={(value, name) => (
                            <TooltipRow
                              label={name === "totalCost" ? "Cost" : "Total tokens"}
                              value={name === "totalCost" ? formatUsd(Number(value)) : formatNumber(Number(value))}
                            />
                          )}
                        />
                      }
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar
                      yAxisId="tokens"
                      dataKey="totalTokens"
                      fill="var(--color-totalTokens)"
                      radius={0}
                    />
                    <Line
                      yAxisId="cost"
                      dataKey="totalCost"
                      type="monotone"
                      stroke="var(--color-totalCost)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ChartContainer>
              </UsageChartPanel>
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center border bg-muted/10 p-8 text-center">
              <div>
                <DatabaseZap className="mx-auto mb-3 size-7 text-muted-foreground" />
                <div className="text-sm font-medium">No model calls in this period</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Choose a longer period or wait for new traces.
                </div>
              </div>
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Showing {formatDate(data.range.from)} to {formatDate(data.range.to)} in {bucketLabel(data.range.bucketMinutes)} buckets.
          </div>
        </>
      ) : (
        <UsageLoading />
      )}
    </div>
  )
}

function UsageSummary({ totals }: { totals: ModelCallUsageTotals }) {
  const promptTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <UsageMetric
        icon={<DatabaseZap className="size-4" />}
        label="Cache coverage"
        value={formatPercent(totals.cacheReadRate)}
        detail={`${formatNumber(totals.cacheReadTokens)} of ${formatNumber(promptTokens)} prompt tokens`}
        accent
      />
      <UsageMetric
        icon={<Activity className="size-4" />}
        label="Cache hit rate"
        value={formatPercent(totals.cacheHitRate)}
        detail={`${formatNumber(totals.cacheHits)} of ${formatNumber(totals.usageCalls)} calls with usage`}
      />
      <UsageMetric label="Cached tokens" value={formatNumber(totals.cacheReadTokens)} detail={`${formatNumber(totals.cacheWriteTokens)} written`} />
      <UsageMetric label="Total tokens" value={formatNumber(totals.totalTokens)} detail={`${formatNumber(totals.outputTokens)} output`} />
      <UsageMetric icon={<Coins className="size-4" />} label="Reported cost" value={formatUsd(totals.totalCost)} detail={`${formatUsd(totals.cacheReadCost)} cache reads`} />
      <UsageMetric label="Calls" value={formatNumber(totals.calls)} detail={`${formatNumber(totals.failures)} failed`} />
    </div>
  )
}

function UsageMetric({
  accent = false,
  detail,
  icon,
  label,
  value,
}: {
  accent?: boolean
  detail: string
  icon?: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className={cn("grid min-w-0 gap-1 border p-3", accent ? "border-primary/40 bg-primary/5" : "bg-muted/10")}>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase">
        {icon}
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function UsageChartPanel({ children, detail, title }: { children: React.ReactNode; detail: string; title: string }) {
  return (
    <section className="min-w-0 border p-3">
      <div className="mb-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      {children}
    </section>
  )
}

function UsageSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string
  onChange: (value: number) => void
  options: Array<{ label: string; value: number }>
  value: number
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <NativeSelect
        aria-label={label}
        value={String(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  )
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-36 items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium tabular-nums">{value}</span>
    </div>
  )
}

function UsageLoading() {
  return (
    <div className="grid min-h-64 place-items-center border text-sm text-muted-foreground" role="status">
      Loading model usage…
    </div>
  )
}

function chartBucket(bucket: ModelCallUsageBucket) {
  return {
    ...bucket,
    cacheHitPercent: bucket.cacheHitRate * 100,
    label: chartTimeLabel(bucket.startedAt),
    tooltipLabel: formatDate(bucket.startedAt) ?? bucket.startedAt,
  }
}

function chartTimeLabel(value: string) {
  const date = new Date(value)
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date)
}

function bucketLabel(minutes: number) {
  if (minutes === 60) return "hourly"
  if (minutes === 1440) return "daily"
  return `${minutes / 60}-hour`
}

function formatPercent(value: number) {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatCompact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function formatUsd(value: number) {
  const maximumFractionDigits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
    minimumFractionDigits: 2,
  }).format(value)
}
