import type * as React from "react"

import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { useFieldContext } from "@/components/common/form/form-context"
import { fieldErrors } from "@/components/common/form/field-errors"
import { FieldLabelText } from "@/components/common/form/fields/field-label-text"

export function TextField({
  label,
  description,
  type = "text",
  autoFocus,
  autoComplete,
  disabled,
  inputMode,
  min,
  placeholder,
  required,
  step,
}: {
  label: string
  autoComplete?: string
  description?: string
  type?: "text" | "password" | "number" | "datetime-local"
  autoFocus?: boolean
  disabled?: boolean
  inputMode?: React.ComponentProps<typeof Input>["inputMode"]
  min?: number
  placeholder?: string
  required?: boolean
  step?: number
}) {
  const field = useFieldContext<string>()
  const invalid = field.state.meta.errors.length > 0

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Input
        id={field.name}
        name={field.name}
        type={type}
        value={field.state.value ?? ""}
        autoComplete={autoComplete ?? (type === "password" ? "new-password" : undefined)}
        autoFocus={autoFocus}
        disabled={disabled}
        inputMode={inputMode}
        min={min}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-required={required || undefined}
        required={required}
        step={step}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={fieldErrors(field.state.meta.errors)} />
    </Field>
  )
}
