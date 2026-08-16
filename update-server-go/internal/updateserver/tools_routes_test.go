package updateserver

import (
	"bytes"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestUploadToolRoundTrip(t *testing.T) {
	dir := t.TempDir()
	_, server, adminToken := newTestServer(t, dir)
	defer server.Close()

	payload := bytes.Repeat([]byte("executor-bytes"), 64)
	status, body := putTool(t, server.URL, adminToken, "narrafork-executor-1.2.3-linux-amd64", payload)
	if status != http.StatusOK {
		t.Fatalf("upload status %d: %s", status, body)
	}

	var result struct {
		Success bool   `json:"success"`
		Size    int64  `json:"size"`
		SHA512  string `json:"sha512"`
	}
	if err := json.Unmarshal([]byte(body), &result); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if !result.Success || result.Size != int64(len(payload)) {
		t.Fatalf("unexpected upload result: %#v", result)
	}
	sum := sha512.Sum512(payload)
	if result.SHA512 != base64.StdEncoding.EncodeToString(sum[:]) {
		t.Fatalf("sha512 mismatch: %s", result.SHA512)
	}

	// The publicly served tools endpoint must return exactly what was uploaded.
	resp, err := http.Get(server.URL + "/api/v2/tools/narrafork-executor-1.2.3-linux-amd64")
	if err != nil {
		t.Fatalf("download tool: %v", err)
	}
	defer resp.Body.Close()
	downloaded, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !bytes.Equal(downloaded, payload) {
		t.Fatalf("download mismatch: status=%d len=%d", resp.StatusCode, len(downloaded))
	}
}

func TestUploadToolAcceptsUploadRoleAndRejectsAnonymous(t *testing.T) {
	dir := t.TempDir()
	app, server, _ := newTestServer(t, dir)
	defer server.Close()

	uploadToken, _, err := app.Config.AddToken("ci", TokenRoleUpload)
	if err != nil {
		t.Fatalf("AddToken: %v", err)
	}
	status, body := putTool(t, server.URL, uploadToken, "narrafork-executor-manifest.json", []byte(`{"version":"1.2.3"}`))
	if status != http.StatusOK {
		t.Fatalf("upload-role status %d: %s", status, body)
	}

	// No Authorization header at all.
	req, _ := http.NewRequest(http.MethodPut, server.URL+"/api/v2/tools/anon-tool", strings.NewReader("x"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("anonymous upload: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous upload should be rejected, got %d", resp.StatusCode)
	}
	if exists, _ := app.Storage.Exists("tools/anon-tool"); exists {
		t.Fatal("anonymous upload must not write a file")
	}
}

func TestUploadToolRejectsUnsafeFilenames(t *testing.T) {
	dir := t.TempDir()
	app, server, token := newTestServer(t, dir)
	defer server.Close()

	// Path traversal, absolute paths and nested paths must never resolve outside
	// the tools directory. Go's ServeMux will not match some of these at all,
	// which is an equally acceptable rejection; the assertion is that nothing
	// gets stored and the response is never a success.
	for _, name := range []string{"..%2f..%2fconfig.json", "..", "%2Fetc%2Fpasswd", "sub%2Ftool", "tool%00"} {
		status, body := putTool(t, server.URL, token, name, []byte("payload"))
		if status == http.StatusOK {
			t.Fatalf("unsafe filename %q was accepted: %s", name, body)
		}
	}

	files, err := app.Storage.ListFiles("tools")
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("unsafe uploads wrote files: %v", files)
	}
}

func TestUploadToolRejectsEmptyBodyWithoutClobbering(t *testing.T) {
	dir := t.TempDir()
	app, server, token := newTestServer(t, dir)
	defer server.Close()

	original := []byte("original-artifact")
	if status, body := putTool(t, server.URL, token, "keeper", original); status != http.StatusOK {
		t.Fatalf("seed upload status %d: %s", status, body)
	}

	status, _ := putTool(t, server.URL, token, "keeper", nil)
	if status != http.StatusBadRequest {
		t.Fatalf("empty upload should be rejected, got %d", status)
	}

	stored, ok, err := app.Storage.GetBytes("tools/keeper")
	if err != nil || !ok || !bytes.Equal(stored, original) {
		t.Fatalf("empty upload clobbered the existing artifact: ok=%v err=%v stored=%q", ok, err, stored)
	}
}

func putTool(t *testing.T, baseURL, token, filename string, payload []byte) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, baseURL+"/api/v2/tools/"+filename, bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put tool: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}
