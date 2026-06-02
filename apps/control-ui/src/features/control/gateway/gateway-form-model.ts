import { create } from "zustand"

import type {
  GatewayEventTypeRow,
  GatewaySourceRow,
} from "@/lib/api"
import type {
  FormCreateSheetState,
  FormUpdateSheetState,
} from "@/types/entity-form-sheet-types"
import type { AgentSheetContext } from "@/features/control/forms/use-control-form-sheets"

export type GatewaySourceFormValues = {
  sourceId: string
  name: string
  sessionId: string
}

export type GatewayDeviceFormValues = {
  sourceId: string
  deviceId: string
  label: string
  capabilities: string[]
}

export type GatewayEventTypeFormValues = {
  sourceId: string
  type: string
  delivery: string
}

function createGatewayFormSheetStore<TForm>() {
  return create<FormCreateSheetState<TForm, AgentSheetContext>>((set) => ({
    isOpen: false,
    setOpen: (isOpen, options) =>
      set({
        context: isOpen ? options?.context : undefined,
        defaultData: isOpen ? options?.defaultData : undefined,
        isOpen,
      }),
  }))
}

function createGatewayUpdateFormSheetStore<TEntity, TForm>() {
  return create<FormUpdateSheetState<TEntity, TForm, AgentSheetContext>>(
    (set) => ({
      isOpen: false,
      setOpen: (isOpen, options) =>
        set({
          context: isOpen ? options?.context : undefined,
          defaultData: isOpen ? options?.defaultData : undefined,
          entity: isOpen ? options?.entity : undefined,
          isOpen,
        }),
    })
  )
}

export const useGatewaySourceSheet =
  createGatewayUpdateFormSheetStore<GatewaySourceRow, GatewaySourceFormValues>()
export const useGatewayDeviceSheet =
  createGatewayFormSheetStore<GatewayDeviceFormValues>()
export const useGatewayEventTypeSheet =
  createGatewayUpdateFormSheetStore<
    GatewayEventTypeRow,
    GatewayEventTypeFormValues
  >()

export const useGatewayOneTimeSecretStore = create<{
  latestDeviceToken: string | null
  latestSourceSecret: string | null
  setLatestDeviceToken: (token: string | null) => void
  setLatestSourceSecret: (secret: string | null) => void
}>((set) => ({
  latestDeviceToken: null,
  latestSourceSecret: null,
  setLatestDeviceToken: (latestDeviceToken) => set({ latestDeviceToken }),
  setLatestSourceSecret: (latestSourceSecret) => set({ latestSourceSecret }),
}))

export const gatewaySourceDefaults: GatewaySourceFormValues = {
  name: "",
  sessionId: "",
  sourceId: "",
}

export const gatewayDeviceDefaults: GatewayDeviceFormValues = {
  capabilities: ["push_context", "upload_attachments"],
  deviceId: "",
  label: "",
  sourceId: "",
}

export const gatewayEventTypeDefaults: GatewayEventTypeFormValues = {
  delivery: "queue",
  sourceId: "",
  type: "",
}

export function gatewaySourceToFormValues(
  source: GatewaySourceRow
): GatewaySourceFormValues {
  return {
    name: source.name ?? "",
    sessionId: source.sessionId ?? "",
    sourceId: source.sourceId,
  }
}

export function gatewayEventTypeToFormValues(
  eventType: GatewayEventTypeRow
): GatewayEventTypeFormValues {
  return {
    delivery: eventType.delivery,
    sourceId: eventType.sourceId,
    type: eventType.type,
  }
}

function blankToUndefined(value: string) {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function gatewaySourcePayload(values: GatewaySourceFormValues) {
  return {
    name: blankToUndefined(values.name),
    sessionId: blankToUndefined(values.sessionId),
    sourceId: values.sourceId.trim(),
  }
}

export function gatewayDevicePayload(values: GatewayDeviceFormValues) {
  return {
    capabilities: values.capabilities
      .map((value) => value.trim())
      .filter(Boolean),
    deviceId: values.deviceId.trim(),
    label: blankToUndefined(values.label),
  }
}

export function gatewayEventTypePayload(values: GatewayEventTypeFormValues) {
  return {
    delivery: values.delivery === "wake" ? "wake" : "queue",
    type: values.type.trim(),
  }
}
