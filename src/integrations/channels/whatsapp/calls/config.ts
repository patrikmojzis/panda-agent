import {isJsonObject} from "../../../../lib/json.js";
import type {ConnectorAccountRecord} from "../../../../domain/connectors/types.js";
import type {WhatsAppMetaCallingConfig} from "./types.js";

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{1,32}$/.test(value.trim())) throw new Error(`${label} must contain digits only.`);
  return value.trim();
}

export function parseWhatsAppMetaCallingConfig(account: Pick<ConnectorAccountRecord, "config">): WhatsAppMetaCallingConfig | null {
  if (account.config.mode === undefined) return null;
  if (account.config.mode !== "meta_cloud") throw new Error(`Unsupported WhatsApp connector mode ${String(account.config.mode)}.`);
  if (!isJsonObject(account.config.calling) || account.config.calling.enabled !== true) throw new Error("Meta Cloud WhatsApp account is missing enabled Calling configuration.");
  const graphVersion = account.config.calling.graphVersion;
  if (typeof graphVersion !== "string" || !/^v\d{1,2}\.\d{1,2}$/.test(graphVersion.trim())) throw new Error("WhatsApp Graph version must look like v23.0.");
  return {
    mode: "meta_cloud",
    calling: {
      enabled: true,
      phoneNumberId: requiredId(account.config.calling.phoneNumberId, "WhatsApp phone number id"),
      wabaId: requiredId(account.config.calling.wabaId, "WhatsApp business account id"),
      graphVersion: graphVersion.trim(),
    },
  };
}
