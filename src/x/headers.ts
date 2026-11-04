import { DEFAULT_LANGUAGE } from "../config.ts";

/**
 * The bearer the web client ships in its bundle. It is public and identical for
 * every browser session; the session itself is proven by cookies + csrf token.
 */
export const WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const CHROME_VERSION = "154";

export const USER_AGENT =
  process.env.X_MCP_USER_AGENT ??
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

export type HeaderContext = {
  /** `ct0` cookie value; X requires it as the csrf header too. */
  ct0: string;
  /** Freshly generated per request. */
  txnId: string;
  /** Page the web client would be on when issuing this call. */
  referer: string;
  /** JSON body expected (POST). */
  json?: boolean;
};

/**
 * Header set of the real web client. Every header below is one Chrome sends for
 * an in-page XHR on x.com, so the request is indistinguishable from the app's own.
 */
export function webHeaders(ctx: HeaderContext): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "*/*",
    "accept-language": `${DEFAULT_LANGUAGE}-${DEFAULT_LANGUAGE.toUpperCase()},${DEFAULT_LANGUAGE};q=0.9`,
    authorization: `Bearer ${WEB_BEARER}`,
    cookie: "",
    origin: "https://x.com",
    priority: "u=1, i",
    referer: ctx.referer,
    "sec-ch-ua": `"Not A(Brand";v="99", "Chromium";v="${CHROME_VERSION}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": USER_AGENT,
    "x-client-transaction-id": ctx.txnId,
    "x-csrf-token": ctx.ct0,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": DEFAULT_LANGUAGE,
  };
  if (ctx.json) headers["content-type"] = "application/json";
  return headers;
}

/** The web client asks for JSON thrice: xhr, json, json. */
export const API_ACCEPT = "application/json, text/plain, */*";
