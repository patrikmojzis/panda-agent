import {setTimeout as delay} from "node:timers/promises";

const RECEIPT_ATTEMPTS = 3;

/** Retries only an owned database receipt; external dispatch must already be finished. */
export async function settleChannelReceipt<T extends {status: string; claimToken?: string}>(input: {
  label: string;
  claimToken: string;
  status: "sent" | "failed";
  write(): Promise<T>;
  read(): Promise<T>;
  markUnknown(error: string): Promise<T>;
}): Promise<T> {
  const matches = (receipt: T) => receipt.claimToken === input.claimToken && receipt.status === input.status;
  let lastError: unknown;
  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(attempt * 25);
    try {
      const receipt = await input.write();
      if (matches(receipt)) return receipt;
      lastError = new Error("Receipt no longer belongs to this dispatch.");
    } catch (error) {
      lastError = error;
    }
    try {
      const receipt = await input.read();
      if (matches(receipt)) return receipt;
      if (receipt.claimToken !== input.claimToken) break;
    } catch (error) {
      lastError = error;
    }
  }

  const message = `${input.label} ${input.status} receipt could not be confirmed; outcome requires reconciliation.`;
  // The write itself can lose its acknowledgement too. Never turn a committed
  // success into failure, and never infer transport failure from database failure.
  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(attempt * 25);
    try {
      const receipt = await input.markUnknown(message);
      if (matches(receipt)) return receipt;
      if (receipt.status === "unknown" || receipt.claimToken !== input.claimToken) break;
    } catch (error) {
      lastError = error;
    }
    try {
      const receipt = await input.read();
      if (matches(receipt)) return receipt;
      if (receipt.status === "unknown" || receipt.claimToken !== input.claimToken) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(message, {cause: lastError});
}
