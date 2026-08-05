# Jellyfin 外部播放器桥接工具

[English](./README.md)

本项目通过浏览器用户脚本，将 Jellyfin 媒体启动到 MPV、PotPlayer、IINA 或 Infuse。

## 工作方式

用户脚本使用 Jellyfin 的标准视频流地址：

```text
/Videos/{itemId}/stream.{container}
```

查询参数使用正常的 `&` 分隔。MPV 通过 `jelly-player://` 协议交给 Windows Go handler；PotPlayer、IINA、Infuse 保留各自平台的原生 URL schema。

普通 `Grid Play` 仍然最多处理 4 个项目。在 Jellyfin 列表页，用户脚本还会显示 `Grid Play 4x4 (16)`，使用当前页面 DOM 中已经渲染的、按顺序去重后的前 16 个 `div.card[data-id]`，不会请求额外分页内容。

没有已有选择时，4×4 会通过 Jellyfin 卡片菜单的原生多选入口选择前 16 张卡片。已有 1 到 15 项选择时，会保留已有选择，再按页面顺序补足剩余位置。已有选择超过 16 项，或当前页面少于 16 张卡片时，会拒绝操作且不改变已有选择。每次新增选择都会验证实际选中状态；无法确认时会回滚本次新增项。

4×4 使用现有 `jelly-player://` 协议和 MPV 的 `multi` profile。16 个媒体（包括适用时的字幕准备）必须全部成功解析后才会启动 MPV；普通 4 路 MPV 播放仍保留逐项失败隔离。Go handler 一次协议调用最多启动 16 个项目。

## Windows 安装

1. 下载或编译 `mpv-handler.exe`，放到固定目录。
2. 在 exe 同目录创建 `mpv-handler.ini`：

```ini
[players]
mpv=C:\Program Files\mpv\mpv.exe
potplayer=C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe

[config]
log=true
```

3. 使用管理员权限运行 PowerShell，注册 `jelly-player://`：

```powershell
.\mpv-handler.exe --install
```

`--install` 只负责注册协议，不再接受播放器路径参数；播放器路径统一从 INI 读取。

默认日志为 exe 同目录下的 `mpv-handler.log`。日志不会写入媒体 URL 或 API key。

HTTP 播放地址内部始终使用真实的 `&` 分隔查询参数。PotPlayer 继续使用原生 `potplayer://` schema，因此只有外层 schema 会把分隔符编码为 `%26`；MPV、IINA 和 Infuse 收到的仍是解码后的 HTTP 地址。

## MPV 配置

如果需要 4×4、16 路视频墙，在 MPV 的 `portable_config/profiles.conf` 中加入：

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

根据浏览器所在显示器的 Windows 缩放比例调整 `script.js` 顶部的 `osScale`。

## 安装用户脚本

使用 Tampermonkey 或其他用户脚本管理器安装根目录中的 `script.js`，刷新 Jellyfin 页面。媒体详情页和多选媒体时会显示普通播放器按钮；当前页面有已渲染媒体卡片时会显示 `Grid Play 4x4 (16)`，详情页不会显示该按钮。

## 协议格式

```text
jelly-player://<Base64 URL-safe JSON>
```

示例：

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

Go handler 支持的 `mode` 为 `mpv` 和 `potplayer`。当前用户脚本直接使用 PotPlayer 原生 schema，因此 PotPlayer 必须由自身注册原生 URL 协议。

所有 HTTP 地址内部都使用真实的 `&` 查询参数分隔符。PotPlayer 外层的 `potplayer://` URL 会把这些分隔符编码为 `%26`，确保原生解析器保留完整 HTTP 地址；IINA 和 Infuse 仍使用各自的原生 URL 格式。

## 开发与测试

使用 Node.js 运行 JavaScript 测试：

```powershell
node --test tests/script.test.mjs
node --check script.js
```

Go handler 使用 Windows 注册表包，Go 测试应在 Windows 环境运行：

```powershell
go test ./...
go vet ./...
```

不要提交 Jellyfin API key。如果 API key 出现在 URL 或日志中，请立即撤销并重新生成。

## 致谢

项目基于 [mpv-handler-openlist](https://github.com/outlook84/mpv-handler-openlist) 改造。
