import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");

function loadHelpers(apiClient = {}) {
  const context = {
    __JFP_TEST__: true,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa: globalThis.btoa,
    encodeURI,
    encodeURIComponent,
    decodeURIComponent,
    console: { log() {} },
    navigator: { userAgent: "Windows" },
    location: { hash: "" },
    window: {
      ApiClient: apiClient,
      alert() {},
      screen: { width: 3840, height: 2160 },
      setTimeout,
      requestAnimationFrame() {},
    },
    document: {},
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "script.js" });
  return context.__JFP_TEST_API__;
}

function makePageCards(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index + 1}`,
    element: { getAttribute: () => `item-${index + 1}` },
  }));
}

test("Jellyfin stream URLs use the canonical Videos route and real query separators", () => {
  const helpers = loadHelpers();
  const url = helpers.buildJellyfinUrl(
    { _serverAddress: "https://jellyfin.example.test/", accessToken: () => "secret-token" },
    ["Videos", "item-id", "stream.mkv"],
    { api_key: "secret-token", Static: true, MediaSourceId: "source-id", jfp: 1 },
  );
  const parsed = new URL(url);

  assert.equal(parsed.pathname, "/Videos/item-id/stream.mkv");
  assert.equal(parsed.searchParams.get("api_key"), "secret-token");
  assert.equal(parsed.searchParams.get("Static"), "true");
  assert.equal(parsed.searchParams.get("MediaSourceId"), "source-id");
  assert.equal(parsed.searchParams.get("jfp"), "1");
  assert.match(parsed.search, /&/);
  assert.doesNotMatch(parsed.search, /%26/);
});

test("native player URL builders preserve the original HTTP URL", () => {
  const helpers = loadHelpers();
  const httpUrl = "https://jellyfin.example.test/Videos/id/stream.mkv?api_key=token&Static=true&MediaSourceId=source";

  const potUrl = helpers.buildPotPlayerNativeUrl(httpUrl);
  assert.match(potUrl, /%26/);
  assert.equal(decodeURIComponent(potUrl.slice("potplayer://".length)), httpUrl);

  const iinaUrl = new URL(helpers.buildIinaUrl(httpUrl));
  assert.equal(iinaUrl.searchParams.get("url"), httpUrl);
  assert.equal(iinaUrl.searchParams.get("new_window"), "1");

  const infuseUrl = new URL(helpers.buildInfuseUrl(httpUrl));
  assert.equal(infuseUrl.searchParams.get("url"), httpUrl);
});

test("subtitle URLs use the canonical Videos route and validate the stream index", () => {
  const helpers = loadHelpers({
    _serverAddress: "https://jellyfin.example.test/",
    accessToken: () => "token",
  });
  const item = {
    Id: "item-id",
    MediaSources: [{
      Id: "source-id",
      MediaStreams: [
        { Type: "Subtitle", IsExternal: true, IsDefault: true, Index: 2, Codec: "srt" },
      ],
    }],
  };

  const streamUrl = new URL(helpers.getStreamUrl(item));
  assert.equal(streamUrl.pathname, "/Videos/item-id/stream.mkv");
  assert.equal(streamUrl.searchParams.get("MediaSourceId"), "source-id");

  const subtitleUrl = helpers.getSubtitleUrl(item);
  const parsed = new URL(subtitleUrl);
  assert.equal(parsed.pathname, "/Videos/item-id/source-id/Subtitles/2/Stream.srt");
  assert.equal(parsed.searchParams.get("api_key"), "token");
  assert.equal(helpers.getSubtitleUrl({
    ...item,
    MediaSources: [{ ...item.MediaSources[0], MediaStreams: [{ ...item.MediaSources[0].MediaStreams[0], Index: "bad" }] }],
  }), "");
});

test("generic payload encoding is URL-safe and decodes back to JSON", () => {
  const helpers = loadHelpers();
  const payload = [{ mode: "mpv", url: "https://example.test/video.mkv?x=1&y=2", title: "Unicode title" }];
  const genericUrl = helpers.buildGenericUrl(payload);
  const encoded = genericUrl.slice("jelly-player://".length);
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

  assert.deepEqual(decoded, payload);
  assert.doesNotMatch(encoded, /[+/=]/);
});

test("one failed item does not prevent other targets from resolving", async () => {
  const helpers = loadHelpers({
    _serverAddress: "https://jellyfin.example.test",
    _serverInfo: { UserId: "user-id" },
    accessToken: () => "token",
    async getItem(_userId, itemId) {
      if (itemId === "bad") throw new Error("item unavailable");
      return {
        Id: itemId,
        Name: "Playable",
        MediaSources: [{ Id: "source-id", Container: "mkv", MediaStreams: [] }],
      };
    },
  });

  const result = await helpers.resolveTargets(["good", "bad"]);
  assert.equal(result.valid.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(new URL(result.valid[0].url).pathname, "/Videos/good/stream.mkv");
  assert.equal(result.failed[0].itemId, "bad");
});

test("browser log text redacts URLs, protocol payloads, and line breaks", () => {
  const helpers = loadHelpers();
  const safe = helpers.sanitizeLogText(
    "request failed https://example.test/video?api_key=secret&Static=true\n" +
    "jelly-player://eyJ1cmwiOiJzZWNyZXQifQ",
  );

  assert.ok(!safe.includes("secret"));
  assert.ok(!safe.includes("eyJ1cmwiOiJzZWNyZXQifQ"));
  assert.ok(!safe.includes("\n"));
});

test("source no longer contains the removed Jellyfin emby video path", () => {
  assert.doesNotMatch(source, /\/emby\/videos\//);
});

test("page cards are read from div.card in DOM order and deduplicated", () => {
  const helpers = loadHelpers();
  const elements = ["a", "b", "a", "", "c"].map(id => ({
    getAttribute(name) {
      return name === "data-id" ? id : null;
    },
  }));
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, "div.card[data-id]");
      return elements;
    },
  };

  assert.deepEqual(Array.from(helpers.getPageCardIds(root)), ["a", "b", "c"]);
  assert.deepEqual(Array.from(helpers.getPageCards(root), card => card.id), ["a", "b", "c"]);
});

test("Grid Play 4x4 selects the first sixteen page items when there is no selection", () => {
  const helpers = loadHelpers();
  const pageIds = Array.from({ length: 20 }, (_, index) => `item-${index + 1}`);
  const plan = helpers.planGrid16Targets(pageIds, []);

  assert.equal(plan.ok, true);
  assert.deepEqual(Array.from(plan.targets), pageIds.slice(0, 16));
  assert.deepEqual(Array.from(plan.addedIds), pageIds.slice(0, 16));
});

test("Grid Play 4x4 preserves existing selection and fills in page order", () => {
  const helpers = loadHelpers();
  const pageIds = Array.from({ length: 20 }, (_, index) => `item-${index + 1}`);
  const selected = ["item-4", "item-2"];
  const plan = helpers.planGrid16Targets(pageIds, selected);

  assert.equal(plan.ok, true);
  assert.deepEqual(Array.from(plan.targets.slice(0, 2)), selected);
  assert.deepEqual(Array.from(plan.addedIds), [
    "item-1", "item-3", "item-5", "item-6", "item-7", "item-8", "item-9", "item-10",
    "item-11", "item-12", "item-13", "item-14", "item-15", "item-16",
  ]);
  assert.equal(plan.targets.length, 16);
});

test("Grid Play 4x4 rejects more than sixteen selected items", () => {
  const helpers = loadHelpers();
  const plan = helpers.planGrid16Targets(makePageCards(20), Array.from({ length: 17 }, (_, index) => `selected-${index}`));

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "too-many-selected");
  assert.deepEqual(Array.from(plan.targets), []);
});

test("Grid Play 4x4 rejects pages with fewer than sixteen media cards", () => {
  const helpers = loadHelpers();
  const plan = helpers.planGrid16Targets(makePageCards(15), []);

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "not-enough-page-items");
  assert.deepEqual(Array.from(plan.targets), []);
});

test("4x4 geometry uses four columns and four rows", () => {
  const helpers = loadHelpers();
  assert.equal(helpers.getGridGeometry(0, 16, 4, 4), "1920x1080+0+0");
  assert.equal(helpers.getGridGeometry(3, 16, 4, 4), "1920x1080+5760+0");
  assert.equal(helpers.getGridGeometry(4, 16, 4, 4), "1920x1080+0+1080");
  assert.equal(helpers.getGridGeometry(15, 16, 4, 4), "1920x1080+5760+3240");
});

test("4x4 parse failure cannot create a partial MPV payload", () => {
  const helpers = loadHelpers();
  const entries = Array.from({ length: 15 }, (_, index) => ({
    url: `https://example.test/${index}.mkv`,
    item: { Name: `Item ${index}` },
    subtitle: "",
  }));

  assert.equal(helpers.buildMpvPayload(entries, "multi", {
    columns: 4,
    rows: 4,
    maxItems: 16,
    strictCount: 16,
  }), null);
});

test("strict 4x4 resolution treats invalid external subtitles as a failed item", async () => {
  const helpers = loadHelpers({
    _serverAddress: "https://jellyfin.example.test",
    _serverInfo: { UserId: "user-id" },
    accessToken: () => "token",
    async getItem(_userId, itemId) {
      return {
        Id: itemId,
        Name: "Playable",
        MediaSources: [{
          Id: "source-id",
          Container: "mkv",
          MediaStreams: [{ Type: "Subtitle", IsExternal: true, Index: "invalid", Codec: "srt" }],
        }],
      };
    },
  });

  const result = await helpers.resolveTargets(["item-id"], { strict: true });
  assert.equal(result.valid.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /Subtitle preparation failed/);
});

test("4x4 handlePlay refuses to launch when one of sixteen media items fails", async () => {
  const helpers = loadHelpers({
    _serverAddress: "https://jellyfin.example.test",
    _serverInfo: { UserId: "user-id" },
    accessToken: () => "token",
    async getItem(_userId, itemId) {
      if (itemId === "bad") throw new Error("item unavailable");
      return {
        Id: itemId,
        Name: "Playable",
        MediaSources: [{ Id: "source-id", Container: "mkv", MediaStreams: [] }],
      };
    },
  });
  const targets = Array.from({ length: 15 }, (_, index) => `item-${index}`);
  targets.push("bad");

  const result = await helpers.handlePlay("mpv", "multi", {
    targets,
    strict: true,
    strictCount: 16,
    layout: { columns: 4, rows: 4, maxItems: 16, strictCount: 16 },
  });

  assert.equal(result.launched, false);
  assert.equal(result.payload, null);
  assert.equal(result.valid.length, 15);
  assert.equal(result.failed.length, 1);
});
