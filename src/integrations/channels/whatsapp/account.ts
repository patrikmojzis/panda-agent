export interface WhatsAppWhoamiResult {
  connectorKey: string;
  registered: boolean;
  accountId?: string;
  phoneNumber?: string;
  name?: string;
}

export interface WhatsAppPairResult extends WhatsAppWhoamiResult {
  pairingCode?: string;
  alreadyPaired: boolean;
}

export interface WhatsAppAccountCreds {
  registered?: boolean;
  me?: {
    id?: string;
    phoneNumber?: string;
    name?: string;
    notify?: string;
  };
}

function describeAccountId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function toWhatsAppWhoamiResult(
  connectorKey: string,
  creds: WhatsAppAccountCreds,
): WhatsAppWhoamiResult {
  const registered = creds.registered === true;
  const accountId = registered ? describeAccountId(creds.me?.id) : undefined;
  return {
    connectorKey,
    registered,
    accountId,
    phoneNumber: registered ? creds.me?.phoneNumber?.trim() || undefined : undefined,
    name: registered ? creds.me?.name?.trim() || creds.me?.notify?.trim() || undefined : undefined,
  };
}
