export type ColumnValueType = "text" | "number" | "currency" | "percent" | "date" | "datetime" | "boolean"

type ColumnPresentationMeta = {
  align?: "left" | "center" | "right"
  valueType?: ColumnValueType
}

const rightAlignedValueTypes = new Set<ColumnValueType>(["number", "currency", "percent"])
const tabularValueTypes = new Set<ColumnValueType>(["number", "currency", "percent", "date", "datetime"])

export function getColumnAlign(meta?: ColumnPresentationMeta) {
  if (meta?.align) return meta.align
  if (meta?.valueType && rightAlignedValueTypes.has(meta.valueType)) return "right"
  return "left"
}

export function getColumnValueClassName(meta?: ColumnPresentationMeta) {
  if (meta?.valueType && tabularValueTypes.has(meta.valueType)) return "tabular-nums"
  return undefined
}
