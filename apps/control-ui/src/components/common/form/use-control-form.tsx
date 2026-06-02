import { createFormHook } from "@tanstack/react-form"

import { ComboboxField } from "@/components/common/form/fields/combobox-field"
import { fieldContext, formContext } from "@/components/common/form/form-context"
import { MultiSelectField } from "@/components/common/form/fields/multi-select-field"
import { SelectField } from "@/components/common/form/fields/select-field"
import { SwitchField } from "@/components/common/form/fields/switch-field"
import { TextareaField } from "@/components/common/form/fields/textarea-field"
import { TextField } from "@/components/common/form/fields/text-field"

export const { useAppForm: useControlForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    ComboboxField,
    MultiSelectField,
    SelectField,
    SwitchField,
    TextareaField,
    TextField,
  },
  formComponents: {},
})
