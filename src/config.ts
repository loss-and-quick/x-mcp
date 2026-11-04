import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type Credentials = {
  /** `auth_token` cookie: the session itself. */
  authToken: string;
  /** `ct0` cookie: also sent as the `x-csrf-token` header. */
  ct0: string;
};

export const CONFIG_DIR = process.env.X_MCP_HOME ?? path.join(homedir(), ".config", "x-mcp");
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

export class ConfigError extends Error {}

/** Credentials come from the environment first, then from the config file. */
export function loadCredentials(): Credentials {
  const envAuth = process.env.X_AUTH_TOKEN;
  const envCt0 = process.env.X_CSRF_TOKEN;
  if (envAuth && envCt0) return { authToken: envAuth, ct0: envCt0 };

  if (existsSync(CREDENTIALS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as Partial<Credentials>;
      if (typeof parsed.authToken === "string" && typeof parsed.ct0 === "string") {
        return { authToken: parsed.authToken, ct0: parsed.ct0 };
      }
    } catch (error) {
      throw new ConfigError(`${CREDENTIALS_FILE} is not valid JSON: ${String(error)}`);
    }
  }

  throw new ConfigError(
    `no X session found. Run \`bun run auth\` once, or set X_AUTH_TOKEN and X_CSRF_TOKEN ` +
      `(the auth_token and ct0 cookies of a logged-in x.com tab). Expected file: ${CREDENTIALS_FILE}`,
  );
}

/**
 * Write tools are enabled by default because the server is meant to be usable
 * with a full tool set. Set X_MCP_READONLY=1 to expose read tools only.
 */
export function writesEnabled(): boolean {
  return process.env.X_MCP_READONLY !== "1";
}

export const DEFAULT_LANGUAGE = process.env.X_MCP_LANGUAGE ?? "en";

/** Optional HTTP(S) proxy for every request, in axios notation. */
export const PROXY_URL = process.env.HTTPS_PROXY ?? process.env.https_proxy;

/** Per-request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = Number(process.env.X_MCP_TIMEOUT_MS ?? 30_000);
