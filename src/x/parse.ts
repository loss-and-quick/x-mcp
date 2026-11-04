/**
 * Mappers from X's raw GraphQL payloads to compact, agent-friendly shapes.
 *
 * The web client's JSON is deeply nested and mixes two generations of object
 * shapes: posts still carry `legacy`, while profiles moved to flat fields
 * (`core`, `avatar`, `profile_bio`, `relationship_counts`, `tweet_counts`,
 * `verification`) in 2026. Every mapper below accepts both, and every branch is
 * shape-tolerant: a missing field yields undefined instead of throwing, so one
 * odd ad entry can never break a whole timeline.
 */

export type MediaItem = {
  type: string;
  url: string;
  previewUrl?: string;
  altText?: string;
  width?: number;
  height?: number;
};

export type Metrics = {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  views: number;
};

export type User = {
  id: string;
  username: string;
  name: string;
  bio?: string;
  location?: string;
  website?: string;
  verified: boolean;
  blueVerified: boolean;
  followers: number;
  following: number;
  tweets: number;
  avatar?: string;
  banner?: string;
  createdAt?: string;
  profileUrl: string;
};

export type Tweet = {
  id: string;
  url: string;
  text: string;
  lang?: string;
  createdAt?: string;
  author?: User;
  metrics: Metrics;
  media: MediaItem[];
  isReply: boolean;
  replyTo?: { id: string; username?: string };
  isRetweet: boolean;
  retweetedBy?: { id: string; username: string };
  quoted?: Tweet;
  hasMoreReplies?: boolean;
};

export type TimelinePage<T> = {
  items: T[];
  /** Pass back to fetch the next page; absent when the timeline ended. */
  nextCursor?: string;
};

type Json = Record<string, unknown>;

export const asObject = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const num = (value: unknown): number => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const pick = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const found = str(value);
    if (found) return found;
  }
  return undefined;
};

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function decodeText(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function unwrapTweetResult(result: unknown): Json | undefined {
  const object = asObject(result);
  if (!object) return undefined;
  // Ads and withheld posts arrive wrapped: {__typename: "TweetWithVisibilityResults", tweet: {...}}
  const inner = asObject(object.tweet) ?? object;
  if (!inner.rest_id) return undefined;
  return asObject(inner.legacy) || asObject(inner.core) ? inner : undefined;
}

function unwrapUserResult(result: unknown): Json | undefined {
  const object = asObject(result);
  if (!object) return undefined;
  const inner = asObject(object.result) ?? object;
  if (!inner.rest_id) return undefined;
  const legacy = asObject(inner.legacy);
  const core = asObject(inner.core);
  return legacy || core ? inner : undefined;
}

function mediaFrom(legacy: Json): MediaItem[] {
  const extended = asArray(asObject(legacy.extended_entities)?.media);
  const plain = asArray(asObject(legacy.entities)?.media);
  const source = extended.length > 0 ? extended : plain;
  const out: MediaItem[] = [];
  for (const raw of source) {
    const item = asObject(raw);
    if (!item) continue;
    const video = asObject(item.video_info);
    const variants = asArray(video?.variants)
      .map((v) => asObject(v))
      .filter((v): v is Json => Boolean(v))
      .filter((v) => str(v.content_type) === "video/mp4")
      .sort((a, b) => num(b.bitrate) - num(a.bitrate));
    const url = pick(variants[0]?.url, item.media_url_https);
    if (!url) continue;
    const size = asObject(item.original_info);
    out.push({
      type: pick(item.type) ?? "photo",
      url,
      ...(pick(item.media_url_https) ? { previewUrl: pick(item.media_url_https)! } : {}),
      ...(pick(item.ext_alt_text) ? { altText: pick(item.ext_alt_text)! } : {}),
      ...(num(size?.width) ? { width: num(size?.width) } : {}),
      ...(num(size?.height) ? { height: num(size?.height) } : {}),
    });
  }
  return out;
}

function websiteOf(user: Json, legacy: Json): string | undefined {
  const urls = asArray(asObject(asObject(legacy.entities)?.url)?.urls);
  const first = asObject(urls[0]);
  return pick(asObject(user.website)?.url, first?.expanded_url, first?.url);
}

export function toUser(raw: unknown): User | undefined {
  const user = unwrapUserResult(raw);
  if (!user) return undefined;
  const legacy = asObject(user.legacy) ?? {};
  const core = asObject(user.core) ?? {};
  const bio = asObject(user.profile_bio) ?? {};
  const location = asObject(user.location) ?? {};
  const relationships = asObject(user.relationship_counts) ?? {};
  const tweets = asObject(user.tweet_counts) ?? {};
  const verification = asObject(user.verification) ?? {};

  const id = pick(user.rest_id, legacy.id_str);
  const username = pick(core.screen_name, legacy.screen_name);
  if (!id || !username) return undefined;

  return {
    id,
    username,
    name: pick(core.name, legacy.name) ?? username,
    ...(pick(bio.description, legacy.description)
      ? { bio: pick(bio.description, legacy.description)! }
      : {}),
    ...(pick(location.location, legacy.location)
      ? { location: pick(location.location, legacy.location)! }
      : {}),
    ...(websiteOf(user, legacy) ? { website: websiteOf(user, legacy)! } : {}),
    verified:
      Boolean(pick(verification.verified) === "true" || user.is_blue_verified) ||
      Boolean(legacy.verified),
    blueVerified: Boolean(user.is_blue_verified),
    followers: num(relationships.followers) || num(legacy.followers_count),
    following: num(relationships.following) || num(legacy.friends_count),
    tweets: num(tweets.tweets) || num(legacy.statuses_count),
    ...(pick(asObject(user.avatar)?.image_url, legacy.profile_image_url_https)
      ? { avatar: pick(asObject(user.avatar)?.image_url, legacy.profile_image_url_https)! }
      : {}),
    ...(pick(asObject(user.banner)?.image_url, legacy.profile_banner_url)
      ? { banner: pick(asObject(user.banner)?.image_url, legacy.profile_banner_url)! }
      : {}),
    ...(pick(core.created_at, legacy.created_at)
      ? { createdAt: pick(core.created_at, legacy.created_at)! }
      : {}),
    profileUrl: `https://x.com/${username}`,
  };
}

function tweetText(legacy: Json, noteTweet: Json | undefined): string {
  const note = asObject(noteTweet?.note_tweet_results);
  const noteResult = asObject(note?.result);
  const long = str(noteResult?.text);
  return decodeText(long ?? str(legacy.full_text) ?? "");
}

export function toTweet(raw: unknown): Tweet | undefined {
  const result = unwrapTweetResult(raw);
  if (!result) return undefined;
  const legacy = asObject(result.legacy) ?? {};
  const id = pick(result.rest_id, legacy.id_str);
  if (!id) return undefined;

  const author = toUser(asObject(asObject(result.core)?.user_results)?.result);
  const username = author?.username ?? "i";
  const views = asObject(result.views)?.count;

  const retweeted = asObject(asObject(legacy.retweeted_status_result)?.result);
  // 2026 build moved the quoted post from legacy to the top level of the tweet node.
  const quoted =
    asObject(asObject(legacy.quoted_status_result)?.result) ??
    asObject(asObject(result.quoted_status_result)?.result);
  const replyToId = pick(legacy.in_reply_to_status_id_str) ?? undefined;
  const replyToUser = pick(legacy.in_reply_to_screen_name);

  const tweet: Tweet = {
    id,
    url: `https://x.com/${username}/status/${id}`,
    text: tweetText(legacy, asObject(result.note_tweet)),
    ...(pick(legacy.lang) ? { lang: pick(legacy.lang)! } : {}),
    ...(pick(legacy.created_at) ? { createdAt: pick(legacy.created_at)! } : {}),
    ...(author ? { author } : {}),
    metrics: {
      likes: num(legacy.favorite_count),
      reposts: num(legacy.retweet_count),
      replies: num(legacy.reply_count),
      quotes: num(legacy.quote_count),
      bookmarks: num(legacy.bookmark_count),
      views: num(views),
    },
    media: mediaFrom(legacy),
    isReply: Boolean(replyToId),
    ...(replyToId
      ? { replyTo: { id: replyToId, ...(replyToUser ? { username: replyToUser } : {}) } }
      : {}),
    isRetweet: Boolean(retweeted),
    ...(typeof result.has_more_replies === "boolean"
      ? { hasMoreReplies: result.has_more_replies as boolean }
      : {}),
  };

  if (retweeted) {
    const original = toTweet(retweeted);
    if (original) {
      return {
        ...original,
        isRetweet: true,
        ...(tweet.author
          ? { retweetedBy: { id: tweet.author.id, username: tweet.author.username } }
          : {}),
      };
    }
  }
  if (quoted) {
    const inner = toTweet(quoted);
    if (inner) tweet.quoted = inner;
  }
  return tweet;
}

type WalkResult = {
  tweets: Tweet[];
  users: User[];
  cursors: { type: string; value: string }[];
};

/** Walks any instruction tree and pulls tweets, users and cursors out of it. */
export function walkInstructions(
  node: unknown,
  acc: WalkResult = { tweets: [], users: [], cursors: [] },
): WalkResult {
  if (Array.isArray(node)) {
    for (const child of node) walkInstructions(child, acc);
    return acc;
  }
  const object = asObject(node);
  if (!object) return acc;

  const tweetResult =
    asObject(object.tweet_results)?.result ?? asObject(object.tweetResult)?.result;
  if (tweetResult !== undefined) {
    const tweet = toTweet(tweetResult);
    if (tweet && !acc.tweets.some((t) => t.id === tweet.id)) acc.tweets.push(tweet);
  }

  const userContainer = asObject(object.user_results);
  const userResult = asObject(userContainer?.result) ?? userContainer;
  if (userResult) {
    const user = toUser(userResult);
    if (user && !acc.users.some((u) => u.id === user.id)) acc.users.push(user);
  }

  const cursorType = str(object.cursorType);
  const cursorValue = str(object.value);
  if (cursorType && cursorValue && !acc.cursors.some((c) => c.type === cursorType)) {
    acc.cursors.push({ type: cursorType, value: cursorValue });
  }

  for (const value of Object.values(object)) {
    if (value && typeof value === "object") walkInstructions(value, acc);
  }
  return acc;
}

function bottomCursor(cursors: { type: string; value: string }[]): string | undefined {
  return (cursors.find((c) => c.type === "Bottom") ?? cursors.find((c) => c.type === "ShowMore"))
    ?.value;
}

export function timelineFrom(data: unknown): TimelinePage<Tweet> {
  const walked = walkInstructions(data);
  const cursor = bottomCursor(walked.cursors);
  return { items: walked.tweets, ...(cursor ? { nextCursor: cursor } : {}) };
}

export function userTimelineFrom(data: unknown): TimelinePage<User> {
  const walked = walkInstructions(data);
  const cursor = bottomCursor(walked.cursors);
  return { items: walked.users, ...(cursor ? { nextCursor: cursor } : {}) };
}

/** `TweetDetail` returns the focal post plus its conversation. */
export function tweetDetailFrom(
  data: unknown,
  focalId?: string,
): { focal?: Tweet; replies: Tweet[]; nextCursor?: string } {
  const walked = walkInstructions(data);
  const focal = focalId
    ? (walked.tweets.find((t) => t.id === focalId) ?? walked.tweets[0])
    : walked.tweets[0];
  const replies = walked.tweets.filter((t) => t.id !== focal?.id);
  const cursor = bottomCursor(walked.cursors);
  return { ...(focal ? { focal } : {}), replies, ...(cursor ? { nextCursor: cursor } : {}) };
}
