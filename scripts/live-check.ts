/**
 * One-off live check of the full read path against the real session:
 * whoami -> search -> thread -> profile -> timeline, printing compact results.
 * Run: bun run scripts/live-check.ts
 */

import { loadCredentials } from "../src/config.ts";
import { XApi } from "../src/x/api.ts";
import { XClient } from "../src/x/client.ts";

const api = new XApi(new XClient(loadCredentials()));

const show = (label: string, value: unknown) =>
  console.error(`${label}: ${JSON.stringify(value ?? null)?.slice(0, 500)}`);

const me = await api.sessionUser();
show("whoami", {
  username: me.username,
  id: me.id,
  followers: me.followers,
  rate: api.client.lastRateLimit,
});

const search = await api.searchTweets("bun javascript", { count: 3 });
show("search", {
  n: search.items.length,
  first: search.items[0] && {
    id: search.items[0].id,
    by: search.items[0].author?.username,
    text: search.items[0].text.slice(0, 60),
  },
  cursor: Boolean(search.nextCursor),
});

if (search.items[0]) {
  const thread = await api.tweetDetail(search.items[0].id, { limit: 5 });
  show("thread", {
    focal: thread.focal?.id,
    replies: thread.replies.length,
    next: Boolean(thread.nextCursor),
  });
}

const user = await api.user("OpenAI");
show("user", user && { id: user.id, username: user.username, followers: user.followers });

if (user) {
  const tweets = await api.userTweets(user.id, { count: 5 });
  show("userTweets", {
    n: tweets.items.length,
    first: tweets.items[0] && { id: tweets.items[0].id, text: tweets.items[0].text.slice(0, 50) },
  });
}

console.error("LIVE READ OK");
