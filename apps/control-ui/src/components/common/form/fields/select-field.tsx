import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useFieldContext } from "@/components/common/form/form-context"
import { fieldErrors } from "@/components/common/form/field-errors"
import { FieldLabelText } from "@/components/common/form/fields/field-label-text"

const EMPTY_SELECT_VALUE = "__control_empty_select__"

export function SelectField({
  label,
  description,
  disabled,
  emptyLabel,
  onValueChange,
  options,
  placeholder,
  required,
}: {
  label: string
  description?: string
  disabled?: boolean
  emptyLabel?: string
  onValueChange?: (value: string) => void
  options: Array<{ label: string; value: string }>
  placeholder?: string
  required?: boolean
}) {
  const field = useFieldContext<string>()
  const invalid = field.state.meta.errors.length > 0
  const value = emptyLabel ? field.state.value || EMPTY_SELECT_VALUE : field.state.value || ""

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Select
        disabled={disabled}
        name={field.name}
        required={required}
        value={value}
        onValueChange={(nextValue) => {
          const normalizedValue = nextValue === EMPTY_SELECT_VALUE ? "" : nextValue
          field.handleChange(normalizedValue)
          onValueChange?.(normalizedValue)
        }}
      >
        <SelectTrigger id={field.name} aria-invalid={invalid} aria-required={required || undefined} onBlur={field.handleBlur}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {emptyLabel ? <SelectItem value={EMPTY_SELECT_VALUE}>{emptyLabel}</SelectItem> : null}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={fieldErrors(field.state.meta.errors)} />
    </Field>
  )
}
