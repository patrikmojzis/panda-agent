const numberFormatter = new Intl.NumberFormat()

export function formatNumber(
  value?: number | null,
  options?: Intl.NumberFormatOptions
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (!options) return numberFormatter.format(value)
  return new Intl.NumberFormat(undefined, options).format(value)
}

export function formatDate(value?: string | null) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

export function formatBytes(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value < 1024) return `${formatNumber(value) ?? value} B`

  const units = ["KB", "MB", "GB", "TB"]
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }

  const formatted = formatNumber(size, {
    maximumFractionDigits: size >= 10 ? 0 : 1,
  })
  return `${formatted ?? size} ${units[index]}`
}

export function formatDuration(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value < 1000) return `${formatNumber(value) ?? value}ms`

  const seconds = value / 1000
  if (seconds < 60) {
    return `${formatNumber(seconds, { maximumFractionDigits: 1 }) ?? seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}
