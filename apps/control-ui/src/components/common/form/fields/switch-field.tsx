import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { useFieldContext } from "@/components/common/form/form-context"
import { fieldErrors } from "@/components/common/form/field-errors"
import { FieldLabelText } from "@/components/common/form/fields/field-label-text"

export function SwitchField({
  label,
  description,
  disabled,
  required,
}: {
  label: string
  description?: string
  disabled?: boolean
  required?: boolean
}) {
  const field = useFieldContext<boolean>()
  const invalid = field.state.meta.errors.length > 0

  return (
    <Field data-invalid={invalid} orientation="horizontal">
      <Switch
        id={field.name}
        name={field.name}
        checked={Boolean(field.state.value)}
        disabled={disabled}
        aria-invalid={invalid}
        aria-required={required || undefined}
        onBlur={field.handleBlur}
        onCheckedChange={(value) => field.handleChange(value)}
      />
      <div className="min-w-0 flex-1">
        <FieldLabel htmlFor={field.name}>
          <FieldLabelText label={label} required={required} />
        </FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <FieldError errors={fieldErrors(field.state.meta.errors)} />
      </div>
    </Field>
  )
}
