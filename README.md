# Jellyfin External Player Bridge

[中文](./README_zh.md)

This project launches Jellyfin media in MPV, PotPlayer, IINA, or Infuse from a browser userscript.

## How It Works

The userscript builds the canonical Jellyfin stream endpoint:

```text
/Videos/{itemId}/stream.{container}
```

It passes API parameters with normal query separators (`&`). MPV uses the `jelly-player://` protocol and the Windows Go handler. PotPlayer, IINA, and Infuse keep their native platform URL schemes.

Normal `Grid Play` remains limited to four items. On a Jellyfin listing page, the userscript also shows `Grid Play 4x4 (16)`, which uses the first sixteen unique `div.card[data-id]` elements currently rendered in the page DOM. It does not request additional pages.

When no items are selected, 4x4 selects those first sixteen cards through Jellyfin's native card menu. When one to fifteen items are already selected, it preserves them and fills the remaining slots in page order. More than sixteen existing selections, or fewer than sixteen cards on the current page, are rejected without changing the selection. Every selection change is verified; an unconfirmed change is rolled back.

4x4 uses the existing `jelly-player://` protocol and the MPV `multi` profile. All sixteen media items, including subtitle preparation when applicable, must resolve successfully before any MPV process is launched. Normal four-item MPV playback keeps its per-item failure isolation. The Go handler accepts a single payload or an array and limits one protocol call to sixteen items.

## Windows Installation

1. Download or build `mpv-handler.exe` and place it in a permanent directory.
2. Create `mpv-handler.ini` next to the executable:

```ini
[players]
mpv=C:\Program Files\mpv\mpv.exe
potplayer=C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe

[config]
log=true
```

3. Run the following command as an administrator to register `jelly-player://`:

```powershell
.\mpv-handler.exe --install
```

`--install` only registers the protocol. It does not accept a player path; configure paths in the INI file instead.

The default log file is `mpv-handler.log` next to the executable. URLs and API keys are not written to the log.

The HTTP URL itself always uses real `&` query separators. PotPlayer keeps its native `potplayer://` schema, so only the outer schema escapes those separators as `%26`; MPV, IINA, and Infuse receive the decoded HTTP URL.

## MPV Profiles

For a 4x4, sixteen-window video wall, configure the `multi` profile in MPV's `portable_config/profiles.conf`:

```ini
[multi]
profile-desc=Jellyfin Video Wall
snap-window=no
border=no
ontop=yes
autofit=no
keepaspect-window=no
osc=no
osd-level=0
force-window=immediate
```

Set `osScale` at the top of `script.js` to match the Windows display scaling used by the browser.

## Userscript

Install `script.js` with Tampermonkey or another userscript manager, then refresh Jellyfin. The regular player buttons appear on item details pages and when selecting media items. A listing page with rendered media cards shows `Grid Play 4x4 (16)`; detail pages do not show that button.

## Protocol

```text
jelly-player://<Base64 URL-safe JSON>
```

Example:

```json
[
  {
    "mode": "mpv",
    "url": "https://server/Videos/item-id/stream.mkv?api_key=TOKEN&Static=true&MediaSourceId=source-id&jfp=1",
    "sub": "https://server/Videos/item-id/source-id/Subtitles/2/Stream.srt?api_key=TOKEN",
    "profile": "multi",
    "geometry": "1920x1080+0+0",
    "title": "Video 1"
  }
]
```

Supported `mode` values in the Go handler are `mpv` and `potplayer`. The userscript currently uses the native PotPlayer scheme directly, so PotPlayer must have its native URL scheme registered by the application.

The HTTP URL inside every payload uses real `&` query separators. PotPlayer's outer `potplayer://` URL encodes those separators as `%26` so its native parser keeps the complete HTTP URL; IINA and Infuse keep their native URL formats as well.

## Development

Run the JavaScript tests with Node.js:

```powershell
node --test tests/script.test.mjs
node --check script.js
```

The Go tests require Windows because the handler uses the Windows registry package:

```powershell
go test ./...
go vet ./...
```

Never commit a Jellyfin API key. If a key is exposed in a URL or log, revoke it and create a replacement.

## Credits

Based on [mpv-handler-openlist](https://github.com/outlook84/mpv-handler-openlist).
