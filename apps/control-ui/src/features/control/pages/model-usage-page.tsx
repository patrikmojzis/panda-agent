import { useSearchParams } from "react-router-dom"

import { PageHeader } from "@/components/common/shared/page-layout"
import { ModelUsagePanel } from "@/features/control/model-calls/model-usage-panel"

const RANGE_HOURS = new Set([24, 168, 720])
const BUCKET_MINUTES = new Set([60, 360, 1440])

function ModelUsagePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rangeHours = numericOption(searchParams.get("range"), RANGE_HOURS, 168)
  const bucketMinutes = numericOption(searchParams.get("bucket"), BUCKET_MINUTES, 360)

  function updateWindow(next: { bucketMinutes?: number; rangeHours?: number }) {
    const params = new URLSearchParams(searchParams)
    const nextRange = next.rangeHours ?? rangeHours
    const nextBucket = next.bucketMinutes ?? bucketMinutes
    if (nextRange === 168) params.delete("range")
    else params.set("range", String(nextRange))
    if (nextBucket === 360) params.delete("bucket")
    else params.set("bucket", String(nextBucket))
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="min-w-0">
      <PageHeader title="Model Usage" eyebrow="Control" />
      <ModelUsagePanel
        bucketMinutes={bucketMinutes}
        rangeHours={rangeHours}
        onBucketMinutesChange={(value) => updateWindow({ bucketMinutes: value })}
        onRangeHoursChange={(value) => updateWindow({ rangeHours: value })}
      />
    </div>
  )
}

function numericOption(value: string | null, options: Set<number>, fallback: number) {
  const parsed = Number(value)
  return options.has(parsed) ? parsed : fallback
}

export { ModelUsagePage }
export default ModelUsagePage
