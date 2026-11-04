import { describe, expect, test } from "bun:test";

import {
  decodeText,
  timelineFrom,
  toTweet,
  toUser,
  tweetDetailFrom,
  userTimelineFrom,
} from "../src/x/parse.ts";

const searchFixture = await Bun.file(
  new URL("./fixtures/search_timeline.json", import.meta.url),
).json();
const detailFixture = await Bun.file(
  new URL("./fixtures/tweet_detail.json", import.meta.url),
).json();

describe("search timeline", () => {
  const page = timelineFrom(searchFixture);

  test("returns the posts of the page", () => {
    expect(page.items.length).toBe(2);
    expect(page.items[0]?.id).toBe("2118078390909415907");
  });

  test("maps the current profile shape (core/profile_bio/relationship_counts)", () => {
    const author = page.items[0]?.author;
    expect(author).toBeDefined();
    expect(author?.username).toBe("ScyllaDB");
    expect(author?.name).toBe("ScyllaDB");
    expect(author?.followers).toBe(29417);
    expect(author?.following).toBe(232);
    expect(author?.tweets).toBe(9469);
    expect(author?.createdAt).toBe("Mon Aug 10 20:45:07 +0000 2015");
    expect(author?.avatar).toContain("pbs.twimg.com/profile_images");
  });

  test("maps text, views, media and the post url", () => {
    const tweet = page.items[0]!;
    expect(tweet.text.startsWith("Tracegrams are a lightweight primitive")).toBe(true);
    expect(tweet.metrics.views).toBe(43);
    expect(tweet.media[0]?.type).toBe("photo");
    expect(tweet.media[0]?.url).toContain("pbs.twimg.com/media/");
    expect(tweet.url).toBe(`https://x.com/ScyllaDB/status/${tweet.id}`);
    expect(tweet.createdAt).toBeDefined();
    expect(tweet.isReply).toBe(false);
  });

  test("exposes the bottom cursor for paging", () => {
    expect(page.nextCursor).toBe("CURSOR_VALUE");
  });

  test("keeps the quoted post of a quote tweet", () => {
    const quote = page.items.find((t) => t.quoted);
    expect(quote).toBeDefined();
    expect(quote?.quoted?.id).toBeDefined();
    expect(quote?.isRetweet).toBe(false);
  });
});

describe("profile timeline", () => {
  test("collects users instead of posts", () => {
    const page = userTimelineFrom(searchFixture);
    expect(page.items[0]?.username).toBe("ScyllaDB");
  });
});

describe("tweet detail", () => {
  test("splits the focal post from its replies", () => {
    const detail = tweetDetailFrom(detailFixture, "2118079600697737577");
    expect(detail.focal).toBeDefined();
    expect(detail.replies.length).toBeGreaterThan(0);
    expect(detail.replies.every((r) => r.id !== detail.focal?.id)).toBe(true);
  });
});

describe("compatibility with the legacy profile shape", () => {
  const legacyUser = {
    __typename: "User",
    rest_id: "12",
    legacy: {
      screen_name: "jack",
      name: "jack",
      description: "no bio yet",
      location: "Earth",
      followers_count: 100,
      friends_count: 20,
      statuses_count: 5,
      verified: true,
      created_at: "Tue Mar 21 20:50:14 +0000 2006",
      profile_image_url_https: "https://pbs.twimg.com/a_normal.jpg",
      entities: { url: { urls: [{ expanded_url: "https://example.com" }] } },
    },
    is_blue_verified: false,
  };

  test("reads counts, bio and website from legacy", () => {
    const user = toUser(legacyUser)!;
    expect(user.username).toBe("jack");
    expect(user.followers).toBe(100);
    expect(user.following).toBe(20);
    expect(user.tweets).toBe(5);
    expect(user.verified).toBe(true);
    expect(user.location).toBe("Earth");
    expect(user.website).toBe("https://example.com");
  });
});

describe("tweet wrappers", () => {
  const baseTweet = {
    rest_id: "99",
    core: { user_results: { result: { rest_id: "1", core: { screen_name: "a", name: "A" } } } },
    legacy: { full_text: "short text", id_str: "99", created_at: "Wed Nov 04 20:00:00 +0000 2026" },
  };

  test("unwraps TweetWithVisibilityResults", () => {
    const tweet = toTweet({ __typename: "TweetWithVisibilityResults", tweet: baseTweet })!;
    expect(tweet.id).toBe("99");
    expect(tweet.author?.username).toBe("a");
  });

  test("prefers the long note_tweet body", () => {
    const tweet = toTweet({
      ...baseTweet,
      note_tweet: { note_tweet_results: { result: { text: "a much longer body" } } },
    })!;
    expect(tweet.text).toBe("a much longer body");
  });

  test("returns the original post for a repost and names the reposter", () => {
    const tweet = toTweet({
      ...baseTweet,
      rest_id: "100",
      legacy: {
        full_text: "RT",
        retweeted_status_result: { result: { ...baseTweet, rest_id: "99" } },
      },
    })!;
    expect(tweet.id).toBe("99");
    expect(tweet.isRetweet).toBe(true);
    expect(tweet.retweetedBy?.username).toBe("a");
  });

  test("ignores payloads without a rest_id", () => {
    expect(toTweet({ legacy: { full_text: "x" } })).toBeUndefined();
    expect(toUser({ core: { screen_name: "a" } })).toBeUndefined();
  });
});

describe("text", () => {
  test("decodes the html entities X escapes", () => {
    expect(decodeText("a &amp; b &lt;c&gt; &#39;d&#39;")).toBe("a & b <c> 'd'");
  });
});
