// mpv-handler.go
package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows/registry"
	"gopkg.in/ini.v1"
)

// Config holds external settings loaded/saved via ini
type Config struct {
	MpvPath        string
	EnableLog      bool
	LogPath        string
	UserAgentMap   map[string]string
	SchemeProfiles map[string]string // scheme -> profile name
}

// iniPathForExe returns "<exeBase>.ini" in exe dir
func iniPathForExe(exe string) string {
	dir := filepath.Dir(exe)
	base := strings.TrimSuffix(filepath.Base(exe), filepath.Ext(exe))
	return filepath.Join(dir, base+".ini")
}

// loadConfig reads the configuration file from the executable's directory.
func loadConfig() (*Config, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("could not determine executable path: %w", err)
	}
	iniPath := iniPathForExe(exe)

	defaultLogPath := filepath.Join(filepath.Dir(exe), "mpv-handler.log")
	defaultConfig := &Config{
		MpvPath:        "",
		EnableLog:      false,
		LogPath:        defaultLogPath,
		UserAgentMap:   make(map[string]string),
		SchemeProfiles: map[string]string{"mpv": "multi", "mpv-cinema": "cinema"},
	}

	loadOpts := ini.LoadOptions{
		Insensitive:         true,
		IgnoreInlineComment: true,
	}

	cfgFile, err := ini.LoadSources(loadOpts, iniPath)
	if err != nil {
		// No ini yet -> return defaults
		return defaultConfig, nil
	}

	sec := cfgFile.Section("mpv-handler")
	defaultConfig.MpvPath = sec.Key("mpvPath").MustString("")
	defaultConfig.EnableLog = sec.Key("enableLog").MustBool(false)
	defaultConfig.LogPath = sec.Key("logPath").MustString(defaultLogPath)

	secUserAgents := cfgFile.Section("UserAgents")
	if secUserAgents != nil {
		defaultConfig.UserAgentMap = secUserAgents.KeysHash()
	}

	secSchemes := cfgFile.Section("Schemes")
	if secSchemes != nil {
		for _, k := range secSchemes.Keys() {
			// e.g. mpv=multi, mpv-cinema=cinema
			defaultConfig.SchemeProfiles[strings.TrimSpace(k.Name())] = strings.TrimSpace(k.Value())
		}
	}

	return defaultConfig, nil
}

// saveConfig writes config back to ini, preserving format where possible.
func saveConfig(cfg *Config) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not determine executable path: %w", err)
	}
	iniPath := iniPathForExe(exe)

	loadOpts := ini.LoadOptions{
		Insensitive:         true,
		IgnoreInlineComment: true,
	}
	file, err := ini.LoadSources(loadOpts, iniPath)
	if err != nil {
		file = ini.Empty()
	}

	sec, _ := file.GetSection("mpv-handler")
	if sec == nil {
		sec, _ = file.NewSection("mpv-handler")
	}
	sec.Key("mpvPath").SetValue(cfg.MpvPath)
	sec.Key("enableLog").SetValue(fmt.Sprintf("%v", cfg.EnableLog))
	sec.Key("logPath").SetValue(cfg.LogPath)

	file.DeleteSection("UserAgents")
	uaSec, _ := file.NewSection("UserAgents")
	for pattern, ua := range cfg.UserAgentMap {
		uaSec.Key(pattern).SetValue(ua)
	}

	file.DeleteSection("Schemes")
	sSec, _ := file.NewSection("Schemes")
	for scheme, profile := range cfg.SchemeProfiles {
		sSec.Key(scheme).SetValue(profile)
	}

	return file.SaveTo(iniPath)
}

// writeLog appends a message if enabled
func writeLog(enable bool, logPath, msg string) {
	if !enable {
		return
	}
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	line := fmt.Sprintf("%s | %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
	_, _ = f.WriteString(line)
}

// installProtocol registers a custom URL scheme
func installProtocol(scheme, exePath string) error {
	key, _, err := registry.CreateKey(registry.CLASSES_ROOT, scheme, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()

	key.SetStringValue("", "URL:"+strings.ToUpper(scheme)+" Protocol")
	key.SetStringValue("URL Protocol", "")

	iconKey, _, err := registry.CreateKey(key, `DefaultIcon`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer iconKey.Close()
	iconKey.SetStringValue("", exePath+",0")

	cmdKey, _, err := registry.CreateKey(key, `shell\open\command`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer cmdKey.Close()
	// "%1" is the full URL
	cmdKey.SetStringValue("", fmt.Sprintf("\"%s\" \"%%1\"", exePath))
	return nil
}

// uninstallProtocol removes a custom URL scheme
func uninstallProtocol(scheme string) error {
	keysToDelete := []string{
		fmt.Sprintf(`%s\shell\open\command`, scheme),
		fmt.Sprintf(`%s\shell\open`, scheme),
		fmt.Sprintf(`%s\shell`, scheme),
		fmt.Sprintf(`%s\DefaultIcon`, scheme),
		scheme,
	}
	for _, keyPath := range keysToDelete {
		err := registry.DeleteKey(registry.CLASSES_ROOT, keyPath)
		if err != nil && err != syscall.ENOENT {
			return fmt.Errorf("failed to delete registry key %q: %w", keyPath, err)
		}
	}
	return nil
}

// extractSchemeAndPayload returns (scheme, payload) from "scheme://payload"
func extractSchemeAndPayload(raw string) (string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return "", "", fmt.Errorf("invalid url: %s", raw)
	}
	scheme := u.Scheme
	// We want everything after "scheme://"
	prefix := scheme + "://"
	if !strings.HasPrefix(raw, prefix) {
		return "", "", fmt.Errorf("invalid url prefix")
	}
	return scheme, raw[len(prefix):], nil
}

// handleURL processes the URL and launches mpv with profile + UA + URL
func handleURL(raw string, cfg *Config) error {
	writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Raw URL: %s", raw))

	scheme, payload, err := extractSchemeAndPayload(raw)
	if err != nil {
		writeLog(cfg.EnableLog, cfg.LogPath, "Invalid scheme/url: "+err.Error())
		return err
	}
	writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Scheme: %s", scheme))
	writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Payload: %s", payload))

	decoded, err := url.QueryUnescape(payload)
	if err != nil {
		writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Decode error: %v", err))
		return err
	}
	decoded = strings.TrimSuffix(decoded, "/") // 防你之前那种末尾误带 /
	writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Decoded URL: %s", decoded))

	if _, err := os.Stat(cfg.MpvPath); err != nil {
		writeLog(cfg.EnableLog, cfg.LogPath, "mpv not found at: "+cfg.MpvPath)
		return err
	}

	args := []string{}

	// scheme -> profile
	if profile, ok := cfg.SchemeProfiles[scheme]; ok && strings.TrimSpace(profile) != "" {
		args = append(args, "--profile="+profile)
		writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Using profile: %s", profile))
	}

	// user-agent mapping based on URL path
	userAgent := ""
	parsedURL, err := url.Parse(decoded)
	if err == nil && parsedURL.Path != "" {
		for pathPattern, ua := range cfg.UserAgentMap {
			if strings.Contains(parsedURL.Path, pathPattern) {
				userAgent = ua
				writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Found matching UA for pattern '%s'. Using UA: %s", pathPattern, userAgent))
				break
			}
		}
	}

	if userAgent != "" {
		args = append(args, "--user-agent="+userAgent)
	}

	args = append(args, decoded)
	writeLog(cfg.EnableLog, cfg.LogPath, fmt.Sprintf("Executing: %s %s", cfg.MpvPath, strings.Join(args, " ")))
	return exec.Command(cfg.MpvPath, args...).Start()
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error getting executable path:", err)
		os.Exit(1)
	}

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error loading configuration:", err)
		os.Exit(1)
	}

	// CLI
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--install":
			// Usage:
			// mpv-handler --install --scheme mpv "F:\MPV\mpv-lazy\mpv.exe"
			if len(os.Args) != 5 || os.Args[2] != "--scheme" {
				fmt.Fprintln(os.Stderr, "Usage: mpv-handler --install --scheme <scheme> \"<path-to-mpv.exe>\"")
				os.Exit(1)
			}
			scheme := os.Args[3]
			mpvPath := os.Args[4]
			if _, err := os.Stat(mpvPath); err != nil {
				fmt.Fprintf(os.Stderr, "Error: mpv.exe not found at the specified path: %s\n", mpvPath)
				os.Exit(1)
			}
			cfg.MpvPath = mpvPath
			// 如果 ini 没写 Schemes，就保留默认 mpv=multi / mpv-cinema=cinema
			if err := saveConfig(cfg); err != nil {
				fmt.Fprintln(os.Stderr, "Failed to save config:", err)
				os.Exit(1)
			}
			if err := installProtocol(scheme, exe); err != nil {
				fmt.Fprintln(os.Stderr, "Install failed:", err)
				os.Exit(1)
			}
			fmt.Println("Protocol installed:", scheme)
			return

		case "--uninstall":
			// Usage:
			// mpv-handler --uninstall --scheme mpv
			if len(os.Args) != 4 || os.Args[2] != "--scheme" {
				fmt.Fprintln(os.Stderr, "Usage: mpv-handler --uninstall --scheme <scheme>")
				os.Exit(1)
			}
			scheme := os.Args[3]
			if err := uninstallProtocol(scheme); err != nil {
				fmt.Fprintln(os.Stderr, "Uninstall failed:", err)
				os.Exit(1)
			}
			fmt.Println("Protocol uninstalled:", scheme)
			return
		default:
			// Treat as URL
			if err := handleURL(os.Args[1], cfg); err != nil {
				os.Exit(2)
			}
			return
		}
	}

	fmt.Println("mpv-handler: A protocol handler for mpv.")
	fmt.Println("Usage:")
	fmt.Println("  mpv-handler --install --scheme <scheme> \"<full-path-to-mpv.exe>\"")
	fmt.Println("  mpv-handler --uninstall --scheme <scheme>")
	fmt.Println("\nExample:")
	fmt.Println("  mpv-handler --install --scheme mpv \"F:\\MPV\\mpv-lazy\\mpv.exe\"")
	fmt.Println("  mpv-handler --install --scheme mpv-cinema \"F:\\MPV\\mpv-lazy\\mpv.exe\"")
	fmt.Println("\nConfig stored in <exeName>.ini next to the executable.")
}
