/**
 * Auto-scraper for X's internal GraphQL operation ids.
 *
 * The web client does not have a stable API: every operation is addressed as
 *   /i/api/graphql/<queryId>/<OperationName>
 * and X rotates the `queryId` hashes whenever it ships a new build. The ids live
 * in the JS bundles, so we reconstruct them the same way a browser does:
 *
 *   1. fetch the responsive-web app shell (works without a session),
 *   2. collect every chunk URL (direct <script> tags plus the webpack chunk maps),
 *   3. download the chunks and read `queryId:"…",operationName:"…"` pairs.
 *
 * Run `bun run ops:update` to rewrite src/x/ops.generated.ts, or `bun run ops:check`
 * to fail when the committed ids are stale (used by CI).
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import axios, { type AxiosInstance } from "axios";

const SHELL_URL = "https://x.com/i/jf/";
const RESPONSIVE_PREFIX = "https://abs.twimg.com/responsive-web/client-web/";
const CHUNK_CONCURRENCY = 16;

const OP_RE = /queryId:"([A-Za-z0-9_-]+)",operationName:"([A-Za-z0-9_]+)"/g;
const HASH_MAP_RE = /(\d+):"([0-9a-f]{7}|[0-9a-f]{16})"/g;
const NAME_MAP_RE = /(\d+):"([^"]+)"/g;
const ABS_JS_RE = /https:\/\/[\w.-]+(?:\/responsive-web\/client-web|\/x-web\/)[\w./~-]+\.js/g;
const RELATIVE_IMPORT_RE = /["'`](\.{1,2}\/[\w./~-]+\.js)["'`]/g;
const CHALLENGE_RE = /\/cdn-cgi\/challenge-platform\//;

export type OpsMap = Record<string, string>;

export type ScrapeResult = {
  ops: OpsMap;
  chunks: string[];
  scrapedAt: string;
};

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Not A(Brand";v="99", "Chromium";v="154"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "upgrade-insecure-requests": "1",
};

function makeHttp(cookies?: { authToken: string; ct0: string }): AxiosInstance {
  const headers: Record<string, string> = { ...BROWSER_HEADERS };
  if (cookies) {
    headers.cookie = `auth_token=${cookies.authToken}; ct0=${cookies.ct0}`;
    // Authenticated sessions are served the real app shell instead of the
    // logged-out one, which is what carries the session-only chunks.
    headers["x-csrf-token"] = cookies.ct0;
  }
  return axios.create({
    timeout: 30_000,
    headers,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
}

/** Every chunk URL referenced by the app shell HTML. */
export function collectChunkUrls(html: string): string[] {
  const urls = new Set<string>();

  for (const m of html.matchAll(ABS_JS_RE)) {
    if (!m[0].includes("/i18n/")) urls.add(m[0]);
  }

  // Legacy webpack build embeds two maps: numeric chunk id -> hash (7 or 16 hex
  // chars) and numeric chunk id -> human readable name. The chunk URL is
  // `<name>.<hash>a.js`.
  const hashes = new Map<string, string>();
  for (const m of html.matchAll(HASH_MAP_RE)) hashes.set(m[1]!, m[2]!);
  const names = new Map<string, string>();
  for (const m of html.matchAll(NAME_MAP_RE)) {
    const value = m[2]!;
    if (!/^(?:[0-9a-f]{7}|[0-9a-f]{16})$/.test(value)) names.set(m[1]!, value);
  }
  for (const [id, hash] of hashes) {
    const name = names.get(id) ?? id;
    if (name.startsWith("i18n/")) continue;
    urls.add(`${RESPONSIVE_PREFIX}${name}.${hash}a.js`);
  }

  return [...urls];
}

function resolveRelative(from: string, spec: string): string | null {
  try {
    return new URL(spec, from).toString();
  } catch {
    return null;
  }
}

function extractOps(body: string, into: OpsMap): void {
  for (const m of body.matchAll(OP_RE)) into[m[2]!] = m[1]!;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchText(http: AxiosInstance, url: string): Promise<string | null> {
  try {
    const res = await http.get<string>(url, {
      headers: { accept: "*/*", "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors" },
      responseType: "text",
      transformResponse: (raw) => raw,
    });
    return typeof res.data === "string" ? res.data : null;
  } catch {
    return null;
  }
}

export type ScrapeOptions = {
  cookies?: { authToken: string; ct0: string };
  log?: (message: string) => void;
};

export async function scrapeOps(options: ScrapeOptions = {}): Promise<ScrapeResult> {
  const log = options.log ?? (() => {});
  const http = makeHttp(options.cookies);

  const shell = await fetchText(http, SHELL_URL);
  if (!shell) throw new Error(`cannot fetch ${SHELL_URL}`);

  const chunkUrls = collectChunkUrls(shell);
  log(`shell: ${shell.length} bytes, ${chunkUrls.length} chunks referenced`);
  // X is behind Cloudflare and ships the challenge script on real pages too, so
  // a challenge page is only a problem when no app chunks came back with it.
  if (chunkUrls.length === 0 && CHALLENGE_RE.test(shell)) {
    throw new Error("X served a Cloudflare challenge instead of the web app");
  }

  const ops: OpsMap = {};
  const fetched: string[] = [];

  // Level 1: everything the shell links directly.
  await mapLimit(chunkUrls, CHUNK_CONCURRENCY, async (url) => {
    const body = await fetchText(http, url);
    if (!body) return;
    fetched.push(url);
    extractOps(body, ops);
  });

  // Level 2: Vite-style relative imports (`./chunk-xxx.js`) inside those chunks.
  const relative = new Set<string>();
  await mapLimit(fetched.slice(), CHUNK_CONCURRENCY, async (url) => {
    const body = await fetchText(http, url);
    if (!body) return;
    for (const m of body.matchAll(RELATIVE_IMPORT_RE)) {
      const resolved = resolveRelative(url, m[1]!);
      if (resolved && !fetched.includes(resolved)) relative.add(resolved);
    }
  });
  log(`level-2 imports: ${relative.size}`);

  await mapLimit([...relative], CHUNK_CONCURRENCY, async (url) => {
    const body = await fetchText(http, url);
    if (body) extractOps(body, ops);
  });

  if (Object.keys(ops).length === 0) {
    throw new Error("no GraphQL operations found in the fetched chunks");
  }

  const sorted: OpsMap = {};
  for (const key of Object.keys(ops).sort()) sorted[key] = ops[key]!;

  return {
    ops: sorted,
    chunks: fetched.map((u) => u.split("/").pop() ?? u).sort(),
    scrapedAt: new Date().toISOString(),
  };
}

export function renderOpsModule(result: ScrapeResult): string {
  const lines = [
    "// Generated by scripts/scrape-ops.ts - do not edit by hand.",
    "// Regenerate with `bun run ops:update` (CI does this on a schedule).",
    `// Scraped at: ${result.scrapedAt}`,
    `// Chunks: ${result.chunks.join(", ")}`,
    "",
    `export const OPS_SCRAPED_AT = ${JSON.stringify(result.scrapedAt)} as const;`,
    "",
    "export const OPS = {",
  ];
  for (const [name, id] of Object.entries(result.ops)) {
    lines.push(`  ${name}: ${JSON.stringify(id)},`);
  }
  lines.push("} as const;", "", "export type OpName = keyof typeof OPS;", "");
  return lines.join("\n");
}

export function opsFromModuleSource(source: string): OpsMap {
  const out: OpsMap = {};
  for (const m of source.matchAll(/^\s{2}([A-Za-z0-9_]+): "([^"]+)",$/gm)) out[m[1]!] = m[2]!;
  return out;
}

function readEnvCookies(): { authToken: string; ct0: string } | undefined {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CSRF_TOKEN;
  return authToken && ct0 ? { authToken, ct0 } : undefined;
}

const OPS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/x/ops.generated.ts",
);

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const result = await scrapeOps({ cookies: readEnvCookies(), log: (m) => console.error(m) });
  const next = renderOpsModule(result);
  console.error(`scraped ${Object.keys(result.ops).length} operations`);

  const current = existsSync(OPS_FILE) ? readFileSync(OPS_FILE, "utf8") : "";

  if (check) {
    const missing = Object.entries(opsFromModuleSource(current)).filter(
      ([name, id]) => result.ops[name] !== id,
    );
    const added = Object.keys(result.ops).filter((n) => !(n in opsFromModuleSource(current)));
    if (missing.length === 0 && added.length === 0) {
      console.error("ops are up to date");
      return;
    }
    console.error(`stale ops: ${missing.length} changed, ${added.length} new`);
    for (const [name, id] of missing) console.error(`  ${name}: ${id} -> ${result.ops[name]}`);
    process.exit(1);
  }

  if (current === next) {
    console.error("ops are up to date, nothing written");
    return;
  }
  await writeFile(OPS_FILE, next, "utf8");
  console.error(`wrote ${path.relative(process.cwd(), OPS_FILE)}`);
}

if (import.meta.main) {
  await main();
}
