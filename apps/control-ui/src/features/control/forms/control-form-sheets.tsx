import {
  AgentPairingSheet,
} from "@/features/control/agent/access-form-sheet"
import {
  BindingSheet,
  ChannelActorPairingSheet,
  DiscordActorPairingSheet,
  DiscordConnectorSheet,
  EmailAllowedRecipientSheet,
  EmailConnectorSheet,
  TelegramConnectorSheet,
  EmailRouteSheet,
} from "@/features/control/agent/connector-form-sheets"
import { CredentialSheet } from "@/features/control/agent/credential-form-sheet"
import { WikiBindingSheet } from "@/features/control/agent/wiki-form-sheet"
import {
  SkillSheet,
  SubagentSheet,
} from "@/features/control/agent/skill-form-sheets"
import { GatewayFormSheets } from "@/features/control/gateway/gateway-form-sheets"
import { ControlGrantSheet } from "@/features/control/identity/control-grant-form-sheet"
import { IdentitySheet } from "@/features/control/identity/identity-form-sheet"
import {
  SessionBriefingSheet,
  SessionA2ABindingSheet,
  SessionCreateSheet,
  SessionHeartbeatConfigSheet,
  SessionRuntimeConfigSheet,
  SessionScheduledTaskSheet,
  SessionUpdateSheet,
  SessionWatchConfigSheet,
} from "@/features/control/session/session-form-sheets"

export function ControlFormSheets() {
  return (
    <>
      <SessionCreateSheet />
      <SessionUpdateSheet />
      <SessionRuntimeConfigSheet />
      <SessionBriefingSheet />
      <SessionHeartbeatConfigSheet />
      <SessionA2ABindingSheet />
      <SessionScheduledTaskSheet />
      <SessionWatchConfigSheet />
      <AgentPairingSheet />
      <IdentitySheet />
      <ControlGrantSheet />
      <CredentialSheet />
      <WikiBindingSheet />
      <DiscordConnectorSheet />
      <DiscordActorPairingSheet />
      <ChannelActorPairingSheet />
      <EmailConnectorSheet />
      <TelegramConnectorSheet />
      <BindingSheet />
      <EmailRouteSheet />
      <EmailAllowedRecipientSheet />
      <SkillSheet />
      <SubagentSheet />
      <GatewayFormSheets />
    </>
  )
}
