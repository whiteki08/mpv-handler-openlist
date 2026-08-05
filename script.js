// ==UserScript==
// @name         Jellyfin External Players (Batch/FullScreen/Subs)
// @namespace    yifans.tech
// @version      4.4.3
// @description  Launch MPV, PotPlayer, IINA, and Infuse from Jellyfin, including 4x4 MPV playback.
// @match        *://*/web/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    osScale: 2.0,
    schemeGeneric: "jelly-player",
    maxItems: 4,
    grid16: {
      maxItems: 16,
      columns: 4,
      rows: 4,
      profile: "multi",
      selectionTimeoutMs: 2000,
    },
    launchCleanupMs: 2000,
    legacyLaunchDelayMs: 800,
    showOn: {
      windows: { mpv: true, pot: true },
      macOS: { mpv: true, pot: false, iina: true, infuse: true },
      other: { mpv: false, pot: false, iina: false, infuse: false },
    },
  };

  const PANEL_ID = "jfp-extplayers";
  const STYLE_ID = "jfp-extplayers-style";
  const SENSITIVE_QUERY_PATTERN = /((?:[?&]|\b)(?:api_key|apikey|access_token|token)=)[^&#\s]*/gi;
  const PROTOCOL_PAYLOAD_PATTERN = /\b(?:jelly-player|potplayer|iina|infuse):\/\/\S+/gi;

  function redactSensitiveText(value) {
    let text = String(value ?? "");
    text = text.replace(PROTOCOL_PAYLOAD_PATTERN, match => {
      const separator = match.indexOf("://");
      return `${match.slice(0, separator)}://<redacted>`;
    });
    return text.replace(SENSITIVE_QUERY_PATTERN, "$1<redacted>");
  }

  function sanitizeLogText(value) {
    return redactSensitiveText(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  }

  function log(event, details) {
    if (details === undefined) {
      console.log("[JFP]", event);
    } else {
      console.log("[JFP]", event, typeof details === "string" ? sanitizeLogText(details) : details);
    }
  }

  function errorText(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error || "Unknown error");
  }

  function showError(message) {
    const safeMessage = redactSensitiveText(message);
    log("error", safeMessage);
    if (typeof window.alert === "function") window.alert(safeMessage);
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function base64Encode(value) {
    return encodeBase64Utf8(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function buildGenericUrl(payload) {
    return `${CONFIG.schemeGeneric}://${base64Encode(payload)}`;
  }

  function parseHttpUrl(value, label) {
    if (!value) throw new Error(`${label || "URL"} is missing`);
    let parsed;
    try {
      parsed = new URL(String(value));
    } catch (_error) {
      throw new Error(`${label || "URL"} is invalid`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${label || "URL"} must use HTTP or HTTPS`);
    }
    if (!parsed.hostname) throw new Error(`${label || "URL"} has no host`);
    return parsed;
  }

  function buildPotPlayerNativeUrl(httpUrl) {
    const parsed = parseHttpUrl(httpUrl, "PotPlayer URL");
    // PotPlayer treats raw ampersands in its native scheme as separators.
    // Keep the HTTP URL valid, then escape only the outer scheme boundary.
    const safeUrl = encodeURI(parsed.toString()).replace(/&/g, "%26");
    return `potplayer://${safeUrl}`;
  }

  function buildIinaUrl(httpUrl) {
    const parsed = parseHttpUrl(httpUrl, "IINA URL");
    return `iina://weblink?url=${encodeURIComponent(parsed.toString())}&new_window=1`;
  }

  function buildInfuseUrl(httpUrl) {
    const parsed = parseHttpUrl(httpUrl, "Infuse URL");
    return `infuse://x-callback-url/play?url=${encodeURIComponent(parsed.toString())}`;
  }

  function getApiClient() {
    const api = window.ApiClient;
    if (!api) throw new Error("Jellyfin ApiClient is not available");
    if (typeof api.accessToken !== "function") throw new Error("Jellyfin access token API is unavailable");
    return api;
  }

  function getServerBaseUrl(api) {
    const rawAddress = String(api?._serverAddress || "").trim();
    if (!rawAddress) throw new Error("Jellyfin server address is unavailable");

    const parsed = parseHttpUrl(rawAddress, "Jellyfin server address");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  function getAccessToken(api) {
    const token = String(api.accessToken() || "").trim();
    if (!token) throw new Error("Jellyfin access token is unavailable");
    return token;
  }

  function buildJellyfinUrl(api, pathSegments, query) {
    const path = pathSegments.map(segment => encodeURIComponent(String(segment))).join("/");
    const url = new URL(`${getServerBaseUrl(api)}/${path}`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  function uniqueIds(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const id = String(value ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function getCardId(card) {
    if (typeof card === "string") return card;
    const objectId = card?.id;
    if (objectId !== undefined && objectId !== null && String(objectId).trim()) return objectId;
    return card?.getAttribute?.("data-id") || card?.element?.getAttribute?.("data-id") || "";
  }

  function isMediaCard(card) {
    if (!card || typeof card.getAttribute !== "function") return false;

    const mediaType = String(card.getAttribute("data-mediatype") || "").trim().toLowerCase();
    if (mediaType && mediaType !== "video") return false;

    const type = String(card.getAttribute("data-type") || "").trim().toLowerCase();
    if ([
      "actor", "artist", "audio", "book", "channel", "collection", "collectionfolder", "director",
      "folder", "genre", "music", "person", "photo", "playlist", "producer", "program", "studio",
      "user", "writer",
    ].includes(type)) return false;
    if (card.matches?.(".personCard, .actorCard, .directorCard")) return false;

    return true;
  }

  function getPageCards(root = document) {
    if (!root || typeof root.querySelectorAll !== "function") return [];

    const cards = [];
    const seen = new Set();
    root.querySelectorAll("div.card[data-id]").forEach(card => {
      const id = String(card.getAttribute("data-id") || "").trim();
      if (!id || seen.has(id) || !isMediaCard(card) || !isVisibleElement(card)) return;
      seen.add(id);
      cards.push({ id, element: card });
    });
    return cards;
  }

  function getPageCardIds(root = document) {
    return getPageCards(root).map(card => card.id);
  }

  function planGrid16Targets(pageCards, selectedIds, maxItems = CONFIG.grid16.maxItems) {
    const limit = Number(maxItems);
    const pageIds = uniqueIds((Array.isArray(pageCards) ? pageCards : []).map(getCardId));
    const selected = uniqueIds(selectedIds);

    if (!Number.isInteger(limit) || limit < 1) {
      return { ok: false, reason: "invalid-limit", pageIds, selectedIds: selected, targets: [], addedIds: [] };
    }
    if (selected.length > limit) {
      return { ok: false, reason: "too-many-selected", pageIds, selectedIds: selected, targets: [], addedIds: [] };
    }
    if (pageIds.length < limit) {
      return { ok: false, reason: "not-enough-page-items", pageIds, selectedIds: selected, targets: [], addedIds: [] };
    }

    const selectedSet = new Set(selected);
    const targets = selected.slice();
    const addedIds = [];
    for (const id of pageIds) {
      if (targets.length >= limit || selectedSet.has(id)) continue;
      selectedSet.add(id);
      targets.push(id);
      addedIds.push(id);
    }

    if (targets.length < limit) {
      return { ok: false, reason: "not-enough-page-items", pageIds, selectedIds: selected, targets: [], addedIds: [] };
    }
    return { ok: true, pageIds, selectedIds: selected, targets, addedIds };
  }

  function isVisibleElement(element, options = {}) {
    const ignoreOwnAriaHidden = options.ignoreOwnAriaHidden === true;
    const allowTransparent = options.allowTransparent === true;
    if (!element || element.hidden) return false;
    let current = element;
    while (current && current !== document) {
      const ariaHidden = current.getAttribute?.("aria-hidden") === "true";
      if (current.hidden || (ariaHidden && (current !== element || !ignoreOwnAriaHidden))) return false;
      current = current.parentElement;
    }

    if (typeof window.getComputedStyle === "function") {
      try {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || (!allowTransparent && style.opacity === "0")) return false;
      } catch (_error) {
        // A partially initialized page can reject computed-style lookups.
      }
    }

    if (typeof element.getBoundingClientRect === "function") {
      try {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
      } catch (_error) {
        // A partially initialized page can reject layout lookups.
      }
    }
    return true;
  }

  function isCardSelected(card) {
    if (!card || typeof card.querySelectorAll !== "function" || !isMediaCard(card) || !isVisibleElement(card)) return false;
    if (card.matches?.(".selected, .card-selected, [aria-selected=\"true\"], [data-selected=\"true\"]")) return true;

    const checked = card.querySelectorAll(
      ".checkboxIcon-checked, [aria-checked=\"true\"], [data-selected=\"true\"], input.chkItemSelect:checked, input[type=\"checkbox\"]:checked",
    );
    return Array.from(checked).some(element => isVisibleElement(element, {
      ignoreOwnAriaHidden: element?.matches?.(".checkboxIcon-checked") === true,
      allowTransparent: element?.matches?.(".checkboxIcon-checked, input.chkItemSelect, input[type=\"checkbox\"]") === true,
    }));
  }

  function getContext() {
    const hash = location.hash || "";
    if (hash.includes("#/details")) {
      const match = hash.match(/[?&]id=([^&]+)/i);
      let id = null;
      if (match) {
        try {
          id = decodeURIComponent(match[1]);
        } catch (_error) {
          id = null;
        }
      }
      return { type: "detail", id };
    }

    const pageIds = getPageCardIds();
    const selected = getSelectedItems();
    if (selected.length > 0) return { type: "selection", ids: selected, pageIds };
    if (pageIds.length > 0) return { type: "listing", pageIds };
    return { type: "none" };
  }

  function getSelectedItems() {
    if (!document || typeof document.querySelectorAll !== "function") return [];
    const ids = new Set();
    document.querySelectorAll(".checkboxIcon-checked").forEach(icon => {
      if (!isVisibleElement(icon, { ignoreOwnAriaHidden: true })) return;
      const card = icon.closest("div.card[data-id]") || icon.closest("[data-id]");
      if (!card || !isMediaCard(card) || !isVisibleElement(card)) return;
      const id = card?.getAttribute("data-id");
      if (id) ids.add(id);
    });

    getPageCards().forEach(({ element: card }) => {
      const id = card.getAttribute("data-id");
      if (id && isCardSelected(card)) ids.add(id);
    });
    return [...ids];
  }

  function getOS() {
    const userAgent = navigator.userAgent || "";
    if (/Windows/i.test(userAgent)) return "windows";
    if (/Macintosh|MacIntel/i.test(userAgent)) return "macOS";
    return "other";
  }

  async function getPlayableItem(itemId) {
    const api = getApiClient();
    const userId = api?._serverInfo?.UserId;
    if (!userId) throw new Error("Jellyfin user ID is unavailable");
    if (typeof api.getItem !== "function") throw new Error("Jellyfin item API is unavailable");

    let item = await api.getItem(userId, itemId);
    if (!item) throw new Error("Jellyfin item was not found");

    if (item.Type === "Series") {
      if (typeof api.getNextUpEpisodes !== "function") throw new Error("Jellyfin next-up API is unavailable");
      const nextUp = await api.getNextUpEpisodes({ SeriesId: itemId, UserId: userId });
      const nextItem = nextUp?.Items?.[0];
      if (!nextItem?.Id) throw new Error("Series has no playable next episode");
      item = await api.getItem(userId, nextItem.Id);
    } else if (item.Type === "Season") {
      if (typeof api.getItems !== "function") throw new Error("Jellyfin season API is unavailable");
      const seasonItems = await api.getItems(userId, { parentId: itemId });
      const firstItem = seasonItems?.Items?.[0];
      if (!firstItem?.Id) throw new Error("Season has no playable episode");
      item = await api.getItem(userId, firstItem.Id);
    }

    if (!item) throw new Error("Playable item could not be resolved");
    return item;
  }

  function getStreamUrl(item) {
    const api = getApiClient();
    const mediaSource = item?.MediaSources?.[0];
    if (!item?.Id) throw new Error("Media item ID is missing");
    if (!mediaSource?.Id) throw new Error("Media source ID is missing");

    const container = String(mediaSource.Container || "mkv").trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(container)) throw new Error("Media container is invalid");

    return buildJellyfinUrl(
      api,
      ["Videos", item.Id, `stream.${container}`],
      {
        api_key: getAccessToken(api),
        Static: true,
        MediaSourceId: mediaSource.Id,
        jfp: 1,
      },
    );
  }

  function getSubtitleUrl(item, options = {}) {
    const mediaSource = item?.MediaSources?.[0];
    const streams = mediaSource?.MediaStreams;
    if (!item?.Id || !mediaSource?.Id || !Array.isArray(streams)) return "";

    let subtitle = streams.find(stream => stream.Type === "Subtitle" && stream.IsExternal && stream.IsDefault);
    if (!subtitle) subtitle = streams.find(stream => stream.Type === "Subtitle" && stream.IsExternal);
    if (!subtitle) return "";

    const fail = message => {
      if (options.strict) throw new Error(message);
      return "";
    };
    if (subtitle.Index === undefined || subtitle.Index === null || String(subtitle.Index).trim() === "") {
      return fail("Subtitle stream index is missing");
    }
    const subtitleIndex = Number(subtitle.Index);
    if (!Number.isInteger(subtitleIndex) || subtitleIndex < 0) return fail("Subtitle stream index is invalid");

    const codec = String(subtitle.Codec || "srt").trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(codec)) return fail("Subtitle codec is invalid");

    const api = getApiClient();

    return buildJellyfinUrl(
      api,
      ["Videos", item.Id, mediaSource.Id, "Subtitles", subtitleIndex, `Stream.${codec}`],
      { api_key: getAccessToken(api) },
    );
  }

  function getGridGeometry(index, total, columns, rows) {
    if (total <= 1) return "";

    const columnCount = Number(columns);
    const rowCount = Number(rows);
    const itemIndex = Number(index);
    const fullWidth = Number(window.screen?.width || 0);
    const fullHeight = Number(window.screen?.height || 0);
    const scale = Number(CONFIG.osScale);
    if (!Number.isInteger(columnCount) || columnCount < 1 || !Number.isInteger(rowCount) || rowCount < 1) return "";
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= columnCount * rowCount) return "";
    if (!Number.isFinite(scale) || scale <= 0 || fullWidth <= 0 || fullHeight <= 0) return "";

    const width = Math.floor((fullWidth * scale) / columnCount);
    const height = Math.floor((fullHeight * scale) / rowCount);
    const column = itemIndex % columnCount;
    const row = Math.floor(itemIndex / columnCount);
    return `${width}x${height}+${column * width}+${row * height}`;
  }

  function getGeometry(index, total, columns = 2, rows = 2) {
    if (columns && typeof columns === "object") {
      rows = columns.rows ?? 2;
      columns = columns.columns ?? 2;
    }
    return getGridGeometry(index, total, columns, rows);
  }

  function getLayoutValues(layout = {}) {
    const columns = Number(layout.columns ?? 2);
    const rows = Number(layout.rows ?? 2);
    const maxItems = Number(layout.maxItems ?? columns * rows);
    return { columns, rows, maxItems };
  }

  function findCardMenuTrigger(card) {
    if (!card || typeof card.querySelector !== "function") return null;

    const explicit = Array.from(card.querySelectorAll(
      '[data-action="menu"], [data-id="menu"], .cardOverlayButton[data-action="menu"]',
    )).find(element => isVisibleElement(element, { allowTransparent: true }));
    if (explicit) return explicit;

    const candidates = card.querySelectorAll(
      "[data-action], [data-id], button[aria-label], button[title], [role=\"button\"]",
    );
    return Array.from(candidates).find(element => {
      if (!isVisibleElement(element, { allowTransparent: true })) return false;
      const action = String(element.getAttribute?.("data-action") || "").toLowerCase();
      const dataId = String(element.getAttribute?.("data-id") || "").toLowerCase();
      const label = String(
        element.getAttribute?.("aria-label") || element.getAttribute?.("title") || "",
      ).toLowerCase();
      return action === "menu" || action === "more" || dataId === "menu" || /menu|more|actions|\u83dc\u5355|\u66f4\u591a/.test(label);
    }) || null;
  }

  function findCardSelectionControl(card) {
    if (!card || typeof card.querySelectorAll !== "function") return null;
    const controls = card.querySelectorAll(
      'input.chkItemSelect, input[type="checkbox"], [role="checkbox"], .checkboxOutline',
    );
    return Array.from(controls).find(control => (
      typeof control.click === "function" && isVisibleElement(control, { allowTransparent: true })
    )) || null;
  }

  function findVisibleMultiSelectMenuItem() {
    if (typeof document.querySelectorAll !== "function") return null;
    const items = document.querySelectorAll(
      'button.actionSheetMenuItem[data-id="multiSelect"], ' +
      '[data-id="multiSelect"].actionSheetMenuItem, ' +
      '[data-id="multiSelect"][role="menuitem"], ' +
      '[data-action="multiSelect"]',
    );
    const visible = Array.from(new Set(items)).filter(isVisibleElement);
    return visible[visible.length - 1] || null;
  }

  function waitForSelectionState(id, expected, timeoutMs = CONFIG.grid16.selectionTimeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    return new Promise(resolve => {
      const check = () => {
        let selected;
        try {
          selected = getSelectedItems().includes(id);
        } catch (_error) {
          resolve(false);
          return;
        }

        if (selected === expected) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline || typeof window.setTimeout !== "function") {
          resolve(false);
          return;
        }
        window.setTimeout(check, 25);
      };
      check();
    });
  }

  async function selectCardFromMenu(card) {
    const trigger = findCardMenuTrigger(card);
    if (!trigger || typeof trigger.click !== "function") {
      throw new Error(`Card ${card?.getAttribute?.("data-id") || "unknown"} has no action menu`);
    }

    trigger.click();
    let menuItem = findVisibleMultiSelectMenuItem();
    const deadline = Date.now() + CONFIG.grid16.selectionTimeoutMs;
    while (!menuItem && Date.now() < deadline && typeof window.setTimeout === "function") {
      await new Promise(resolve => window.setTimeout(resolve, 25));
      menuItem = findVisibleMultiSelectMenuItem();
    }
    if (!menuItem || typeof menuItem.click !== "function") {
      throw new Error("Jellyfin multi-select action is unavailable");
    }
    menuItem.click();
  }

  async function toggleCardSelection(card) {
    const control = findCardSelectionControl(card);
    if (control) {
      control.click();
      return;
    }
    await selectCardFromMenu(card);
  }

  async function ensureGridSelectionMode(targetIds, cardsById, attemptedIds, timeoutMs) {
    const targetCards = targetIds
      .map(id => cardsById.get(id))
      .filter(Boolean);
    if (targetCards.some(card => findCardSelectionControl(card))) return;

    for (const id of targetIds) {
      const card = cardsById.get(id);
      if (!card || getSelectedItems().includes(id)) continue;
      if (!findCardMenuTrigger(card)) continue;

      attemptedIds.push(id);
      await selectCardFromMenu(card);
      if (!(await waitForSelectionState(id, true, timeoutMs))) {
        throw new Error(`Could not confirm selection for card ${id}`);
      }
      return;
    }

    throw new Error("Jellyfin multi-select action is unavailable for the selected media");
  }

  async function rollbackGridSelection(ids, cardsById) {
    for (const id of [...ids].reverse()) {
      try {
        if (!getSelectedItems().includes(id)) continue;
        const card = cardsById.get(id) || getPageCards().find(candidate => candidate.id === id)?.element;
        if (!card) continue;
        await toggleCardSelection(card);
        if (!(await waitForSelectionState(id, false))) {
          log("selection rollback could not be confirmed", id);
        }
      } catch (error) {
        log("selection rollback failed", errorText(error));
      }
    }
  }

  async function syncGrid16Selection(pageCards, selectedIds, options = {}) {
    const limit = options.maxItems ?? CONFIG.grid16.maxItems;
    const plan = planGrid16Targets(pageCards, selectedIds, limit);
    if (!plan.ok) return plan;

    const cardsById = new Map((Array.isArray(pageCards) ? pageCards : []).map(card => [
      getCardId(card),
      typeof card === "string" ? null : card?.element || card,
    ]));
    const attemptedIds = [];

    try {
      await ensureGridSelectionMode(plan.targets, cardsById, attemptedIds, options.timeoutMs);

      for (const id of plan.addedIds) {
        if (getSelectedItems().includes(id)) continue;
        const card = cardsById.get(id);
        if (!card) throw new Error(`Card ${id} is no longer available`);

        attemptedIds.push(id);
        await toggleCardSelection(card);
        if (!(await waitForSelectionState(id, true, options.timeoutMs))) {
          throw new Error(`Could not confirm selection for card ${id}`);
        }
      }

      const finalSelected = getSelectedItems();
      if (plan.targets.some(id => !finalSelected.includes(id))) {
        throw new Error("Jellyfin selection state could not be confirmed");
      }
      return { ...plan, selectedIds: finalSelected, attemptedIds };
    } catch (error) {
      await rollbackGridSelection(attemptedIds, cardsById);
      return {
        ...plan,
        ok: false,
        reason: "selection-sync-failed",
        error: errorText(error),
        attemptedIds,
      };
    }
  }

  function launchUrl(url) {
    if (!document.body) throw new Error("Jellyfin page body is unavailable");

    let scheme = "unknown";
    try {
      scheme = new URL(url).protocol.replace(":", "");
    } catch (_error) {
      scheme = String(url).split(":", 1)[0] || scheme;
    }
    log("launch", { scheme });

    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = url;
    document.body.appendChild(iframe);
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch (error) {
        log("iframe cleanup failed", errorText(error));
      }
    }, CONFIG.launchCleanupMs);
  }

  async function resolveTarget(itemId, options = {}) {
    const item = await getPlayableItem(itemId);
    const url = getStreamUrl(item);
    let subtitle = "";
    try {
      subtitle = getSubtitleUrl(item, { strict: options.strict === true });
    } catch (error) {
      if (options.strict) throw new Error(`Subtitle preparation failed: ${errorText(error)}`);
      log("subtitle skipped", errorText(error));
    }
    return { item, url, subtitle };
  }

  async function resolveTargets(targets, options = {}) {
    const results = await Promise.all(targets.map(async itemId => {
      try {
        return { itemId, value: await resolveTarget(itemId, options) };
      } catch (error) {
        return { itemId, error: errorText(error) };
      }
    }));

    return {
      valid: results.filter(result => result.value).map(result => result.value),
      failed: results.filter(result => result.error),
    };
  }

  function reportFailures(failed, launched) {
    if (!failed.length) return;
    const prefix = launched > 0 ? `${launched} started; ` : "";
    const details = failed.slice(0, 3).map(result => `${result.itemId}: ${result.error}`).join("\n");
    const suffix = failed.length > 3 ? `\n...and ${failed.length - 3} more` : "";
    showError(`${prefix}${failed.length} item(s) could not be played.\n${details}${suffix}`);
  }

  function reportStrictFailures(failed, expected) {
    const details = failed.slice(0, 3).map(result => `${result.itemId}: ${result.error}`).join("\n");
    const suffix = failed.length > 3 ? `\n...and ${failed.length - 3} more` : "";
    const detailText = details ? `\n${details}${suffix}` : "";
    showError(`Grid Play 4x4 requires ${expected} playable items; no MPV windows were started.${detailText}`);
  }

  function getTargets(context) {
    if (context.type === "detail" && context.id) return [context.id];
    if (context.type === "selection" && Array.isArray(context.ids)) return context.ids;
    return [];
  }

  function buildMpvPayload(entries, profile, layout = {}) {
    if (!Array.isArray(entries)) return null;
    const { columns, rows, maxItems } = getLayoutValues(layout);
    const strictCount = Number(layout.strictCount || 0);
    if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1) return null;
    if (!Number.isInteger(maxItems) || maxItems < 1 || entries.length > maxItems) return null;
    if (strictCount > 0 && entries.length !== strictCount) return null;

    return entries.map((entry, index) => ({
      mode: "mpv",
      url: entry.url,
      profile,
      geometry: getGridGeometry(index, entries.length, columns, rows),
      title: `Slot ${index + 1}: ${entry.item.Name || "Untitled"}`,
      sub: entry.subtitle,
    }));
  }

  async function handlePlay(mode, profile, options = {}) {
    const context = getContext();
    const layout = options.layout || {};
    const layoutValues = getLayoutValues(layout);
    const strictCount = Number(options.strictCount ?? layout.strictCount ?? 0);
    const strict = options.strict === true || strictCount > 0;
    const requestedTargets = Array.isArray(options.targets) ? options.targets : getTargets(context);
    const normalizedTargets = uniqueIds(requestedTargets);
    const expected = strictCount > 0 ? strictCount : normalizedTargets.length;

    if (strict && normalizedTargets.length !== expected) {
      reportStrictFailures([], expected);
      return { launched: false, valid: [], failed: [], payload: null };
    }

    const maxItems = Number(options.maxItems ?? layoutValues.maxItems ?? CONFIG.maxItems);
    const targets = strict ? normalizedTargets : normalizedTargets.slice(0, maxItems);
    if (!targets.length) return;

    const { valid, failed } = await resolveTargets(targets, { strict });
    if (strict && (failed.length > 0 || valid.length !== expected)) {
      reportStrictFailures(failed, expected);
      return { launched: false, valid, failed, payload: null };
    }

    if (!valid.length) {
      reportFailures(failed, 0);
      return { launched: false, valid, failed, payload: null };
    }

    if (mode === "mpv") {
      const payload = buildMpvPayload(valid, profile, {
        ...layout,
        maxItems,
        strictCount: strict ? expected : 0,
      });
      if (!payload) {
        if (strict) reportStrictFailures([], expected);
        else showError("MPV payload could not be constructed");
        return { launched: false, valid, failed, payload: null };
      }
      launchUrl(buildGenericUrl(payload));
      reportFailures(failed, valid.length);
      return { launched: true, valid, failed, payload };
    }

    const links = valid.map(entry => {
      if (mode === "pot") return buildPotPlayerNativeUrl(entry.url);
      if (mode === "iina") return buildIinaUrl(entry.url);
      if (mode === "infuse") return buildInfuseUrl(entry.url);
      throw new Error(`Unsupported player mode: ${mode}`);
    });

    const launchTasks = links.map((link, index) => new Promise(resolve => {
      const delay = links.length > 1 ? index * CONFIG.legacyLaunchDelayMs : 0;
      window.setTimeout(() => {
        try {
          launchUrl(link);
        } catch (error) {
          showError(`Player launch failed: ${errorText(error)}`);
        } finally {
          resolve();
        }
      }, delay);
    }));
    await Promise.all(launchTasks);
    reportFailures(failed, links.length);
    return { launched: links.length > 0, valid, failed, payload: null };
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        #${PANEL_ID} { position: fixed; right: 16px; bottom: 16px; z-index: 999999; display: none; gap: 8px; padding: 10px 12px; border-radius: 14px; background: rgba(20,20,20,0.85); backdrop-filter: blur(12px); box-shadow: 0 8px 32px rgba(0,0,0,0.4); align-items: center; transition: all 0.2s; }
        #${PANEL_ID} .jfp-btn { cursor: pointer; border: 0; border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 700; color: #111; background: #eee; white-space: nowrap; transition: transform .08s, background .2s; }
        #${PANEL_ID} .jfp-btn:hover { background: #fff; }
        #${PANEL_ID} .jfp-btn:active { transform: scale(0.96); opacity: 0.9; }
        #${PANEL_ID} .jfp-btn.primary { background: #00a4dc; color: #fff; }
        #${PANEL_ID} .jfp-btn.grid { background: #e0f2f1; color: #00695c; }
        #${PANEL_ID} .jfp-info { font-size: 12px; color: #ccc; margin-left: 4px; font-family: sans-serif; pointer-events: none; }
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    return panel;
  }

  let playbackInProgress = false;
  function runWithPlaybackLock(button, action) {
    if (playbackInProgress || button.disabled) return;
    playbackInProgress = true;
    const panel = button.closest(`#${PANEL_ID}`);
    if (panel) panel.querySelectorAll("button").forEach(control => { control.disabled = true; });
    Promise.resolve()
      .then(action)
      .catch(error => showError(`Playback preparation failed: ${errorText(error)}`))
      .finally(() => {
        playbackInProgress = false;
        if (panel) panel.querySelectorAll("button").forEach(control => { control.disabled = false; });
      });
  }

  function bindPlayButton(button, mode, profile, options) {
    button.onclick = () => runWithPlaybackLock(button, () => handlePlay(mode, profile, options));
  }

  function reportGrid16SelectionFailure(result) {
    if (result.reason === "too-many-selected") {
      showError(`Grid Play 4x4 supports at most ${CONFIG.grid16.maxItems} selected items. Reduce the current selection and try again.`);
      return;
    }
    if (result.reason === "not-enough-page-items") {
      showError(`Grid Play 4x4 requires ${CONFIG.grid16.maxItems} media cards on the current page; only ${result.pageIds.length} are available.`);
      return;
    }
    showError(`Grid Play 4x4 selection failed: ${result.error || result.reason || "unknown error"}`);
  }

  async function handleGrid16Play() {
    const pageCards = getPageCards();
    const selectedIds = getSelectedItems();
    const selection = await syncGrid16Selection(pageCards, selectedIds);
    if (!selection.ok) {
      reportGrid16SelectionFailure(selection);
      return { launched: false, selection, payload: null };
    }

    return handlePlay("mpv", CONFIG.grid16.profile, {
      targets: selection.targets,
      strict: true,
      strictCount: CONFIG.grid16.maxItems,
      layout: {
        columns: CONFIG.grid16.columns,
        rows: CONFIG.grid16.rows,
        maxItems: CONFIG.grid16.maxItems,
        strictCount: CONFIG.grid16.maxItems,
      },
    });
  }

  function renderButtons(panel, context) {
    const os = getOS();
    const rule = CONFIG.showOn[os] || CONFIG.showOn.other;
    panel.innerHTML = "";

    if (context.type === "selection") {
      const count = context.ids.length;
      const button = document.createElement("button");
      button.className = "jfp-btn grid";
      button.textContent = count > 1 ? `Grid Play (${Math.min(count, CONFIG.maxItems)})` : "Play Selected";
      bindPlayButton(button, "mpv", "multi");
      panel.appendChild(button);

      const info = document.createElement("div");
      info.className = "jfp-info";
      info.textContent = count > CONFIG.maxItems ? `(Max ${CONFIG.maxItems})` : "MPV";
      panel.appendChild(info);
    }

    if ((context.type === "listing" || context.type === "selection") && context.pageIds?.length) {
      const grid16 = document.createElement("button");
      grid16.className = "jfp-btn primary";
      grid16.textContent = "Grid Play 4x4 (16)";
      grid16.title = "Play the first 16 media cards on this page in a 4x4 MPV grid";
      grid16.onclick = () => runWithPlaybackLock(grid16, handleGrid16Play);
      panel.appendChild(grid16);
      return;
    }

    if (context.type !== "detail") return;

    if (rule.mpv) {
      const multi = document.createElement("button");
      multi.className = "jfp-btn primary";
      multi.textContent = "MPV (Multi)";
      bindPlayButton(multi, "mpv", "multi");
      panel.appendChild(multi);

      const cinema = document.createElement("button");
      cinema.className = "jfp-btn";
      cinema.textContent = "MPV (Cinema)";
      bindPlayButton(cinema, "mpv", "cinema");
      panel.appendChild(cinema);
    }

    if (rule.pot) {
      const pot = document.createElement("button");
      pot.className = "jfp-btn";
      pot.textContent = "PotPlayer";
      bindPlayButton(pot, "pot");
      panel.appendChild(pot);
    }

    if (rule.iina) {
      const iina = document.createElement("button");
      iina.className = "jfp-btn";
      iina.textContent = "IINA";
      bindPlayButton(iina, "iina");
      panel.appendChild(iina);
    }

    if (rule.infuse) {
      const infuse = document.createElement("button");
      infuse.className = "jfp-btn";
      infuse.textContent = "Infuse";
      bindPlayButton(infuse, "infuse");
      panel.appendChild(infuse);
    }
  }

  function contextKey(context) {
    if (context.type === "selection") return `selection:${context.ids.join(",")}|page:${(context.pageIds || []).join(",")}`;
    if (context.type === "listing") return `listing:${(context.pageIds || []).join(",")}`;
    return `${context.type}:${context.id || ""}`;
  }

  let lastState = "";
  function tick() {
    try {
      const panel = ensurePanel();
      const context = getContext();
      const state = contextKey(context);

      if (state !== lastState) {
        lastState = state;
        log("context changed", context.type);
        if (context.type === "none") {
          panel.style.display = "none";
        } else {
          renderButtons(panel, context);
          panel.style.display = "flex";
        }
      }
    } catch (error) {
      log("context polling failed", errorText(error));
    }
    window.setTimeout(() => window.requestAnimationFrame(tick), 200);
  }

  if (globalThis.__JFP_TEST__) {
    globalThis.__JFP_TEST_API__ = {
      base64Encode,
      buildGenericUrl,
      buildPotPlayerNativeUrl,
      buildIinaUrl,
      buildInfuseUrl,
      buildJellyfinUrl,
      getStreamUrl,
      getSubtitleUrl,
      getPageCards,
      getPageCardIds,
      getContext,
      getSelectedItems,
      findCardMenuTrigger,
      planGrid16Targets,
      getGridGeometry,
      getGeometry,
      findCardSelectionControl,
      buildMpvPayload,
      resolveTarget,
      resolveTargets,
      handlePlay,
      syncGrid16Selection,
      ensureGridSelectionMode,
      toggleCardSelection,
      handleGrid16Play,
      sanitizeLogText,
    };
    return;
  }

  log("v4.4.3 loaded");
  tick();
})();
