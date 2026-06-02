import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { useFieldContext } from "@/components/common/form/form-context"
import { fieldErrors } from "@/components/common/form/field-errors"
import { FieldLabelText } from "@/components/common/form/fields/field-label-text"

const EMPTY_COMBOBOX_VALUE = "__control_empty_combobox__"

type ComboboxFieldOption = {
  label: string
  value: string
}

export function ComboboxField({
  label,
  description,
  disabled,
  emptyLabel,
  options,
  placeholder,
  required,
}: {
  label: string
  description?: string
  disabled?: boolean
  emptyLabel?: string
  options: ComboboxFieldOption[]
  placeholder?: string
  required?: boolean
}) {
  const field = useFieldContext<string>()
  const invalid = field.state.meta.errors.length > 0
  const normalizedOptions = emptyLabel
    ? [{ label: emptyLabel, value: EMPTY_COMBOBOX_VALUE }, ...options]
    : options
  const value = field.state.value || (emptyLabel ? EMPTY_COMBOBOX_VALUE : null)

  function optionLabel(value: string) {
    if (value === EMPTY_COMBOBOX_VALUE) return emptyLabel ?? ""
    return options.find((option) => option.value === value)?.label ?? value
  }

  function filterOption(value: string, query: string) {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return true
    return [optionLabel(value), value]
      .some((part) => part.toLowerCase().includes(normalizedQuery))
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Combobox
        items={normalizedOptions.map((option) => option.value)}
        value={value}
        onValueChange={(nextValue) => {
          field.handleChange(nextValue === EMPTY_COMBOBOX_VALUE ? "" : nextValue ?? "")
        }}
        itemToStringLabel={optionLabel}
        filter={filterOption}
        disabled={disabled}
        required={required}
        name={field.name}
        id={field.name}
        autoHighlight
      >
        <ComboboxInput
          id={field.name}
          className="w-full"
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={invalid}
          aria-required={required || undefined}
          showClear={Boolean(!required && field.state.value)}
          onBlur={field.handleBlur}
        />
        <ComboboxContent>
          <ComboboxEmpty>No matching options.</ComboboxEmpty>
          <ComboboxList>
            {normalizedOptions.map((option) => (
              <ComboboxItem key={option.value} value={option.value}>
                <span className="min-w-0 truncate">{option.label}</span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={fieldErrors(field.state.meta.errors)} />
    </Field>
  )
}
