package main

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func encodeTestPayload(t *testing.T, value any, encoding *base64.Encoding) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return encoding.EncodeToString(data)
}

func TestParsePayloadSupportsURLSafeAndStandardBase64(t *testing.T) {
	payload := Payload{
		Target:  "mpv",
		Url:     "https://example.test/video.mkv?api_key=token&Static=true",
		Profile: "multi",
	}

	cases := []struct {
		name     string
		encoded  string
		wantSize int
	}{
		{name: "raw url safe", encoded: encodeTestPayload(t, payload, base64.RawURLEncoding), wantSize: 1},
		{name: "padded standard", encoded: encodeTestPayload(t, payload, base64.StdEncoding), wantSize: 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parsed, err := parsePayload(protocolPrefix + tc.encoded)
			if err != nil {
				t.Fatalf("parse payload: %v", err)
			}
			if len(parsed) != tc.wantSize || parsed[0].Url != payload.Url {
				t.Fatalf("unexpected payload: %#v", parsed)
			}
		})
	}
}

func TestParsePayloadSupportsEscapedPayload(t *testing.T) {
	payload := Payload{Target: "mpv", Url: "https://example.test/video.mkv"}
	encoded := encodeTestPayload(t, payload, base64.StdEncoding)
	encoded = strings.ReplaceAll(encoded, "=", "%3D")

	parsed, err := parsePayload(protocolPrefix + encoded)
	if err != nil {
		t.Fatalf("parse escaped payload: %v", err)
	}
	if len(parsed) != 1 || parsed[0].Url != payload.Url {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestParsePayloadSupportsChromiumTrailingSlash(t *testing.T) {
	payload := Payload{Target: "mpv", Url: "https://example.test/video.mkv"}
	encoded := encodeTestPayload(t, payload, base64.RawURLEncoding)

	parsed, err := parsePayload(protocolPrefix + encoded + "/")
	if err != nil {
		t.Fatalf("parse Chromium-normalized payload: %v", err)
	}
	if len(parsed) != 1 || parsed[0].Url != payload.Url {
		t.Fatalf("unexpected payload: %#v", parsed)
	}
}

func TestParsePayloadSupportsArray(t *testing.T) {
	items := []Payload{
		{Target: "mpv", Url: "https://example.test/video-1.mkv"},
		{Target: "potplayer", Url: "https://example.test/video-2.mkv"},
	}

	parsed, err := parsePayload(protocolPrefix + encodeTestPayload(t, items, base64.RawURLEncoding))
	if err != nil {
		t.Fatalf("parse array payload: %v", err)
	}
	if len(parsed) != len(items) || parsed[0].Url != items[0].Url || parsed[1].Target != items[1].Target {
		t.Fatalf("unexpected array payload: %#v", parsed)
	}
}

func TestParsePayloadRejectsInvalidDataWithoutEchoingPayload(t *testing.T) {
	parsed, err := parsePayload(protocolPrefix + "not-valid-base64-secret-token")
	if err == nil || parsed != nil {
		t.Fatalf("expected parse failure, got payload=%#v error=%v", parsed, err)
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("parse error leaked payload: %v", err)
	}

	valid := encodeTestPayload(t, Payload{Target: "mpv", Url: "https://example.test/video.mkv"}, base64.RawURLEncoding)
	for _, invalid := range []string{valid[:2] + "\n" + valid[2:], valid + "?"} {
		if _, err := parsePayload(protocolPrefix + invalid); err == nil {
			t.Fatalf("expected invalid Base64 to be rejected: %q", invalid)
		}
	}
}

func TestParsePayloadRejectsEmptyAndOversizedArrays(t *testing.T) {
	if _, err := parsePayload(protocolPrefix + encodeTestPayload(t, []Payload{}, base64.RawURLEncoding)); err == nil {
		t.Fatal("expected empty array to be rejected")
	}

	items := make([]Payload, maxPayloads+1)
	for i := range items {
		items[i] = Payload{Target: "mpv", Url: "https://example.test/video.mkv"}
	}
	if _, err := parsePayload(protocolPrefix + encodeTestPayload(t, items, base64.RawURLEncoding)); err == nil {
		t.Fatal("expected oversized array to be rejected")
	}
}

func TestValidatePayload(t *testing.T) {
	valid := &Payload{
		Target:   "mpv",
		Url:      "https://example.test/video.mkv",
		Sub:      "https://example.test/subtitle.srt",
		Profile:  "multi",
		Geometry: "1920x1080+0+0",
		Title:    "Video",
	}
	if err := validatePayload(valid); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}

	invalidCases := []*Payload{
		{Target: "unknown", Url: "https://example.test/video.mkv"},
		{Target: "mpv", Url: "file:///tmp/video.mkv"},
		{Target: "mpv", Url: "https://example.test/video.mkv", Sub: "file:///tmp/subtitle.srt"},
		{Target: "mpv", Url: "https://example.test/video.mkv", Profile: "bad profile"},
		{Target: "mpv", Url: "https://example.test/video.mkv", Geometry: "not-geometry"},
		{Target: "mpv", Url: "https://example.test/video.mkv", Title: "line\nbreak"},
	}
	for _, payload := range invalidCases {
		if err := validatePayload(payload); err == nil {
			t.Errorf("expected payload rejection: %#v", payload)
		}
	}
}

func TestBuildMpvCmd(t *testing.T) {
	payload := &Payload{
		Url:      "https://example.test/video.mkv?x=1&y=2",
		Profile:  "multi",
		Geometry: "1920x1080+0+0",
		Title:    "Video",
		Sub:      "https://example.test/subtitle.srt",
	}
	want := []string{
		`C:\mpv\mpv.exe`,
		"--profile=multi",
		"--geometry=1920x1080+0+0",
		"--force-media-title=Video",
		"--sub-file=https://example.test/subtitle.srt",
		"--",
		"https://example.test/video.mkv?x=1&y=2",
	}

	got := buildMpvCmd(want[0], payload).Args
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mpv args = %#v, want %#v", got, want)
	}
}

func TestBuildPotPlayerCmd(t *testing.T) {
	payload := &Payload{Url: "https://example.test/video.mkv"}
	got := buildPotPlayerCmd(`C:\PotPlayer\PotPlayerMini64.exe`, payload).Args
	want := []string{`C:\PotPlayer\PotPlayerMini64.exe`, payload.Url}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PotPlayer args = %#v, want %#v", got, want)
	}
}

func TestSanitizeLogLine(t *testing.T) {
	message := "url=https://example.test/video?api_key=secret&token=another\r\nnext"
	got := sanitizeLogLine(message)
	for _, secret := range []string{"secret", "another"} {
		if strings.Contains(got, secret) {
			t.Fatalf("log contains secret %q: %s", secret, got)
		}
	}
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("log contains a raw line break: %q", got)
	}
}

func TestInstallRejectsUnexpectedPathArgument(t *testing.T) {
	cfg := &Config{ConfigPath: "mpv-handler.ini"}
	if err := run([]string{"--install", `C:\mpv\mpv.exe`}, cfg); err == nil {
		t.Fatal("expected --install path argument to be rejected")
	}
}

func TestRunReportsMissingPlayerPath(t *testing.T) {
	cfg := &Config{ConfigPath: "mpv-handler.ini"}
	payload := encodeTestPayload(t, Payload{Target: "mpv", Url: "https://example.test/video.mkv"}, base64.RawURLEncoding)

	err := run([]string{protocolPrefix + payload}, cfg)
	if err == nil || !strings.Contains(err.Error(), "Player path missing for mpv") {
		t.Fatalf("expected missing player path error, got %v", err)
	}
}

func TestIniPathForExe(t *testing.T) {
	got := iniPathForExe(`C:\Players\mpv-handler.exe`)
	want := `C:\Players\mpv-handler.ini`
	if got != want {
		t.Fatalf("ini path = %q, want %q", got, want)
	}
}
