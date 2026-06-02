import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { useFieldContext } from "@/components/common/form/form-context"
import { fieldErrors } from "@/components/common/form/field-errors"
import { FieldLabelText } from "@/components/common/form/fields/field-label-text"

export function TextareaField({
  label,
  description,
  className,
  placeholder,
  required,
}: {
  label: string
  description?: string
  className?: string
  placeholder?: string
  required?: boolean
}) {
  const field = useFieldContext<string>()
  const invalid = field.state.meta.errors.length > 0

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Textarea
        id={field.name}
        name={field.name}
        value={field.state.value ?? ""}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-required={required || undefined}
        required={required}
        className={className}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={fieldErrors(field.state.meta.errors)} />
    </Field>
  )
}
