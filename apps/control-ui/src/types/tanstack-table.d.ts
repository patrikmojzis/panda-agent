import type { RowData } from "@tanstack/react-table"
import type { ColumnValueType } from "@/components/common/data-table/ui/column-meta"

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string
    align?: "left" | "center" | "right"
    cellClassName?: string
    highlighted?: boolean
    linkEnabled?: boolean
    maxWidthClassName?: string
    wrap?: boolean
    valueType?: ColumnValueType
  }
}
