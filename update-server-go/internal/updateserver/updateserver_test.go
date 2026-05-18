package updateserver

import (
	"bytes"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitConfigCreatesAdminToken(t *testing.T) {
	dir := t.TempDir()
	store, token, err := InitConfig(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("InitConfig: %v", err)
	}
	if !strings.HasPrefix(token, "nfup_") {
		t.Fatalf("expected generated token, got %q", token)
	}
	if _, ok := store.FindToken(token); !ok {
		t.Fatalf("generated token not accepted")
	}
	cfg := store.Config()
	if cfg.Port != 7780 || cfg.Host != "localhost" || cfg.DataDir != "./data" || !cfg.CORS.Enabled || len(cfg.CORS.Origins) != 1 || cfg.CORS.Origins[0] != "*" {
		t.Fatalf("unexpected default config: %#v", cfg)
	}
}

func TestCompareVersionsHandlesPrerelease(t *testing.T) {
	if CompareVersions("1.2.0", "1.2.0-beta.1") <= 0 {
		t.Fatalf("stable release should sort after prerelease")
	}
	if CompareVersions("1.2.0-beta.2", "1.2.0-beta.1") <= 0 {
		t.Fatalf("numeric prerelease identifiers should be ordered")
	}
	if CompareVersions("1.2.1", "1.2.0") <= 0 {
		t.Fatalf("patch version should be ordered")
	}
}

func TestUploadReleaseRequiresPatchAndMatchingMetadata(t *testing.T) {
	dir := t.TempDir()
	_, server, token := newTestServer(t, dir)
	defer server.Close()

	fields := map[string]string{"version": "1.1.0", "channel": "stable", "platform": "linux-x64", "filename": "narrafork-1.1.0-linux-x64", "size": "10", "sha512": "sha-110"}
	status, body := postMultipart(t, server.URL+"/api/v2/products/narrafork/releases", token, fields, nil)
	if status != http.StatusBadRequest || !strings.Contains(body, "zstdPatch") {
		t.Fatalf("expected missing patch rejection, got status=%d body=%s", status, body)
	}

	badMeta := zstdMeta("1.0.0", "1.1.0", 99, 10, "sha-110")
	files := map[string]namedBytes{
		"zstdPatch":     {name: "narrafork-1.1.0-linux-x64.zstd-patch", data: []byte("short")},
		"zstdPatchMeta": {name: "narrafork-1.1.0-linux-x64.zstd-patch.meta.json", data: mustJSON(t, badMeta)},
	}
	status, body = postMultipart(t, server.URL+"/api/v2/products/narrafork/releases", token, fields, files)
	if status != http.StatusBadRequest || !strings.Contains(body, "does not match") {
		t.Fatalf("expected metadata mismatch rejection, got status=%d body=%s", status, body)
	}
}

func TestLatestRequiresReachablePatchPath(t *testing.T) {
	dir := t.TempDir()
	app, server, _ := newTestServer(t, dir)
	defer server.Close()
	meta := ReleaseMeta{
		Version:     "1.1.0",
		Channel:     "stable",
		ReleaseDate: "2026-05-18T00:00:00Z",
		Platforms: map[string]PlatformFileInfo{
			"linux-x64": {Filename: "narrafork-1.1.0-linux-x64", Size: 1100, SHA512: "sha-110", HasZstdPatch: false},
		},
	}
	writeJSONFile(t, filepath.Join(dir, "data", "products", "narrafork", "releases", "1.1.0", "meta.json"), meta)
	app.Cache.Invalidate("narrafork")
	latest := getLatest(t, server.URL, "narrafork", "stable", "linux-x64", "1.0.0")
	if latest.UpdateAvailable {
		t.Fatalf("expected no update without direct patch or complete chain, got %#v", latest)
	}
}

func TestLatestDirectPatchAndPatchChainFromTSDataLayout(t *testing.T) {
	dir := t.TempDir()
	app, server, token := newTestServer(t, dir)
	defer server.Close()

	uploadDeltaOnly(t, server.URL, token, "1.1.0", "stable", "linux-x64", "narrafork-1.1.0-linux-x64", 1100, "sha-110", zstdMeta("1.0.0", "1.1.0", 111, 1100, "sha-110"))
	direct := getLatest(t, server.URL, "narrafork", "stable", "linux-x64", "1.0.0")
	if !direct.UpdateAvailable || direct.Version != "1.1.0" || direct.ZstdPatch == nil || direct.ZstdPatch.FromVersion != "1.0.0" || direct.ZstdPatch.PatchSize != 111 {
		t.Fatalf("unexpected direct patch response: %#v", direct)
	}
	if direct.ZstdPatch.URL != "/api/v2/products/narrafork/releases/1.1.0/zstd-patch/narrafork-1.1.0-linux-x64" {
		t.Fatalf("unexpected direct patch URL: %q", direct.ZstdPatch.URL)
	}

	uploadDeltaOnly(t, server.URL, token, "1.2.0", "stable", "linux-x64", "narrafork-1.2.0-linux-x64", 1200, "sha-120", zstdMeta("1.1.0", "1.2.0", 222, 1200, "sha-120"))
	chain := getLatest(t, server.URL, "narrafork", "stable", "linux-x64", "1.0.0")
	if chain.Version != "1.2.0" || chain.ZstdPatch != nil || len(chain.PatchChain) != 2 {
		t.Fatalf("expected two-step patch chain to latest, got %#v", chain)
	}
	if chain.PatchChain[0].FromVersion != "1.0.0" || chain.PatchChain[0].ToVersion != "1.1.0" || chain.PatchChain[1].FromVersion != "1.1.0" || chain.PatchChain[1].ToVersion != "1.2.0" {
		t.Fatalf("unexpected chain: %#v", chain.PatchChain)
	}
	if len(chain.ReleaseNotesPerVersion) != 2 {
		t.Fatalf("expected release notes per version for chain, got %#v", chain.ReleaseNotesPerVersion)
	}

	manualDir := filepath.Join(dir, "data", "products", "narrafork", "releases", "2.0.0", "linux-x64")
	if err := os.MkdirAll(manualDir, 0o755); err != nil {
		t.Fatalf("mkdir manual fixture: %v", err)
	}
	manualMeta := ReleaseMeta{
		Version:     "2.0.0",
		Channel:     "beta",
		ReleaseDate: "2026-05-18T00:00:00Z",
		Platforms: map[string]PlatformFileInfo{
			"linux-x64": {Filename: "narrafork-2.0.0-linux-x64", Size: 2000, SHA512: "sha-200", HasZstdPatch: true},
		},
	}
	manualPatchMeta := zstdMeta("1.2.0", "2.0.0", 333, 2000, "sha-200")
	writeJSONFile(t, filepath.Join(dir, "data", "products", "narrafork", "releases", "2.0.0", "meta.json"), manualMeta)
	writeJSONFile(t, filepath.Join(manualDir, "narrafork-2.0.0-linux-x64.zstd-patch.meta.json"), manualPatchMeta)
	if err := os.WriteFile(filepath.Join(manualDir, "narrafork-2.0.0-linux-x64.zstd-patch"), bytes.Repeat([]byte("p"), int(manualPatchMeta.PatchSize)), 0o644); err != nil {
		t.Fatalf("write manual patch: %v", err)
	}
	app.Cache.Invalidate("narrafork")
	manual := getLatest(t, server.URL, "narrafork", "beta", "linux-x64", "1.2.0")
	if manual.Version != "2.0.0" || manual.ZstdPatch == nil || manual.ZstdPatch.PatchSize != 333 {
		t.Fatalf("Go server did not read TS-style data layout: %#v", manual)
	}
}

func TestDownloadRangeMultipartAndPromote(t *testing.T) {
	dir := t.TempDir()
	app, server, token := newTestServer(t, dir)
	defer server.Close()

	payload := []byte("abcdefghijklmnopqrstuvwxyz")
	filename := "narrafork-3.0.1-linux-x64"
	sha := sha512Base64(payload)
	uploadDeltaOnly(t, server.URL, token, "3.0.1", "beta", "linux-x64", filename, int64(len(payload)), sha, zstdMeta("3.0.0", "3.0.1", 17, int64(len(payload)), sha))
	if err := app.Storage.SaveBytes("products/narrafork/releases/3.0.1/linux-x64/"+filename, payload); err != nil {
		t.Fatalf("seed downloadable file: %v", err)
	}

	req, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v2/products/narrafork/releases/3.0.1/download/narrafork-3.0.1-linux-x64", nil)
	req.Header.Set("Range", "bytes=0-2,5-7")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("range request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusPartialContent || !strings.Contains(resp.Header.Get("Content-Type"), "multipart/byteranges") || !bytes.Contains(body, []byte("abc")) || !bytes.Contains(body, []byte("fgh")) {
		t.Fatalf("unexpected multipart range response: status=%d content-type=%q body=%q", resp.StatusCode, resp.Header.Get("Content-Type"), string(body))
	}

	promoteReq, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v2/products/narrafork/releases/3.0.1/promote", strings.NewReader(`{"channel":"stable"}`))
	promoteReq.Header.Set("Authorization", "Bearer "+token)
	promoteReq.Header.Set("Content-Type", "application/json")
	promoteResp, err := http.DefaultClient.Do(promoteReq)
	if err != nil {
		t.Fatalf("promote: %v", err)
	}
	defer promoteResp.Body.Close()
	if promoteResp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(promoteResp.Body)
		t.Fatalf("promote status %d: %s", promoteResp.StatusCode, data)
	}
	stable := getLatest(t, server.URL, "narrafork", "stable", "linux-x64", "3.0.0")
	if stable.Version != "3.0.1" || stable.File == nil || stable.File.Size != int64(len(payload)) {
		t.Fatalf("promoted release not visible as stable: %#v", stable)
	}
}

func newTestServer(t *testing.T, dir string) (*App, *httptest.Server, string) {
	t.Helper()
	store, token, err := InitConfig(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("InitConfig: %v", err)
	}
	storage, err := NewLocalStorage(store.DataDir())
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	app := NewApp(store, storage)
	return app, httptest.NewServer(app.Handler()), token
}

func uploadDeltaOnly(t *testing.T, baseURL, token, version, channel, platform, filename string, size int64, sha string, patchMeta ZstdPatchMeta) {
	t.Helper()
	patchData := bytes.Repeat([]byte("p"), int(patchMeta.PatchSize))
	fields := map[string]string{"version": version, "channel": channel, "platform": platform, "filename": filename, "size": jsonNumber(size), "sha512": sha, "releaseNotes": `{"en":"notes"}`}
	files := map[string]namedBytes{
		"zstdPatch":     {name: filename + ".zstd-patch", data: patchData},
		"zstdPatchMeta": {name: filename + ".zstd-patch.meta.json", data: mustJSON(t, patchMeta)},
	}
	doMultipart(t, baseURL+"/api/v2/products/narrafork/releases", token, fields, files)
}

type namedBytes struct {
	name string
	data []byte
}

func doMultipart(t *testing.T, url, token string, fields map[string]string, files map[string]namedBytes) {
	t.Helper()
	status, body := postMultipart(t, url, token, fields, files)
	if status != http.StatusOK {
		t.Fatalf("upload status %d: %s", status, body)
	}
}

func postMultipart(t *testing.T, url, token string, fields map[string]string, files map[string]namedBytes) (int, string) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("field %s: %v", key, err)
		}
	}
	for key, file := range files {
		part, err := writer.CreateFormFile(key, file.name)
		if err != nil {
			t.Fatalf("file %s: %v", key, err)
		}
		if _, err := part.Write(file.data); err != nil {
			t.Fatalf("write file %s: %v", key, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req, _ := http.NewRequest(http.MethodPost, url, &buf)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("upload request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func getLatest(t *testing.T, baseURL, product, channel, platform, version string) CheckUpdateResponse {
	t.Helper()
	url := baseURL + "/api/v2/products/" + product + "/releases/latest?channel=" + channel + "&platform=" + platform + "&version=" + version
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("latest request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("latest status %d: %s", resp.StatusCode, body)
	}
	var out CheckUpdateResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode latest: %v", err)
	}
	return out
}

func zstdMeta(from, to string, patchSize, newSize int64, sha string) ZstdPatchMeta {
	return ZstdPatchMeta{FromVersion: from, ToVersion: to, PatchSize: patchSize, NewFileSize: newSize, NewFileSHA512: sha, Mode: "patch-from"}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json marshal: %v", err)
	}
	return data
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, mustJSON(t, value), 0o644); err != nil {
		t.Fatalf("write json: %v", err)
	}
}

func jsonNumber(value int64) string {
	return strings.TrimSpace(string(mustJSONNoT(value)))
}

func mustJSONNoT(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

func sha512Base64(data []byte) string {
	sum := sha512.Sum512(data)
	return base64.StdEncoding.EncodeToString(sum[:])
}
