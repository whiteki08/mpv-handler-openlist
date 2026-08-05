package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/windows/registry"
	"gopkg.in/ini.v1"
)

const (
	protocolPrefix = "jelly-player://"
	maxPayloads    = 16
	launchDelay    = 50 * time.Millisecond
)

var (
	profilePattern  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
	geometryPattern = regexp.MustCompile(`^\d+x\d+[+-]\d+[+-]\d+$`)
	sensitiveQuery  = regexp.MustCompile(`(?i)(api_key|apikey|access_token|token)=([^&\s]+)`)
)

// Payload is the stable wire format carried by jelly-player://.
type Payload struct {
	Target   string `json:"mode"`
	Url      string `json:"url"`
	Profile  string `json:"profile,omitempty"`
	Geometry string `json:"geometry,omitempty"`
	Title    string `json:"title,omitempty"`
	Sub      string `json:"sub,omitempty"`
}

type Config struct {
	ExePath   string
	ConfigPath string
	MpvPath   string
	PotPath   string
	EnableLog bool
	LogPath   string
}

type PlayerHandler func(binPath string, p *Payload) *exec.Cmd

var Handlers = map[string]PlayerHandler{
	"mpv":       buildMpvCmd,
	"potplayer": buildPotPlayerCmd,
}

func buildMpvCmd(binPath string, p *Payload) *exec.Cmd {
	args := make([]string, 0, 10)

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

	// Keep the media URL after -- so a malformed or unusual URL cannot become an option.
	args = append(args, "--", p.Url)
	return exec.Command(binPath, args...)
}

func buildPotPlayerCmd(binPath string, p *Payload) *exec.Cmd {
	return exec.Command(binPath, p.Url)
}

func isBase64Candidate(value string) bool {
	if value == "" {
		return false
	}

	paddingStarted := false
	paddingCount := 0
	for index := 0; index < len(value); index++ {
		char := value[index]
		switch {
		case (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '+' || char == '/' || char == '-' || char == '_':
			if paddingStarted {
				return false
			}
		case char == '=':
			paddingStarted = true
			paddingCount++
			if paddingCount > 2 {
				return false
			}
		default:
			// DecodeString ignores CR/LF. Reject all non-Base64 bytes first so
			// malformed protocol data cannot be silently normalized.
			return false
		}
	}
	return true
}

func decodeBase64Payload(raw string) ([]byte, error) {
	value := raw
	if value == "" {
		return nil, fmt.Errorf("empty payload")
	}

	candidates := []string{value}
	unescaped, err := url.PathUnescape(value)
	if err != nil {
		return nil, fmt.Errorf("invalid URL encoding")
	}
	if unescaped != value {
		candidates = append(candidates, unescaped)
	}

	encodings := []*base64.Encoding{
		base64.RawURLEncoding.Strict(),
		base64.URLEncoding.Strict(),
		base64.RawStdEncoding.Strict(),
		base64.StdEncoding.Strict(),
	}
	for _, candidate := range candidates {
		if !isBase64Candidate(candidate) {
			continue
		}
		for _, encoding := range encodings {
			if decoded, err := encoding.DecodeString(candidate); err == nil {
				return decoded, nil
			}
		}
	}

	return nil, fmt.Errorf("invalid base64 payload")
}

func parsePayload(rawURI string) ([]*Payload, error) {
	if len(rawURI) < len(protocolPrefix) || !strings.EqualFold(rawURI[:len(protocolPrefix)], protocolPrefix) {
		return nil, fmt.Errorf("invalid scheme")
	}

	data, err := decodeBase64Payload(rawURI[len(protocolPrefix):])
	if err != nil {
		return nil, err
	}

	jsonData := bytes.TrimSpace(data)
	if len(jsonData) == 0 {
		return nil, fmt.Errorf("empty JSON payload")
	}

	var results []*Payload
	switch jsonData[0] {
	case '[':
		if err := json.Unmarshal(jsonData, &results); err != nil {
			return nil, fmt.Errorf("invalid JSON array")
		}
	case '{':
		var single Payload
		if err := json.Unmarshal(jsonData, &single); err != nil {
			return nil, fmt.Errorf("invalid JSON object")
		}
		results = []*Payload{&single}
	default:
		return nil, fmt.Errorf("JSON payload must be an object or array")
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("JSON payload contains no items")
	}
	if len(results) > maxPayloads {
		return nil, fmt.Errorf("JSON payload exceeds %d items", maxPayloads)
	}
	return results, nil
}

func validateHTTPURL(value string, field string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is missing", field)
	}
	if strings.ContainsAny(value, "\r\n") {
		return fmt.Errorf("%s contains a line break", field)
	}

	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" {
		return fmt.Errorf("%s is invalid", field)
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("%s must use HTTP or HTTPS", field)
	}
	return nil
}

func validatePayload(p *Payload) error {
	if p == nil {
		return fmt.Errorf("payload is null")
	}

	p.Target = strings.ToLower(strings.TrimSpace(p.Target))
	if _, ok := Handlers[p.Target]; !ok {
		return fmt.Errorf("unknown target %q", p.Target)
	}
	if err := validateHTTPURL(p.Url, "media URL"); err != nil {
		return err
	}
	if p.Sub != "" {
		if err := validateHTTPURL(p.Sub, "subtitle URL"); err != nil {
			return err
		}
	}
	if p.Profile != "" && !profilePattern.MatchString(p.Profile) {
		return fmt.Errorf("profile is invalid")
	}
	if p.Geometry != "" && !geometryPattern.MatchString(p.Geometry) {
		return fmt.Errorf("geometry is invalid")
	}
	if utf8.RuneCountInString(p.Title) > 256 {
		return fmt.Errorf("title is too long")
	}
	if strings.IndexFunc(p.Title, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) >= 0 {
		return fmt.Errorf("title contains a control character")
	}
	return nil
}

func iniPathForExe(exe string) string {
	dir := filepath.Dir(exe)
	base := strings.TrimSuffix(filepath.Base(exe), filepath.Ext(exe))
	return filepath.Join(dir, base+".ini")
}

func cleanConfiguredPath(value string) string {
	value = strings.TrimSpace(value)
	return strings.Trim(value, "\"")
}

func loadConfig() (*Config, error) {
	exe, err := os.Executable()
	if err != nil {
		return &Config{EnableLog: true}, fmt.Errorf("cannot locate executable: %w", err)
	}

	cfg := &Config{
		ExePath:    exe,
		ConfigPath: iniPathForExe(exe),
		EnableLog:  true,
		LogPath:    filepath.Join(filepath.Dir(exe), "mpv-handler.log"),
	}

	file, err := ini.Load(cfg.ConfigPath)
	if err != nil {
		return cfg, fmt.Errorf("cannot load config %s", cfg.ConfigPath)
	}

	players := file.Section("players")
	cfg.MpvPath = cleanConfiguredPath(players.Key("mpv").String())
	cfg.PotPath = cleanConfiguredPath(players.Key("potplayer").String())

	settings := file.Section("config")
	logValue := strings.TrimSpace(settings.Key("log").String())
	if logValue != "" {
		enabled, err := strconv.ParseBool(logValue)
		if err != nil {
			return cfg, fmt.Errorf("invalid log setting in %s", cfg.ConfigPath)
		}
		cfg.EnableLog = enabled
	}
	return cfg, nil
}

func sanitizeLogLine(value string) string {
	value = sensitiveQuery.ReplaceAllString(value, "$1=<redacted>")
	value = strings.ReplaceAll(value, "\r", "\\r")
	value = strings.ReplaceAll(value, "\n", "\\n")
	return value
}

func writeLog(cfg *Config, message string) {
	if cfg == nil || !cfg.EnableLog || cfg.LogPath == "" {
		return
	}

	file, err := os.OpenFile(cfg.LogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer file.Close()

	timestamp := time.Now().Format("2006-01-02 15:04:05")
	_, _ = file.WriteString(fmt.Sprintf("%s | %s\n", timestamp, sanitizeLogLine(message)))
}

func install(exePath string) (err error) {
	if strings.TrimSpace(exePath) == "" {
		return fmt.Errorf("executable path is missing")
	}

	key, _, err := registry.CreateKey(registry.CLASSES_ROOT, "jelly-player", registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("create protocol registry key: %w", err)
	}
	defer func() {
		if closeErr := key.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close protocol registry key: %w", closeErr)
		}
	}()

	if err := key.SetStringValue("", "URL:Jellyfin Universal Player"); err != nil {
		return fmt.Errorf("set protocol description: %w", err)
	}
	if err := key.SetStringValue("URL Protocol", ""); err != nil {
		return fmt.Errorf("set URL Protocol value: %w", err)
	}

	iconKey, _, err := registry.CreateKey(key, "DefaultIcon", registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("create protocol icon key: %w", err)
	}
	defer func() {
		if closeErr := iconKey.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close protocol icon key: %w", closeErr)
		}
	}()

	if err := iconKey.SetStringValue("", fmt.Sprintf("%s,0", exePath)); err != nil {
		return fmt.Errorf("set protocol icon: %w", err)
	}

	commandKey, _, err := registry.CreateKey(key, `shell\open\command`, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("create protocol command key: %w", err)
	}
	defer func() {
		if closeErr := commandKey.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close protocol command key: %w", closeErr)
		}
	}()
	command := fmt.Sprintf("\"%s\" \"%%1\"", exePath)
	if err := commandKey.SetStringValue("", command); err != nil {
		return fmt.Errorf("set protocol command: %w", err)
	}
	return nil
}

func playerPath(cfg *Config, target string) string {
	if cfg == nil {
		return ""
	}
	switch target {
	case "mpv":
		return cfg.MpvPath
	case "potplayer":
		return cfg.PotPath
	default:
		return ""
	}
}

func run(args []string, cfg *Config) error {
	if cfg == nil {
		return fmt.Errorf("configuration is unavailable")
	}
	if len(args) == 0 {
		return nil
	}
	if args[0] == "--install" {
		if len(args) != 1 {
			return fmt.Errorf("usage: --install; configure players in %s", cfg.ConfigPath)
		}
		return install(cfg.ExePath)
	}
	if len(args) != 1 {
		return fmt.Errorf("unexpected command arguments")
	}

	payloads, err := parsePayload(args[0])
	if err != nil {
		return err
	}

	started := 0
	firstFailure := ""
	recordFailure := func(index int, reason string) {
		writeLog(cfg, fmt.Sprintf("[%d] %s", index, reason))
		if firstFailure == "" {
			firstFailure = fmt.Sprintf("[%d] %s", index, reason)
		}
	}

	for index, payload := range payloads {
		if err := validatePayload(payload); err != nil {
			recordFailure(index, fmt.Sprintf("Payload rejected: %v", err))
			continue
		}

		binPath := playerPath(cfg, payload.Target)
		if binPath == "" {
			recordFailure(index, fmt.Sprintf("Player path missing for %s", payload.Target))
			continue
		}
		info, err := os.Stat(binPath)
		if err != nil {
			recordFailure(index, fmt.Sprintf("Player path unavailable for %s", payload.Target))
			continue
		}
		if info.IsDir() {
			recordFailure(index, fmt.Sprintf("Player path is a directory for %s", payload.Target))
			continue
		}

		handler, ok := Handlers[payload.Target]
		if !ok {
			recordFailure(index, fmt.Sprintf("Handler missing for %s", payload.Target))
			continue
		}

		cmd := handler(binPath, payload)
		if cmd == nil {
			recordFailure(index, fmt.Sprintf("Handler returned no command for %s", payload.Target))
			continue
		}
		writeLog(cfg, fmt.Sprintf("[%d] Launching %s geometry=%q", index, payload.Target, payload.Geometry))
		if err := cmd.Start(); err != nil {
			recordFailure(index, fmt.Sprintf("Start error for %s", payload.Target))
			continue
		}
		started++
		if cmd.Process != nil {
			if err := cmd.Process.Release(); err != nil {
				writeLog(cfg, fmt.Sprintf("[%d] Process handle release failed for %s", index, payload.Target))
			}
		}
		time.Sleep(launchDelay)
	}

	if started == 0 {
		if firstFailure != "" {
			return fmt.Errorf("no player process was started: %s", firstFailure)
		}
		return fmt.Errorf("no player process was started")
	}
	return nil
}

func reportError(cfg *Config, err error) {
	if err == nil {
		return
	}
	message := sanitizeLogLine(err.Error())
	writeLog(cfg, "Error: "+message)
	_, _ = fmt.Fprintln(os.Stderr, message)
}

func main() {
	if len(os.Args) < 2 {
		return
	}

	cfg, configErr := loadConfig()
	args := os.Args[1:]
	if configErr != nil {
		reportError(cfg, configErr)
		return
	}

	if err := run(args, cfg); err != nil {
		reportError(cfg, err)
	}
}
