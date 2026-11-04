import { ClientTransaction, fetchXDocument } from "x-client-transaction-id";

/**
 * `x-client-transaction-id` is derived from the current web build (a verification
 * key plus an animation key parsed out of the app shell). Holding one initialized
 * instance is enough for the whole process; X only rejects ids once the build
 * changes, and we rebuild on the first 403.
 */
let instance: ClientTransaction | null = null;
let inflight: Promise<ClientTransaction> | null = null;

async function build(): Promise<ClientTransaction> {
  const document = await fetchXDocument();
  return ClientTransaction.create(document);
}

export async function transactionFor(method: string, path: string): Promise<string> {
  if (!instance) {
    inflight ??= build();
    try {
      instance = await inflight;
    } finally {
      inflight = null;
    }
  }
  return instance.generateTransactionId(method.toUpperCase(), path);
}

export function resetTransaction(): void {
  instance = null;
  inflight = null;
}
