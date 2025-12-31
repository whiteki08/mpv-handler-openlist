# English Version

# Jellyfin MPV Desktop Bridge (Fork)

[中文](./README_zh.md)

An advanced bridge tool for local players, heavily refactored from [mpv-handler-openlist](https://github.com/outlook84/mpv-handler-openlist).

While this project started as a fork, it has evolved into a completely new beast. We have replaced the basic URL handling with a powerful **Universal Jelly-Player Schema**, designed specifically to bring a **desktop-class multi-window concurrent playback experience** to Jellyfin/Emby Web clients.

## Key Innovations

1. **Universal Protocol Architecture**
* Replaced the legacy `mpv://` with the versatile `jelly-player://` protocol.
* **JSON Payload**: Transmits complex metadata via Base64-encoded JSON, including window geometry, subtitles, MPV profiles, and titles.


2. **Batch Concurrent Processing**
* **Bypassing Browser Limits**: The frontend sends a single array payload containing multiple video instructions.
* **Instant Launch**: The Go backend parses the batch and launches 4+ MPV processes simultaneously, completely avoiding browser popup blockers and focus-stealing issues.


3. **Smart Video Wall**
* **Pixel-Perfect Layout**: Works with the companion UserScript to calculate physical pixel coordinates based on OS DPI.
* **Immersive Experience**: Supports full-screen 2x2 grids that cover the taskbar, or work-area aware layouts.
* **Auto-Subtitles**: Automatically fetches external subtitle URLs from the Jellyfin API and passes them to MPV.


4. **Full-Stack Integration**
* This is not just a handler; it's a system comprising a **Go Backend** and a **Frontend UserScript**.



## Installation

### Step 1: Deploy Backend

1. Download `mpv-handler.exe` from Releases.
2. Place it in a permanent folder (e.g., inside your MPV folder).
3. Run CMD/PowerShell as Administrator and execute:
```shell
.\mpv-handler.exe --install "D:\Path\To\Your\mpv.exe"

```


*This registers the `jelly-player://` protocol.*

### Step 2: Configure MPV (Critical)

To achieve the seamless video wall effect, add this to your MPV `portable_config/profiles.conf`:

```ini
[multi]
profile-desc=Jellyfin Video Wall
# Disable snapping and borders for seamless tiling
snap-window=no
border=no
ontop=yes
# Disable auto-fit, obey frontend geometry strictly
autofit=no
keepaspect-window=no
# Optimization
osc=no
osd-level=0
force-window=immediate

```

### Step 3: Install UserScript

1. Install Tampermonkey in your browser.
2. Install `script.js` found in the root of this repo.
3. Edit the script configuration to match your **Windows Scaling** (e.g., `osScale: 2.0`).
4. Refresh Jellyfin, select multiple videos, and click **"Grid Play"**.

## Protocol Specification

Protocol: `jelly-player://<Base64_Safe_URL_Encoded_JSON>`

Advanced users can utilize this schema to drive MPV from other web apps. The payload supports both single objects and arrays (for batch execution).

## Credits

Forked from [mpv-handler-openlist](https://github.com/outlook84/mpv-handler-openlist). We pay tribute to the original author for providing the solid foundation that made this advanced innovation possible.
