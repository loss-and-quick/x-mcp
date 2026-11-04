import { XApiError, type XClient } from "./client.ts";
import {
  asObject,
  type TimelinePage,
  type Tweet,
  timelineFrom,
  toUser,
  tweetDetailFrom,
  type User,
  userTimelineFrom,
} from "./parse.ts";

export type SearchProduct = "Latest" | "Top";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(value)));

/** Thin, typed layer over the GraphQL operations the web client uses. */
export class XApi {
  constructor(readonly client: XClient) {}

  async sessionUser(): Promise<User> {
    const data = await this.client.graphql({ op: "Viewer", variables: {} });
    const user = userTimelineFrom(data).items[0];
    if (!user) {
      throw new XApiError("session check returned no user: cookies are not a valid x.com session");
    }
    return user;
  }

  async user(username: string): Promise<User | undefined> {
    const data = await this.client.graphql({
      op: "UserByScreenName",
      variables: { screen_name: username.replace(/^@/, ""), withGrokTranslatedBio: true },
    });
    // UserByScreenName returns data.user.result directly, not a timeline.
    const payload = asObject(data);
    const direct = asObject(asObject(payload?.data)?.user)?.result;
    return toUser(direct) ?? userTimelineFrom(data).items[0];
  }

  async searchTweets(
    query: string,
    options: { count?: number; product?: SearchProduct; cursor?: string } = {},
  ): Promise<TimelinePage<Tweet>> {
    const data = await this.client.graphql({
      op: "SearchTimeline",
      variables: {
        rawQuery: query,
        count: clamp(options.count ?? 20, 1, 100),
        querySource: "typed_query",
        product: options.product ?? "Latest",
        withGrokTranslatedBio: false,
        withQuickPromoteEligibilityTweetFields: false,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });
    return timelineFrom(data);
  }

  async tweetDetail(
    tweetId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ focal?: Tweet; replies: Tweet[]; nextCursor?: string }> {
    const data = await this.client.graphql({
      op: "TweetDetail",
      variables: {
        focalTweetId: tweetId,
        with_rux_injections: false,
        rankingMode: "Relevance",
        includePromotedContent: true,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });
    const detail = tweetDetailFrom(data, tweetId);
    const limit = options.limit ? clamp(options.limit, 1, 200) : undefined;
    return {
      ...detail,
      replies: limit ? detail.replies.slice(0, limit) : detail.replies,
    };
  }

  async tweetById(tweetId: string): Promise<Tweet | undefined> {
    const data = await this.client.graphql({
      op: "TweetResultByRestId",
      variables: {
        tweetId,
        withCommunity: false,
        includePromotedContent: false,
        withVoice: false,
      },
    });
    return timelineFrom(data).items[0];
  }

  async userTweets(
    userId: string,
    options: { count?: number; withReplies?: boolean; cursor?: string } = {},
  ): Promise<TimelinePage<Tweet>> {
    const variables = {
      userId,
      count: clamp(options.count ?? 20, 1, 100),
      includePromotedContent: true,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    };
    const data = await this.client.graphql({
      op: options.withReplies ? "UserTweetsAndReplies" : "UserOriginalsTimeline",
      variables,
    });
    return timelineFrom(data);
  }

  async userMedia(
    userId: string,
    options: { count?: number; cursor?: string } = {},
  ): Promise<TimelinePage<Tweet>> {
    const data = await this.client.graphql({
      op: "UserMedia",
      variables: {
        userId,
        count: clamp(options.count ?? 20, 1, 100),
        includePromotedContent: false,
        withClientEventToken: false,
        withBirdwatchNotes: false,
        withVoice: true,
        withV2Timeline: true,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });
    return timelineFrom(data);
  }

  async homeTimeline(
    options: { count?: number; latest?: boolean; cursor?: string } = {},
  ): Promise<TimelinePage<Tweet>> {
    const count = clamp(options.count ?? 20, 1, 100);
    const data = await this.client.graphql({
      op: options.latest ? "HomeLatestTimeline" : "HomeTimeline",
      variables: {
        count,
        includePromotedContent: !options.latest,
        requestContext: "launch",
        withCommunity: true,
        ...(options.latest ? { latestControlAvailable: true } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });
    return timelineFrom(data);
  }

  async bookmarks(options: { count?: number; cursor?: string } = {}): Promise<TimelinePage<Tweet>> {
    const data = await this.client.graphql({
      op: "Bookmarks",
      variables: {
        count: clamp(options.count ?? 20, 1, 100),
        includePromotedContent: false,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });
    return timelineFrom(data);
  }

  async followers(
    userId: string,
    options: { count?: number; cursor?: string } = {},
  ): Promise<TimelinePage<User>> {
    const data = await this.client.graphql({
      op: "Followers",
      variables: {
        userId,
        count: clamp(options.count ?? 20, 1, 100),
        includePromotedContent: false,
        withGrokTranslatedBio: false,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });
    return userTimelineFrom(data);
  }

  async following(
    userId: string,
    options: { count?: number; cursor?: string } = {},
  ): Promise<TimelinePage<User>> {
    const data = await this.client.graphql({
      op: "Following",
      variables: {
        userId,
        count: clamp(options.count ?? 20, 1, 100),
        includePromotedContent: false,
        withGrokTranslatedBio: false,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    });
    return userTimelineFrom(data);
  }

  /** Resolve `@name` or a raw id to a rest_id, which most timelines require. */
  async resolveUserId(userIdOrName: string): Promise<string> {
    if (/^\d+$/.test(userIdOrName)) return userIdOrName;
    const user = await this.user(userIdOrName);
    if (!user) {
      throw new XApiError(`@${userIdOrName.replace(/^@/, "")} not found`);
    }
    return user.id;
  }

  // ---- writes -------------------------------------------------------------

  async postTweet(text: string, options: { replyTo?: string } = {}): Promise<Tweet | undefined> {
    const data = await this.client.graphql({
      op: "CreateTweet",
      method: "POST",
      referer: "https://x.com/compose/post",
      fieldToggles: {},
      variables: {
        tweet_text: text,
        dark_request: false,
        media: { media_entities: [], possibly_sensitive: false },
        semantic_annotation_ids: [],
        semantic_annotation_options: { source: "UniversalLink" },
        disallowed_reply_options: null,
        ...(options.replyTo
          ? { reply: { in_reply_to_tweet_id: options.replyTo, exclude_reply_user_ids: [] } }
          : {}),
      },
    });
    return timelineFrom(data).items[0];
  }

  async deleteTweet(tweetId: string): Promise<void> {
    await this.client.graphql({
      op: "DeleteTweet",
      method: "POST",
      variables: { tweet_id: tweetId, dark_request: false },
    });
  }

  async like(tweetId: string): Promise<void> {
    await this.client.graphql({
      op: "FavoriteTweet",
      method: "POST",
      variables: { tweet_id: tweetId },
    });
  }

  async unlike(tweetId: string): Promise<void> {
    await this.client.graphql({
      op: "UnfavoriteTweet",
      method: "POST",
      variables: { tweet_id: tweetId },
    });
  }

  async repost(tweetId: string): Promise<void> {
    await this.client.graphql({
      op: "CreateRetweet",
      method: "POST",
      variables: { tweet_id: tweetId, dark_request: false },
    });
  }

  async unrepost(tweetId: string): Promise<void> {
    await this.client.graphql({
      op: "DeleteRetweet",
      method: "POST",
      variables: { source_tweet_id: tweetId, dark_request: false },
    });
  }
}

export { toUser };
