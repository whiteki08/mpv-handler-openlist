package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
	"gopkg.in/ini.v1"
)

// ==========================================
// 1. 数据结构定义 (Data Structures)
// ==========================================

// Payload 定义了前端传来的标准指令格式
// 扩展性：未来如果需要传字幕、起始时间、音轨，只需在这里加字段
type Payload struct {
	Target   string `json:"mode"`               // 目标播放器: mpv, potplayer
	Url      string `json:"url"`                // 视频地址
	Profile  string `json:"profile,omitempty"`  // MPV 专用: profile 名称
	Geometry string `json:"geometry,omitempty"` // MPV 专用: 窗口位置 (50%x50%+0+0)
	Title    string `json:"title,omitempty"`    // 通用: 窗口标题
	Sub      string `json:"sub,omitempty"`      // 通用: 字幕文件 URL
}

// Config 定义了本地配置文件的结构
type Config struct {
	MpvPath   string
	PotPath   string
	EnableLog bool
	LogPath   string
}

// PlayerHandler 是一个函数类型，用于将通用 Payload 转换为具体播放器的 exec.Cmd
type PlayerHandler func(binPath string, p *Payload) *exec.Cmd

// ==========================================
// 2. 扩展核心：播放器处理器注册表
// ==========================================

// Handlers 映射表：将 "mode" 字符串映射到具体的构建逻辑
// 扩展性：想加 VLC？只需在这里加一行 "vlc": buildVlcCmd，然后在下面写实现函数即可
var Handlers = map[string]PlayerHandler{
	"mpv":       buildMpvCmd,
	"potplayer": buildPotPlayerCmd,
}

// buildMpvCmd 负责构建 MPV 的复杂参数
func buildMpvCmd(binPath string, p *Payload) *exec.Cmd {
	args := []string{p.Url}

	// 动态参数注入
	if p.Profile != "" {
		args = append(args, "--profile="+p.Profile)
	}
	if p.Geometry != "" {
		args = append(args, "--geometry="+p.Geometry)
	}
	if p.Title != "" {
		args = append(args, "--force-media-title="+p.Title)
	}
	if p.Sub != "" {
		args = append(args, "--sub-file="+p.Sub)
	}

	// 强制为了 Video Wall 优化的参数 (可选，防止多开时的焦点抢占问题)
	// args = append(args, "--ontop") 

	return exec.Command(binPath, args...)
}

// buildPotPlayerCmd 负责构建 PotPlayer 的参数
func buildPotPlayerCmd(binPath string, p *Payload) *exec.Cmd {
	// PotPlayer 命令行相对简单，主要传 URL
	// 注意：PotPlayer 对 Title 和 Geometry 的命令行支持不如 MPV 完善
	args := []string{p.Url}
	return exec.Command(binPath, args...)
}

// ==========================================
// 3. 工具函数 (Utils)
// ==========================================

func iniPathForExe(exe string) string {
	dir := filepath.Dir(exe)
	base := strings.TrimSuffix(filepath.Base(exe), filepath.Ext(exe))
	return filepath.Join(dir, base+".ini")
}

func loadConfig() *Config {
	exe, _ := os.Executable()
	defaultLog := filepath.Join(filepath.Dir(exe), "mpv-handler.log")
	cfg := &Config{EnableLog: true, LogPath: defaultLog}

	iniPath := iniPathForExe(exe)
	f, err := ini.Load(iniPath)
	if err == nil {
		sec := f.Section("players")
		cfg.MpvPath = sec.Key("mpv").String()
		cfg.PotPath = sec.Key("potplayer").String()
		
		secLog := f.Section("config")
		cfg.EnableLog = secLog.Key("log").MustBool(true)
	}
	return cfg
}

func writeLog(cfg *Config, msg string) {
	if !cfg.EnableLog {
		return
	}
	f, err := os.OpenFile(cfg.LogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		defer f.Close()
		ts := time.Now().Format("2006-01-02 15:04:05")
		f.WriteString(fmt.Sprintf("%s | %s\n", ts, msg))
	}
}

// parsePayload 解析 jelly-player://<Base64> 协议
func parsePayload(rawURI string) (*Payload, error) {
	prefix := "jelly-player://"
	if !strings.HasPrefix(rawURI, prefix) {
		return nil, fmt.Errorf("invalid scheme, must start with %s", prefix)
	}

	b64Str := strings.TrimPrefix(rawURI, prefix)
	
	// 处理 URL Safe Base64 字符替换
	b64Str = strings.ReplaceAll(b64Str, "-", "+")
	b64Str = strings.ReplaceAll(b64Str, "_", "/")
	
	// 处理 Padding (Base64 长度必须是 4 的倍数)
	if mod := len(b64Str) % 4; mod != 0 {
		b64Str += strings.Repeat("=", 4-mod)
	}

	data, err := base64.StdEncoding.DecodeString(b64Str)
	if err != nil {
		return nil, fmt.Errorf("base64 decode error: %w", err)
	}

	var p Payload
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("json unmarshal error: %w", err)
	}
	return &p, nil
}

// ==========================================
// 4. 注册表操作 (Installer)
// ==========================================

func install(exePath string) {
	scheme := "jelly-player"
	k, _, err := registry.CreateKey(registry.CLASSES_ROOT, scheme, registry.SET_VALUE)
	if err != nil {
		fmt.Printf("Error creating key: %v\n", err)
		return
	}
	defer k.Close()

	k.SetStringValue("", "URL:Jellyfin External Player Protocol")
	k.SetStringValue("URL Protocol", "")

	// Icon
	ik, _, _ := registry.CreateKey(k, "DefaultIcon", registry.SET_VALUE)
	ik.SetStringValue("", fmt.Sprintf("%s,0", exePath))
	ik.Close()

	// Command
	ck, _, err := registry.CreateKey(k, `shell\open\command`, registry.SET_VALUE)
	if err != nil {
		fmt.Printf("Error creating command key: %v\n", err)
		return
	}
	defer ck.Close()

	ck.SetStringValue("", fmt.Sprintf("\"%s\" \"%%1\"", exePath))
	fmt.Printf("Successfully registered protocol: %s://\n", scheme)
}

// ==========================================
// 5. 主程序入口 (Main)
// ==========================================

func main() {
	exe, _ := os.Executable()
	cfg := loadConfig()

	// 没有任何参数时显示帮助
	if len(os.Args) < 2 {
		fmt.Println("Jellyfin Universal Handler")
		fmt.Println("Usage: mpv-handler.exe --install")
		fmt.Println("Usage: jelly-player://<Base64_Payload>")
		return
	}

	arg := os.Args[1]

	// 1. 安装模式
	if arg == "--install" {
		install(exe)
		return
	}

	// 2. 运行模式 (处理协议)
	p, err := parsePayload(arg)
	if err != nil {
		writeLog(cfg, "Protocol Error: "+err.Error())
		return
	}

	// 记录接收到的原始指令
	jsonBytes, _ := json.Marshal(p)
	writeLog(cfg, fmt.Sprintf("Received Payload: %s", string(jsonBytes)))

	// 3. 寻找播放器路径
	var binPath string
	switch p.Target {
	case "mpv":
		binPath = cfg.MpvPath
	case "potplayer":
		binPath = cfg.PotPath
	default:
		writeLog(cfg, "Unknown Target Mode: "+p.Target)
		return
	}

	if binPath == "" {
		writeLog(cfg, fmt.Sprintf("Path not configured for mode: %s", p.Target))
		return
	}

	// 4. 调度执行 (Factory Dispatch)
	handler, ok := Handlers[p.Target]
	if !ok {
		writeLog(cfg, "No handler implementation for: "+p.Target)
		return
	}

	cmd := handler(binPath, p)
	writeLog(cfg, fmt.Sprintf("Executing: %s %v", cmd.Path, cmd.Args))

	if err := cmd.Start(); err != nil {
		writeLog(cfg, "Launch Error: "+err.Error())
	}
}
