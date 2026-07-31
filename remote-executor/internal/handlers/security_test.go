package handlers

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type securityNopSender struct{}

func (securityNopSender) SendBinary([]byte) error { return nil }
func (securityNopSender) BufferedAmount() int     { return 0 }

func TestRequiredPathParamRejectsNulBytes(t *testing.T) {
	params := map[string]any{
		"path":    "/safe/path\x00/../etc/passwd",
		"clean":   "/normal/path",
		"withNul": "C:\\Users\x00\\evil",
		"midNul":  "/tmp/foo\x00bar",
	}

	// NUL-containing paths must be rejected
	if _, err := requiredPathParam(params, "path"); err == nil {
		t.Fatal("path with NUL byte should be rejected")
	} else if !strings.Contains(err.Error(), "NUL") {
		t.Fatalf("error should mention NUL: %v", err)
	}
	if _, err := requiredPathParam(params, "withNul"); err == nil {
		t.Fatal("path with NUL byte should be rejected")
	}
	if _, err := requiredPathParam(params, "midNul"); err == nil {
		t.Fatal("path with embedded NUL byte should be rejected")
	}

	// Clean path must be accepted
	if got, err := requiredPathParam(params, "clean"); err != nil || got != "/normal/path" {
		t.Fatalf("clean path rejected: got=%q err=%v", got, err)
	}
}

func TestPathGuardBoundariesRelativeAndMultipleRoots(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	root2 := filepath.Join(base, "root2")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root2, 0o755); err != nil {
		t.Fatal(err)
	}
	rootFile := filepath.Join(root, "file.txt")
	root2File := filepath.Join(root2, "file.txt")
	if err := os.WriteFile(rootFile, []byte("root"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(root2File, []byte("root2"), 0o644); err != nil {
		t.Fatal(err)
	}

	guard := NewPathGuard([]string{root})
	if got, err := guard.CheckExisting(rootFile); err != nil || !samePath(got, rootFile) {
		t.Fatalf("root file rejected: got=%q err=%v", got, err)
	}
	if _, err := guard.CheckExisting(root2File); err == nil {
		t.Fatal("root2 prefix collision must be rejected")
	}
	traversal := filepath.Join(root, "..", filepath.Base(root2), "file.txt")
	if _, err := guard.CheckExisting(traversal); err == nil {
		t.Fatal(".. traversal must be rejected")
	}

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(cwd, rootFile)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := guard.CheckExisting(relative); err != nil || !samePath(got, rootFile) {
		t.Fatalf("relative path rejected: got=%q err=%v", got, err)
	}

	created := filepath.Join(root, "new", "file.txt")
	if got, err := guard.CheckCreate(created); err != nil || !samePath(got, created) {
		t.Fatalf("create path rejected: got=%q err=%v", got, err)
	}

	multi := NewPathGuard([]string{root, root2})
	if _, err := multi.CheckExisting(rootFile); err != nil {
		t.Fatalf("first root rejected: %v", err)
	}
	if _, err := multi.CheckExisting(root2File); err != nil {
		t.Fatalf("second root rejected: %v", err)
	}
}

func TestPathGuardInvalidConfiguredRootFailsClosed(t *testing.T) {
	base := t.TempDir()
	file := filepath.Join(base, "file.txt")
	if err := os.WriteFile(file, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	guard := NewPathGuard([]string{filepath.Join(base, "missing-root")})
	if guard.Unrestricted() {
		t.Fatal("an invalid configured root must not disable path restrictions")
	}
	if _, err := guard.CheckExisting(file); err == nil {
		t.Fatal("guard with no valid configured roots must fail closed")
	}
}

func TestPathGuardCanonicalizesSymlinkRoot(t *testing.T) {
	base := t.TempDir()
	realRoot := filepath.Join(base, "real")
	linkedRoot := filepath.Join(base, "linked")
	if err := os.MkdirAll(realRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, realRoot, linkedRoot)
	file := filepath.Join(realRoot, "file.txt")
	if err := os.WriteFile(file, []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}

	guard := NewPathGuard([]string{linkedRoot})
	if len(guard.roots) != 1 || !samePath(guard.roots[0], realRoot) {
		t.Fatalf("root was not canonicalized: %#v", guard.roots)
	}
	if got, err := guard.CheckExisting(filepath.Join(linkedRoot, "file.txt")); err != nil || !samePath(got, file) {
		t.Fatalf("existing path through root symlink rejected: got=%q err=%v", got, err)
	}
	wantCreate := filepath.Join(realRoot, "new.txt")
	if got, err := guard.CheckCreate(filepath.Join(linkedRoot, "new.txt")); err != nil || !samePath(got, wantCreate) {
		t.Fatalf("create path through root symlink rejected: got=%q err=%v", got, err)
	}
}

func TestFsStatReturnsCanonicalResolvedPath(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	realDir := filepath.Join(root, "real")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(realDir, "plan.md")
	if err := os.WriteFile(target, []byte("# plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked-plan.md")
	requireSymlink(t, target, link)

	h := New(NewPathGuard([]string{root}), 1024*1024)
	result, err := h.FsStat(map[string]any{"path": link})
	if err != nil {
		t.Fatalf("FsStat failed: %v", err)
	}
	payload, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected FsStat payload: %#v", result)
	}
	resolved, ok := payload["resolvedPath"].(string)
	if !ok || !samePath(resolved, target) {
		t.Fatalf("FsStat resolvedPath=%q, want %q", resolved, target)
	}
	if payload["isFile"] != true || payload["isDirectory"] != false {
		t.Fatalf("unexpected FsStat type fields: %#v", payload)
	}
}

func TestFsStatReturnsCanonicalCreatePathWhenMissing(t *testing.T) {
	base := t.TempDir()
	realRoot := filepath.Join(base, "real")
	linkedRoot := filepath.Join(base, "linked")
	if err := os.MkdirAll(realRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, realRoot, linkedRoot)

	h := New(NewPathGuard([]string{realRoot}), 1024*1024)
	requested := filepath.Join(linkedRoot, "new", "plan.md")
	result, err := h.FsStat(map[string]any{"path": requested})
	if err != nil {
		t.Fatalf("FsStat missing path failed: %v", err)
	}
	payload := result.(map[string]any)
	if payload["exists"] != false {
		t.Fatalf("missing FsStat unexpectedly exists: %#v", payload)
	}
	want := filepath.Join(realRoot, "new", "plan.md")
	if resolved, _ := payload["resolvedPath"].(string); !samePath(resolved, want) {
		t.Fatalf("missing FsStat resolvedPath=%q, want %q", resolved, want)
	}
}

func TestFsReadAtomicallyVerifiesExpectedResolvedPath(t *testing.T) {
	t.Run("stable identity reads the authorized file", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "plan.md")
		if err := os.WriteFile(target, []byte("# stable plan"), 0o644); err != nil {
			t.Fatal(err)
		}
		h := New(NewPathGuard([]string{root}), 1024*1024)
		result, err := h.FsRead(map[string]any{
			"path":                 target,
			"expectedResolvedPath": target,
		})
		if err != nil {
			t.Fatalf("FsRead failed: %v", err)
		}
		payload := result.(map[string]any)
		data, err := base64.StdEncoding.DecodeString(payload["dataB64"].(string))
		if err != nil || string(data) != "# stable plan" {
			t.Fatalf("unexpected atomic read: data=%q err=%v", data, err)
		}
		if resolved, _ := payload["resolvedPath"].(string); !samePath(resolved, target) {
			t.Fatalf("resolvedPath=%q, want %q", resolved, target)
		}
	})

	t.Run("rejects final symlink replacement between stat and read", func(t *testing.T) {
		root := t.TempDir()
		first := filepath.Join(root, "first.md")
		second := filepath.Join(root, "second.md")
		if err := os.WriteFile(first, []byte("first"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(second, []byte("second"), 0o644); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(root, "plan.md")
		requireSymlink(t, first, link)
		h := New(NewPathGuard([]string{root}), 1024*1024)
		statResult, err := h.FsStat(map[string]any{"path": link})
		if err != nil {
			t.Fatal(err)
		}
		expected := statResult.(map[string]any)["resolvedPath"].(string)
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		requireSymlink(t, second, link)

		if _, err := h.FsRead(map[string]any{
			"path":                 link,
			"expectedResolvedPath": expected,
		}); err == nil {
			t.Fatal("atomic FsRead must reject a replaced final symlink")
		}
	})

	t.Run("rejects parent symlink replacement between stat and read", func(t *testing.T) {
		root := t.TempDir()
		firstDir := filepath.Join(root, "first")
		secondDir := filepath.Join(root, "second")
		if err := os.MkdirAll(firstDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(secondDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(firstDir, "plan.md"), []byte("first"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(secondDir, "plan.md"), []byte("second"), 0o644); err != nil {
			t.Fatal(err)
		}
		linkedDir := filepath.Join(root, "current")
		requireSymlink(t, firstDir, linkedDir)
		requested := filepath.Join(linkedDir, "plan.md")
		h := New(NewPathGuard([]string{root}), 1024*1024)
		statResult, err := h.FsStat(map[string]any{"path": requested})
		if err != nil {
			t.Fatal(err)
		}
		expected := statResult.(map[string]any)["resolvedPath"].(string)
		if err := os.Remove(linkedDir); err != nil {
			t.Fatal(err)
		}
		requireSymlink(t, secondDir, linkedDir)

		if _, err := h.FsRead(map[string]any{
			"path":                 requested,
			"expectedResolvedPath": expected,
		}); err == nil {
			t.Fatal("atomic FsRead must reject a replaced parent symlink")
		}
	})
}

func TestFsWriteVerifiesExpectedResolvedPath(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first.txt")
	second := filepath.Join(root, "second.txt")
	if err := os.WriteFile(first, []byte("first"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("second"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "target.txt")
	requireSymlink(t, first, link)
	h := New(NewPathGuard([]string{root}), 1024*1024)
	statResult, err := h.FsStat(map[string]any{"path": link})
	if err != nil {
		t.Fatal(err)
	}
	expected := statResult.(map[string]any)["resolvedPath"].(string)
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, second, link)
	payload := base64.StdEncoding.EncodeToString([]byte("updated"))
	if _, err := h.FsWrite(map[string]any{
		"path":                 link,
		"dataB64":              payload,
		"expectedResolvedPath": expected,
	}); err == nil {
		t.Fatal("atomic FsWrite must reject a replaced symlink")
	}
	data, err := os.ReadFile(second)
	if err != nil || string(data) != "second" {
		t.Fatalf("replacement target was modified: data=%q err=%v", data, err)
	}

	missing := filepath.Join(root, "new", "created.txt")
	missingStat, err := h.FsStat(map[string]any{"path": missing})
	if err != nil {
		t.Fatal(err)
	}
	createExpected := missingStat.(map[string]any)["resolvedPath"].(string)
	if _, err := h.FsWrite(map[string]any{
		"path":                 missing,
		"dataB64":              payload,
		"expectedResolvedPath": createExpected,
	}); err != nil {
		t.Fatalf("atomic create write failed: %v", err)
	}
	created, err := os.ReadFile(createExpected)
	if err != nil || string(created) != "updated" {
		t.Fatalf("created file mismatch: data=%q err=%v", created, err)
	}
}

func TestPathGuardRejectsEscapingSymlinksAndAllowsInternalSymlinks(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	inside := filepath.Join(root, "inside")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, outside, filepath.Join(root, "outside-link"))
	requireSymlink(t, inside, filepath.Join(root, "inside-link"))

	guard := NewPathGuard([]string{root})
	if _, err := guard.CheckExisting(filepath.Join(root, "outside-link", "secret.txt")); err == nil {
		t.Fatal("existing path through escaping symlink must be rejected")
	}
	if _, err := guard.CheckCreate(filepath.Join(root, "outside-link", "new.txt")); err == nil {
		t.Fatal("create path through escaping parent symlink must be rejected")
	}

	insideFile := filepath.Join(inside, "existing.txt")
	if err := os.WriteFile(insideFile, []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := guard.CheckExisting(filepath.Join(root, "inside-link", "existing.txt")); err != nil || !samePath(got, insideFile) {
		t.Fatalf("internal symlink rejected: got=%q err=%v", got, err)
	}

	h := New(guard, 1024*1024)
	outsideSecret := filepath.Join(root, "outside-link", "secret.txt")
	if _, err := h.FsRead(map[string]any{"path": outsideSecret}); err == nil {
		t.Fatal("FsRead through escaping symlink must be rejected")
	}
	payload := base64.StdEncoding.EncodeToString([]byte("created"))
	outsideTarget := filepath.Join(root, "outside-link", "created.txt")
	if _, err := h.FsWrite(map[string]any{"path": outsideTarget, "dataB64": payload}); err == nil {
		t.Fatal("FsWrite through escaping parent symlink must be rejected")
	}
	if _, err := h.FsMkdirp(map[string]any{"path": filepath.Join(root, "outside-link", "dir")}); err == nil {
		t.Fatal("FsMkdirp through escaping parent symlink must be rejected")
	}
	if _, err := os.Stat(filepath.Join(outside, "created.txt")); !os.IsNotExist(err) {
		t.Fatalf("outside file was unexpectedly created: %v", err)
	}

	insideTarget := filepath.Join(root, "inside-link", "created.txt")
	if _, err := h.FsWrite(map[string]any{"path": insideTarget, "dataB64": payload}); err != nil {
		t.Fatalf("FsWrite through internal symlink failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(inside, "created.txt"))
	if err != nil || string(data) != "created" {
		t.Fatalf("internal symlink write mismatch: data=%q err=%v", data, err)
	}

	if _, err := h.ExecStart(context.Background(), map[string]any{
		"command": "true",
		"cwd":     filepath.Join(root, "outside-link"),
	}, func(string, []byte) {}); err == nil {
		t.Fatal("exec cwd through escaping symlink must be rejected")
	}
	if _, err := h.GitStatus(map[string]any{"cwd": filepath.Join(root, "outside-link")}); err == nil {
		t.Fatal("git cwd through escaping symlink must be rejected")
	}
	if runtime.GOOS != "windows" {
		if _, err := h.PtyOpen(context.Background(), map[string]any{
			"ptyId": "escape",
			"cwd":   filepath.Join(root, "outside-link"),
		}, func(string, []byte) {}); err == nil {
			t.Fatal("PTY cwd through escaping symlink must be rejected")
		}
	}
	if _, err := h.decodeGrepParams(map[string]any{
		"pattern":    "secret",
		"searchPath": filepath.Join(root, "outside-link", "secret.txt"),
		"cwd":        root,
	}); err == nil {
		t.Fatal("grep searchPath through escaping symlink must be rejected")
	}
}

func TestRecursiveHandlersDoNotFollowDirectorySymlinks(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, outside, filepath.Join(root, "outside-link"))

	h := New(NewPathGuard([]string{root}), 1024*1024)
	globResult, err := h.Glob(map[string]any{
		"pattern":    "**/*",
		"cwd":        root,
		"dot":        true,
		"maxResults": float64(100),
	})
	if err != nil {
		t.Fatalf("glob failed: %v", err)
	}
	for _, match := range globResult.(map[string]any)["matches"].([]string) {
		if strings.Contains(filepath.ToSlash(match), "outside-link/secret.txt") {
			t.Fatalf("glob followed escaping symlink: %q", match)
		}
	}

	statResult, err := h.TransferStat(map[string]any{
		"path":       root,
		"recursive":  true,
		"maxEntries": float64(100),
	})
	if err != nil {
		t.Fatalf("transfer stat failed: %v", err)
	}
	for _, entry := range statResult.(map[string]any)["entries"].([]map[string]any) {
		if strings.Contains(entry["relPath"].(string), "outside-link/secret.txt") {
			t.Fatalf("transfer stat followed escaping symlink: %#v", entry)
		}
	}
}

func TestTransferPathsUseExistingAndCreateChecks(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	inside := filepath.Join(root, "inside")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(outside, "secret.bin")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, outside, filepath.Join(root, "outside-link"))
	requireSymlink(t, inside, filepath.Join(root, "inside-link"))

	h := New(NewPathGuard([]string{root}), 1024*1024)
	transfers := NewTransfers(h, securityNopSender{})
	if _, err := transfers.Begin(context.Background(), map[string]any{
		"transferId": "download-outside",
		"direction":  "download",
		"remotePath": filepath.Join(root, "outside-link", "secret.bin"),
	}); err == nil {
		t.Fatal("download through escaping symlink must be rejected")
	}
	if _, err := transfers.Begin(context.Background(), map[string]any{
		"transferId": "upload-outside",
		"direction":  "upload",
		"remotePath": filepath.Join(root, "outside-link", "upload.bin"),
		"fileSize":   float64(1),
		"chunkSize":  float64(1),
	}); err == nil {
		t.Fatal("upload through escaping parent symlink must be rejected")
	}

	destination := filepath.Join(root, "inside-link", "upload.bin")
	if _, err := transfers.Begin(context.Background(), map[string]any{
		"transferId":  "upload-inside",
		"direction":   "upload",
		"remotePath":  destination,
		"fileSize":    float64(1),
		"chunkSize":   float64(1),
		"totalChunks": float64(1),
	}); err != nil {
		t.Fatalf("upload through internal symlink failed: %v", err)
	}
	transfers.WriteChunk("upload-inside", 0, []byte("x"))
	result, err := transfers.Complete(map[string]any{"transferId": "upload-inside"})
	if err != nil || !result.(map[string]any)["ok"].(bool) {
		t.Fatalf("internal upload completion failed: result=%#v err=%v", result, err)
	}
	data, err := os.ReadFile(filepath.Join(inside, "upload.bin"))
	if err != nil || string(data) != "x" {
		t.Fatalf("internal upload mismatch: data=%q err=%v", data, err)
	}

	sidecarDestination := filepath.Join(root, "sidecar.bin")
	requireSymlink(t, filepath.Join(outside, "part.bin"), sidecarDestination+".nfpart")
	if _, err := transfers.Begin(context.Background(), map[string]any{
		"transferId": "sidecar-escape",
		"direction":  "upload",
		"remotePath": sidecarDestination,
		"fileSize":   float64(1),
		"chunkSize":  float64(1),
	}); err == nil {
		t.Fatal("upload with escaping .nfpart symlink must be rejected")
	}
}

func TestFsRemoveIsIdempotentGuardedAndFileOnly(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "remove.txt")
	if err := os.WriteFile(file, []byte("remove"), 0o644); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(outsideFile, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := New(NewPathGuard([]string{root}), 1024*1024)
	if _, err := h.FsRemove(map[string]any{"path": file}); err != nil {
		t.Fatalf("remove file failed: %v", err)
	}
	if _, err := os.Lstat(file); !os.IsNotExist(err) {
		t.Fatalf("file still exists after remove: %v", err)
	}
	if _, err := h.FsRemove(map[string]any{"path": file}); err != nil {
		t.Fatalf("missing file should be a no-op: %v", err)
	}
	dir := filepath.Join(root, "directory")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := h.FsRemove(map[string]any{"path": dir}); err == nil || !strings.Contains(err.Error(), "directory") {
		t.Fatalf("directory removal should be rejected, got: %v", err)
	}
	target := filepath.Join(root, "target.txt")
	link := filepath.Join(root, "link.txt")
	if err := os.WriteFile(target, []byte("target"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err == nil {
		if _, err := h.FsRemove(map[string]any{"path": link}); err != nil {
			t.Fatalf("remove symlink failed: %v", err)
		}
		if data, err := os.ReadFile(target); err != nil || string(data) != "target" {
			t.Fatalf("symlink target changed: data=%q err=%v", data, err)
		}
	}
	if _, err := h.FsRemove(map[string]any{"path": outsideFile}); err == nil {
		t.Fatal("path outside allow-root should be rejected")
	}
	if data, err := os.ReadFile(outsideFile); err != nil || string(data) != "keep" {
		t.Fatalf("outside file changed: data=%q err=%v", data, err)
	}
}

func TestPathGuardRejectsEscapingWindowsJunctions(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows junction test")
	}
	base := t.TempDir()
	root := filepath.Join(base, "root")
	inside := filepath.Join(root, "inside")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inside, "safe.txt"), []byte("safe"), 0o644); err != nil {
		t.Fatal(err)
	}

	requireWindowsJunction(t, outside, filepath.Join(root, "outside-junction"))
	requireWindowsJunction(t, inside, filepath.Join(root, "inside-junction"))

	guard := NewPathGuard([]string{root})
	outsideSecret := filepath.Join(root, "outside-junction", "secret.txt")
	if _, err := guard.CheckExisting(outsideSecret); err == nil {
		t.Fatal("existing path through escaping junction must be rejected")
	}
	outsideCreate := filepath.Join(root, "outside-junction", "created.txt")
	if _, err := guard.CheckCreate(outsideCreate); err == nil {
		t.Fatal("create path through escaping junction must be rejected")
	}

	insideFile := filepath.Join(inside, "safe.txt")
	if got, err := guard.CheckExisting(filepath.Join(root, "inside-junction", "safe.txt")); err != nil || !samePath(got, insideFile) {
		t.Fatalf("internal junction rejected: got=%q err=%v", got, err)
	}

	h := New(guard, 1024*1024)
	if _, err := h.FsRead(map[string]any{"path": outsideSecret}); err == nil {
		t.Fatal("FsRead through escaping junction must be rejected")
	}
	payload := base64.StdEncoding.EncodeToString([]byte("created"))
	if _, err := h.FsWrite(map[string]any{"path": outsideCreate, "dataB64": payload}); err == nil {
		t.Fatal("FsWrite through escaping junction must be rejected")
	}
}

func requireWindowsJunction(t *testing.T, target, link string) {
	t.Helper()
	command := fmt.Sprintf(`mklink /J "%s" "%s"`, link, target)
	if output, err := exec.Command("cmd.exe", "/d", "/s", "/c", command).CombinedOutput(); err != nil {
		t.Fatalf("create junction %q -> %q: %v (%s)", link, target, err, output)
	}
}

func requireSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlink unavailable on Windows: %v", err)
		}
		t.Fatalf("create symlink %q -> %q: %v", link, target, err)
	}
}
