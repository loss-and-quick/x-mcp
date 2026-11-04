import { describe, expect, test } from "bun:test";

import {
  collectChunkUrls,
  opsFromModuleSource,
  renderOpsModule,
  scrapeOps,
} from "../scripts/scrape-ops.ts";

const SHELL = `
<html><head>
<script src="https://abs.twimg.com/responsive-web/client-web/main.3a36e48897e341d1a.js"></script>
<link rel="modulepreload" href="https://abs.twimg.com/responsive-web/client-web/vendor.b53dfa6ec5570e89a.js">
<script src="https://abs.twimg.com/responsive-web/client-web/i18n/en.9104951f5c90f2ffa.js"></script>
</head><body>
<script>
__webpack_require__.u = function(e) {
  return "" + ({
    141:"9438f5579c9cbde7",
    1566:"shared~bundle.GrokXWeb~loader.CommerceRoot~~ondemand.BusinessInsights",
    1629:"i18n/emoji-bn"
  }[e] || e) + "." + ({
    141:"9438f5579c9cbde7",
    1566:"1234abcd5678ef90"
  }[e] || e) + "a.js";
}
</script>
</body></html>`;

describe("chunk discovery", () => {
  const urls = collectChunkUrls(SHELL);

  test("keeps directly linked bundles", () => {
    expect(urls.some((u) => u.endsWith("main.3a36e48897e341d1a.js"))).toBe(true);
    expect(urls.some((u) => u.endsWith("vendor.b53dfa6ec5570e89a.js"))).toBe(true);
  });

  test("drops translations", () => {
    expect(urls.some((u) => u.includes("/i18n/"))).toBe(false);
  });

  test("rebuilds chunk urls from the webpack maps", () => {
    expect(
      urls.some((u) =>
        u.endsWith(
          "shared~bundle.GrokXWeb~loader.CommerceRoot~~ondemand.BusinessInsights.1234abcd5678ef90a.js",
        ),
      ),
    ).toBe(true);
  });

  test("does not duplicate urls", () => {
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("ops module", () => {
  const result = {
    ops: { SearchTimeline: "abc123", TweetDetail: "def456" },
    chunks: ["main.hash.js"],
    scrapedAt: "2026-11-04T20:00:00.000Z",
  };

  test("renders a typed module with a scrape timestamp", () => {
    const source = renderOpsModule(result);
    expect(source).toContain("export const OPS = {");
    expect(source).toContain('SearchTimeline: "abc123",');
    expect(source).toContain('OPS_SCRAPED_AT = "2026-11-04T20:00:00.000Z"');
  });

  test("reads the ids back from the generated source", () => {
    expect(opsFromModuleSource(renderOpsModule(result))).toEqual(result.ops);
  });
});

const live = process.env.RUN_LIVE === "1" ? test : test.skip;

describe("live scrape", () => {
  live(
    "finds the operations the tools depend on in X's current bundles",
    async () => {
      const result = await scrapeOps();
      for (const name of ["SearchTimeline", "TweetDetail", "UserByScreenName", "HomeTimeline"]) {
        expect(result.ops[name]).toMatch(/^[A-Za-z0-9_-]+$/);
      }
      expect(Object.keys(result.ops).length).toBeGreaterThan(50);
    },
    120_000,
  );
});
