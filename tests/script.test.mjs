import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");

function loadHelpers(apiClient = {}, documentValue = {}, windowOverrides = {}) {
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
      ...windowOverrides,
    },
    document: documentValue,
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

test("page cards ignore hidden person cards and non-video cards", () => {
  const helpers = loadHelpers();
  const makeCard = ({ id, type = "Movie", mediaType = "Video", visible = true, ariaHidden = null, className = "card" }) => ({
    className,
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      return {
        "data-id": id,
        "data-type": type,
        "data-mediatype": mediaType,
        "aria-hidden": ariaHidden,
      }[name] ?? null;
    },
    getBoundingClientRect() {
      return visible ? { width: 200, height: 300 } : { width: 0, height: 0 };
    },
    matches(selector) {
      return selector.includes(".personCard") && className.includes("personCard");
    },
  });
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, "div.card[data-id]");
      return [
        makeCard({ id: "actor", type: "Actor", className: "card personCard" }),
        makeCard({ id: "hidden", visible: false }),
        makeCard({ id: "aria-hidden", ariaHidden: "true" }),
        makeCard({ id: "movie-1" }),
        makeCard({ id: "audio", mediaType: "Audio" }),
        makeCard({ id: "movie-1" }),
        makeCard({ id: "movie-2" }),
      ];
    },
  };

  assert.deepEqual(Array.from(helpers.getPageCardIds(root)), ["movie-1", "movie-2"]);
});

test("selected item detection follows Jellyfin checkbox state on visible media cards", () => {
  const makeCard = ({ id, type = "Movie", visible = true }) => {
    const card = {
      className: "card",
      hidden: false,
      parentElement: null,
      getAttribute(name) {
        return {
          "data-id": id,
          "data-type": type,
          "data-mediatype": "Video",
        }[name] ?? null;
      },
      getBoundingClientRect() {
        return visible ? { width: 200, height: 300 } : { width: 0, height: 0 };
      },
      matches() {
        return false;
      },
    };
    return card;
  };

  const selectedCard = makeCard({ id: "selected" });
  const actorCard = makeCard({ id: "actor", type: "Actor" });
  const checkedIcon = {
    className: "checkboxIcon-checked",
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      return name === "aria-hidden" ? "true" : null;
    },
    getBoundingClientRect() {
      return { width: 24, height: 24 };
    },
    closest() {
      return selectedCard;
    },
  };
  const actorIcon = {
    className: "checkboxIcon-checked",
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      return name === "aria-hidden" ? "true" : null;
    },
    getBoundingClientRect() {
      return { width: 24, height: 24 };
    },
    closest() {
      return actorCard;
    },
  };
  selectedCard.querySelectorAll = () => [checkedIcon];
  actorCard.querySelectorAll = () => [actorIcon];

  const documentValue = {
    querySelectorAll(selector) {
      if (selector === ".checkboxIcon-checked") return [checkedIcon, actorIcon];
      if (selector === "div.card[data-id]") return [selectedCard, actorCard];
      return [];
    },
  };
  const helpers = loadHelpers({}, documentValue);

  assert.deepEqual(Array.from(helpers.getSelectedItems()), ["selected"]);
});

test("transparent Jellyfin checkbox controls remain selectable and count as selected", async () => {
  let clickCount = 0;
  const card = {
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      return {
        "data-id": "item-1",
        "data-type": "Movie",
        "data-mediatype": "Video",
      }[name] ?? null;
    },
    getBoundingClientRect() {
      return { width: 211, height: 370 };
    },
    matches() {
      return false;
    },
  };
  const checkbox = {
    checked: true,
    hidden: false,
    parentElement: card,
    getAttribute(name) {
      return name === "class" ? "chkItemSelect emby-checkbox" : null;
    },
    getBoundingClientRect() {
      return { width: 1, height: 1 };
    },
    matches(selector) {
      return selector.includes("input.chkItemSelect");
    },
    click() {
      clickCount += 1;
    },
  };
  card.querySelectorAll = selector => selector.includes(":checked") || selector.includes("input.chkItemSelect")
    ? [checkbox]
    : [];

  const documentValue = {
    querySelectorAll(selector) {
      if (selector === ".checkboxIcon-checked") return [];
      if (selector === "div.card[data-id]") return [card];
      return [];
    },
  };
  const helpers = loadHelpers({}, documentValue, {
    getComputedStyle(element) {
      return { display: "block", visibility: "visible", opacity: element === checkbox ? "0" : "1" };
    },
  });

  assert.equal(helpers.findCardSelectionControl(card), checkbox);
  assert.deepEqual(Array.from(helpers.getSelectedItems()), ["item-1"]);
  await helpers.toggleCardSelection(card);
  assert.equal(clickCount, 1);
});

test("Jellyfin visual checkbox is preferred over the hidden input", async () => {
  let outlineClicks = 0;
  let inputClicks = 0;
  const card = {
    parentElement: null,
    getAttribute() {
      return null;
    },
  };
  const outline = {
    hidden: false,
    parentElement: card,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 27, height: 27 };
    },
    matches(selector) {
      return selector.includes(".checkboxOutline");
    },
    click() {
      outlineClicks += 1;
    },
  };
  const input = {
    hidden: false,
    parentElement: card,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 1, height: 1 };
    },
    matches() {
      return false;
    },
    click() {
      inputClicks += 1;
    },
  };
  card.querySelectorAll = () => [input, outline];
  const helpers = loadHelpers();

  assert.equal(helpers.findCardSelectionControl(card), outline);
  await helpers.toggleCardSelection(card);
  assert.equal(outlineClicks, 1);
  assert.equal(inputClicks, 0);
});

test("multi-select toggles Jellyfin's native checkbox when it is available", async () => {
  const helpers = loadHelpers();
  let clickCount = 0;
  const checkbox = {
    hidden: false,
    parentElement: null,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 1, height: 1 };
    },
    click() {
      clickCount += 1;
    },
  };
  const card = {
    getAttribute(name) {
      return name === "data-id" ? "item-1" : null;
    },
    querySelectorAll(selector) {
      assert.match(selector, /input\.chkItemSelect/);
      return [checkbox];
    },
  };

  await helpers.toggleCardSelection(card);
  assert.equal(clickCount, 1);
});

test("card menu fallback does not mistake the play button for the menu", () => {
  const makeButton = title => ({
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      return name === "title" ? title : null;
    },
    getBoundingClientRect() {
      return { width: 24, height: 24 };
    },
  });
  const playButton = makeButton("\u64ad\u653e");
  const menuButton = makeButton("\u66f4\u591a");
  const card = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("button[title]")) return [playButton, menuButton];
      return [];
    },
  };
  const helpers = loadHelpers({}, { querySelectorAll: () => [] }, {
    getComputedStyle(element) {
      return { display: "block", visibility: "visible", opacity: element === playButton || element === menuButton ? "0" : "1" };
    },
  });

  assert.equal(helpers.findCardMenuTrigger(card), menuButton);
});

test("4x4 selection mode can bootstrap from a later card menu", async () => {
  let menuOpen = false;
  let multiSelectMode = false;
  const selectedIds = new Set();
  const cardsById = new Map();

  const makeCard = (id, hasMenu) => {
    const card = {
      hidden: false,
      parentElement: null,
      getAttribute(name) {
        return {
          "data-id": id,
          "data-type": "Movie",
          "data-mediatype": "Video",
        }[name] ?? null;
      },
      getBoundingClientRect() {
        return { width: 200, height: 300 };
      },
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        if (selector.includes("input.chkItemSelect")) {
          return multiSelectMode ? [{
            hidden: false,
            parentElement: card,
            getAttribute() {
              return null;
            },
            getBoundingClientRect() {
              return { width: 1, height: 1 };
            },
            click() {
              selectedIds.add(id);
            },
          }] : [];
        }
        if (selector.includes('[data-action="menu"]')) {
          if (!hasMenu) return [];
          return [{
            hidden: false,
            parentElement: card,
            getAttribute(name) {
              return name === "data-action" ? "menu" : null;
            },
            getBoundingClientRect() {
              return { width: 24, height: 24 };
            },
            click() {
              menuOpen = true;
            },
          }];
        }
        return [];
      },
    };
    cardsById.set(id, card);
    return card;
  };

  const cardWithoutMenu = makeCard("item-1", false);
  const cardWithMenu = makeCard("item-2", true);
  const menuItem = {
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      return name === "data-id" ? "multiSelect" : null;
    },
    getBoundingClientRect() {
      return { width: 200, height: 40 };
    },
    click() {
      menuOpen = false;
      multiSelectMode = true;
      selectedIds.add("item-2");
    },
  };
  const documentValue = {
    querySelectorAll(selector) {
      if (selector === ".checkboxIcon-checked") {
        return Array.from(selectedIds, id => ({
          hidden: false,
          parentElement: null,
          getAttribute(name) {
            return name === "aria-hidden" ? "true" : null;
          },
          getBoundingClientRect() {
            return { width: 24, height: 24 };
          },
          closest() {
            return cardsById.get(id);
          },
        }));
      }
      if (selector === "div.card[data-id]") return [cardWithoutMenu, cardWithMenu];
      if (selector.includes("multiSelect")) return menuOpen ? [menuItem] : [];
      return [];
    },
  };
  const helpers = loadHelpers({}, documentValue);
  const attemptedIds = [];

  await helpers.ensureGridSelectionMode(
    ["item-1", "item-2"],
    cardsById,
    attemptedIds,
    100,
  );

  assert.deepEqual(attemptedIds, ["item-2"]);
  assert.equal(multiSelectMode, true);
  assert.deepEqual(Array.from(selectedIds), ["item-2"]);
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
