# x-mcp

An MCP server for X (x.com) that drives **the web client's own internal API** —
the GraphQL endpoints `x.com` calls in your browser — with your own logged-in
session. No developer account, no paid tier, no scraping HTML.

Not affiliated with X Corp. Use a session you are willing to lose.

## How it works

1. **Mimics the web client.** Every request is a byte-for-byte copy of what
   Chrome sends from an x.com tab: the same public bearer token, the same
   header set (`x-csrf-token`, `x-client-transaction-id`, `x-twitter-auth-type`,
   client hints), the same `features`/`fieldToggles` maps, same referers.
   `x-client-transaction-id` — the per-request value X validates against its
   current build — is generated with
   [x-client-transaction-id](https://github.com/Lqm1/x-client-transaction-id).
2. **Auto-scrapes operation ids.** X addresses every GraphQL call as
   `/i/api/graphql/<queryId>/<OperationName>` and rotates the ids with each
   build. `scripts/scrape-ops.ts` rebuilds the whole map (chunk URLs from the
   app shell's webpack maps → download chunks → parse `queryId:"…",
   operationName:"…"` pairs) into `src/x/ops.generated.ts`. A scheduled
   workflow commits the refresh twice a day, and `bun run ops:check` in CI
   fails the build the moment the committed ids drift.
3. **Session = two cookies.** `auth_token` and `ct0` of a logged-in tab, stored
   in `~/.config/x-mcp/credentials.json` (0600) or supplied via env.

## Setup

Requirements: Node.js ≥ 22.6 or [Bun](https://bun.sh) ≥ 1.2.

```bash
npm install             # Node
# or: bun install

# store your session cookies (hidden prompts, never echoed)
bun run auth            # Bun
# Node 22.6+: node --experimental-strip-types src/cli/auth.ts
```

Get the cookies from any logged-in x.com tab:
DevTools → Application → Cookies → `https://x.com` → copy `auth_token` and `ct0`.

`auth` verifies the session against X and prints the account handle before
saving anything.

## Run

```bash
bun start                 # Bun source runner
npm run build
node dist/index.js        # Node (recommended for MCP clients)
```

Client config (Node, any MCP client):

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/absolute/path/to/x-mcp/dist/index.js"]
    }
  }
}
```

Bun can run the source directly too:

```json
{
  "mcpServers": {
    "x": {
      "command": "bun",
      "args": ["run", "--cwd", "/absolute/path/to/x-mcp", "start"]
    }
  }
}
```

Environment:

| Variable | Meaning |
| --- | --- |
| `X_AUTH_TOKEN` + `X_CSRF_TOKEN` | Session cookies, alternative to the file |
| `X_MCP_READONLY=1` | Expose read tools only |
| `X_MCP_HOME` | Config dir (default `~/.config/x-mcp`) |
| `HTTPS_PROXY` | Proxy for all requests |
| `X_MCP_TIMEOUT_MS` | Per-request timeout (default 30000) |

## Tools

Read: `whoami`, `search_tweets` (full operator syntax, `Latest`/`Top`),
`get_tweet`, `get_thread`, `get_user`, `get_user_tweets`, `get_user_media`,
`get_home_timeline`, `get_bookmarks`, `get_followers`, `get_following`.

Write (hidden with `X_MCP_READONLY=1`): `post_tweet`, `delete_tweet`,
`like_tweet`, `unlike_tweet`, `repost`, `unrepost`.

All list tools return a `nextCursor`; pass it back for the next page.

## Maintenance

```bash
bun run ops:update   # re-scrape GraphQL operation ids from X's live bundles
bun run ops:check    # exit 1 if committed ids are stale (CI uses this)
```

If a tool suddenly returns 404, the operation id rotated — run `ops:update`.
CI (`.github/workflows/refresh-ops.yml`) also commits a refresh on a schedule.

## Risks

This is an unofficial client. X can change endpoints, throttle or suspend
accounts that use them, and the web session cookies grant full account access —
writes included. Keep volume human-scale, prefer a spare account.

## Development

```bash
bun test             # unit tests on real captured payload fixtures
bunx tsc --noEmit    # typecheck
bun run lint         # Biome check
bun run build        # Node bundle in dist/
```

Fixtures in `tests/fixtures/` are trimmed copies of real GraphQL responses
captured from a live session; user content in them belongs to its authors.
