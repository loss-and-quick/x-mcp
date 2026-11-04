import axios, { type AxiosInstance, isAxiosError } from "axios";

import { type Credentials, loadCredentials, REQUEST_TIMEOUT_MS } from "../config.ts";
import { FIELD_TOGGLES, GQL_FEATURES } from "./features.ts";
import { API_ACCEPT, webHeaders } from "./headers.ts";
import { OPS, type OpName } from "./ops.generated.ts";
import { resetTransaction, transactionFor } from "./txn.ts";

export class XApiError extends Error {
  readonly name: string = "XApiError";
  constructor(
    message: string,
    readonly details?: { status?: number; code?: number; body?: unknown },
  ) {
    super(message);
  }
}

/** The session cookies are gone or revoked. */
export class SessionError extends XApiError {
  override readonly name = "SessionError";
}

/** X rotated a GraphQL query id: the committed ops table needs a refresh. */
export class StaleOpsError extends XApiError {
  override readonly name = "StaleOpsError";
}

export class RateLimitError extends XApiError {
  override readonly name = "RateLimitError";
  constructor(
    message: string,
    readonly retryAt: Date | null,
    readonly limit?: { limit: number; remaining: number; reset: Date | null },
  ) {
    super(message);
  }
}

export type GraphqlRequest = {
  op: OpName;
  method?: "GET" | "POST";
  variables?: Record<string, unknown>;
  features?: Record<string, boolean>;
  fieldToggles?: Record<string, boolean>;
  /** Page the browser would be on when calling this endpoint. */
  referer?: string;
};

export type RateLimitState = {
  limit: number;
  remaining: number;
  reset: Date | null;
};

const DEFAULT_REFERERS: Partial<Record<OpName, string>> = {
  SearchTimeline: "https://x.com/search",
  TweetDetail: "https://x.com/",
  HomeTimeline: "https://x.com/home",
  HomeLatestTimeline: "https://x.com/home",
  Bookmarks: "https://x.com/i/bookmarks",
  Followers: "https://x.com/",
  Following: "https://x.com/",
  UserByScreenName: "https://x.com/",
  UserOriginalsTimeline: "https://x.com/",
  UserTweets: "https://x.com/",
  UserMedia: "https://x.com/",
};

function rateLimitFrom(headers: Record<string, unknown>): RateLimitState | undefined {
  const limit = Number(headers["x-rate-limit-limit"]);
  const remaining = Number(headers["x-rate-limit-remaining"]);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return undefined;
  const resetSeconds = Number(headers["x-rate-limit-reset"]);
  return {
    limit,
    remaining,
    reset: Number.isFinite(resetSeconds) ? new Date(resetSeconds * 1000) : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class XClient {
  private readonly http: AxiosInstance;
  readonly credentials: Credentials;
  /** Rate limit of the most recent response; handy for tool output. */
  lastRateLimit: RateLimitState | null = null;

  constructor(credentials: Credentials = loadCredentials()) {
    this.credentials = credentials;
    this.http = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      transformResponse: [(raw) => raw],
    });
  }

  opId(op: OpName): string {
    const id = OPS[op];
    if (!id) {
      throw new StaleOpsError(
        `GraphQL operation "${op}" is missing from src/x/ops.generated.ts. Run \`bun run ops:update\`.`,
      );
    }
    return id;
  }

  private cookieHeader(): string {
    return `auth_token=${this.credentials.authToken}; ct0=${this.credentials.ct0}`;
  }

  async graphql<T = unknown>(request: GraphqlRequest): Promise<T> {
    const method = request.method ?? "GET";
    const opId = this.opId(request.op);
    const path = `/i/api/graphql/${opId}/${request.op}`;
    const features = { ...GQL_FEATURES, ...(request.features ?? {}) };
    const variables = request.variables ?? {};
    const fieldToggles = request.fieldToggles ??
      FIELD_TOGGLES[request.op] ?? { withArticlePlainText: false };
    const referer = request.referer ?? DEFAULT_REFERERS[request.op] ?? "https://x.com/home";

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const txnId = await transactionFor(method, path);
      const headers = webHeaders({
        ct0: this.credentials.ct0,
        txnId,
        referer,
        json: method === "POST",
      });
      headers.cookie = this.cookieHeader();
      headers.accept = API_ACCEPT;

      const body =
        method === "POST"
          ? {
              variables,
              features,
              ...(Object.keys(fieldToggles).length > 0 ? { fieldToggles } : {}),
              queryId: opId,
            }
          : undefined;
      const params =
        method === "GET"
          ? {
              variables: JSON.stringify(variables),
              features: JSON.stringify(features),
              fieldToggles: JSON.stringify(fieldToggles),
            }
          : undefined;

      try {
        const response = await this.http.request<string>({
          method,
          url: `https://x.com${path}`,
          headers,
          data: body,
          params,
          responseType: "text",
        });

        const status = response.status;
        const rateLimit = rateLimitFrom(response.headers as Record<string, unknown>);
        if (rateLimit) this.lastRateLimit = rateLimit;

        if (status === 401) {
          throw new SessionError(
            "X rejected the session (401). Re-run `bun run auth` with fresh cookies.",
          );
        }
        if (status === 403) {
          // The transaction id is bound to the current web build; rebuild the keys once.
          resetTransaction();
          lastError = new XApiError("X rejected the request (403)", { status });
          if (attempt < 2) {
            await sleep(250 * (attempt + 1));
            continue;
          }
          throw lastError;
        }
        if (status === 404) {
          throw new StaleOpsError(
            `X returned 404 for ${request.op}. The query id is stale: run \`bun run ops:update\` and retry.`,
            { status },
          );
        }
        if (status === 429) {
          throw new RateLimitError(
            `rate limited by X until ${rateLimit?.reset?.toISOString() ?? "an unknown time"}`,
            rateLimit?.reset ?? null,
            rateLimit,
          );
        }
        if (status >= 500) {
          lastError = new XApiError(`X returned ${status}`, { status });
          if (attempt < 2) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw lastError;
        }

        const text = typeof response.data === "string" ? response.data : String(response.data);
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          throw new XApiError(`X returned non-JSON payload for ${request.op}`, {
            status,
            body: text.slice(0, 400),
          });
        }

        const errors = (parsed as { errors?: { message?: string; code?: number }[] }).errors;
        if (Array.isArray(errors) && errors.length > 0) {
          const first = errors[0];
          throw new XApiError(first?.message ?? `GraphQL error on ${request.op}`, {
            status,
            code: first?.code,
            body: errors,
          });
        }

        return parsed as T;
      } catch (error) {
        if (error instanceof XApiError) throw error;
        if (isAxiosError(error)) {
          lastError = new XApiError(`${request.op} failed: ${error.message}`, {
            status: error.response?.status,
          });
          if (attempt < 2) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw lastError;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new XApiError(`${request.op} failed`);
  }
}
