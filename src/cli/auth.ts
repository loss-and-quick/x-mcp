#!/usr/bin/env bun
/**
 * Stores the two cookies an x.com session is made of.
 *
 * `auth_token` is httpOnly, `ct0` doubles as the csrf token; both are visible in
 * DevTools: Application -> Cookies -> https://x.com. They are written to
 * ~/.config/x-mcp/credentials.json with 0600 and never printed back.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

import { CONFIG_DIR, CREDENTIALS_FILE, type Credentials, loadCredentials } from "../config.ts";
import { XApi } from "../x/api.ts";
import { XClient } from "../x/client.ts";

async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
    if (!value.trim()) throw new Error("empty value on stdin");
    return value.trim();
  }

  process.stderr.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

function save(credentials: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  chmodSync(CREDENTIALS_FILE, 0o600);
}

async function verify(credentials: Credentials): Promise<void> {
  const api = new XApi(new XClient(credentials));
  const account = await api.sessionUser();
  console.error(
    `authenticated as @${account.username} (${account.followers} followers); ` +
      `rate limit left ${api.client.lastRateLimit?.remaining ?? "?"}/${api.client.lastRateLimit?.limit ?? "?"}`,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");

  if (check) {
    await verify(loadCredentials());
    return;
  }

  console.error("Paste the two cookies of a logged-in x.com tab.");
  console.error("DevTools -> Application -> Cookies -> https://x.com");
  const authToken = await askHidden("auth_token: ");
  const ct0 = await askHidden("ct0: ");
  if (!authToken || !ct0) throw new Error("both cookies are required");

  const credentials: Credentials = { authToken, ct0 };
  await verify(credentials);
  save(credentials);
  console.error(`saved ${CREDENTIALS_FILE} (mode 600)`);
}

main().catch((error: unknown) => {
  console.error(`auth failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
