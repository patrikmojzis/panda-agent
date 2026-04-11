export function assertTelegramConnectorKey(expected: string, actual: string, capability: "outbound" | "typing"): void {
  if (expected === actual) {
    return;
  }

  throw new Error(`Telegram ${capability} connector mismatch. Expected ${expected}, got ${actual}.`);
}
