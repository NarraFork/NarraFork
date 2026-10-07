package handlers

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func shareFixture(t *testing.T) (*Handlers, string, string) {
	t.Helper()
	base := t.TempDir()
	base, err := filepath.EvalSymlinks(base)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "workspace")
	private := filepath.Join(base, "private")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 2*1024*1024)
	if err := h.ConfigureShareStateDirectory(private); err != nil {
		t.Fatal(err)
	}
	return h, root, private
}
func shareInspect(t *testing.T, h *Handlers, id string, roots ...string) map[string]any {
	t.Helper()
	paths := make([]any, len(roots))
	for i := range roots {
		paths[i] = roots[i]
	}
	result, err := h.ShareInspect(context.Background(), map[string]any{"operationId": id, "paths": paths, "maxExpandedBytes": int64(1024 * 1024)})
	if err != nil {
		t.Fatal(err)
	}
	return result.(map[string]any)
}
func sharePrepare(t *testing.T, h *Handlers, id, format string, manifest map[string]any) map[string]any {
	t.Helper()
	result, err := h.SharePrepare(context.Background(), map[string]any{"operationId": id, "manifestHash": manifest["manifestHash"], "format": format, "maxArchiveBytes": int64(1024 * 1024)})
	if err != nil {
		t.Fatal(err)
	}
	return result.(map[string]any)
}
func shareReadAll(t *testing.T, h *Handlers, id string, artifact map[string]any) []byte {
	t.Helper()
	var out []byte
	var offset int64
	for {
		result, err := h.ShareReadChunk(context.Background(), map[string]any{"operationId": id, "artifactId": artifact["artifactId"], "offset": offset, "maxChunkBytes": int64(7)})
		if err != nil {
			t.Fatal(err)
		}
		chunk := result.(map[string]any)
		if chunk["offset"] != offset {
			t.Fatal("offset drift")
		}
		data, err := base64.StdEncoding.DecodeString(chunk["contentBase64"].(string))
		if err != nil {
			t.Fatal(err)
		}
		if len(data) > 7 {
			t.Fatal("chunk byte cap exceeded")
		}
		out = append(out, data...)
		offset += int64(len(data))
		if chunk["eof"] == true {
			break
		}
		if len(data) == 0 {
			t.Fatal("empty non-final chunk")
		}
	}
	hash := sha256.Sum256(out)
	if hex.EncodeToString(hash[:]) != artifact["archiveDigest"] {
		t.Fatal("archive digest mismatch")
	}
	if int64(len(out)) != artifact["archiveSizeBytes"] {
		t.Fatal("archive size mismatch")
	}
	return out
}
func TestShareArchiveBoundedFormats(t *testing.T) {
	for _, format := range []string{"raw", "gz", "tar.gz", "zip"} {
		t.Run(format, func(t *testing.T) {
			h, root, _ := shareFixture(t)
			source := filepath.Join(root, "notes.txt")
			if err := os.WriteFile(source, []byte("approved content\n"), 0600); err != nil {
				t.Fatal(err)
			}
			id := "share-format-" + format
			if format == "tar.gz" {
				id = "share-format-targz"
			}
			selected := source
			if format == "tar.gz" {
				selected = root
			}
			manifest := shareInspect(t, h, id, selected)
			artifact := sharePrepare(t, h, id, format, manifest)
			data := shareReadAll(t, h, id, artifact)
			switch format {
			case "raw":
				if string(data) != "approved content\n" {
					t.Fatal("raw bytes changed")
				}
			case "gz":
				reader, err := gzip.NewReader(bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				defer reader.Close()
				body, _ := io.ReadAll(reader)
				if string(body) != "approved content\n" {
					t.Fatal("gzip bytes changed")
				}
			case "tar.gz":
				reader, err := gzip.NewReader(bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				defer reader.Close()
				tarReader := tar.NewReader(reader)
				found := false
				for {
					header, err := tarReader.Next()
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Fatal(err)
					}
					if header.Name == "workspace/notes.txt" {
						body, _ := io.ReadAll(tarReader)
						found = string(body) == "approved content\n"
					}
				}
				if !found {
					t.Fatal("directory tar content missing")
				}
			case "zip":
				reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
				if err != nil {
					t.Fatal(err)
				}
				if len(reader.File) != 1 {
					t.Fatal("zip entry count")
				}
				file, err := reader.File[0].Open()
				if err != nil {
					t.Fatal(err)
				}
				body, _ := io.ReadAll(file)
				file.Close()
				if string(body) != "approved content\n" {
					t.Fatal("zip bytes changed")
				}
			}
			if _, err := h.ShareRelease(context.Background(), map[string]any{"operationId": id}); err != nil {
				t.Fatal(err)
			}
			if _, err := h.ShareReadChunk(context.Background(), map[string]any{"operationId": id, "artifactId": artifact["artifactId"], "offset": int64(0)}); err == nil {
				t.Fatal("released artifact remained accessible")
			}
		})
	}
}
func TestShareArchiveRejectsTraversalSymlinksAndChangedSources(t *testing.T) {
	h, root, _ := shareFixture(t)
	file := filepath.Join(root, "notes.txt")
	os.WriteFile(file, []byte("before"), 0600)
	if _, err := h.ShareInspect(context.Background(), map[string]any{"operationId": "../unsafe-operation", "paths": []any{root}}); err == nil {
		t.Fatal("operation traversal accepted")
	}
	if _, err := h.ShareInspect(context.Background(), map[string]any{"operationId": "share-outside", "paths": []any{filepath.Dir(root)}}); err == nil {
		t.Fatal("outside root accepted")
	}
	manifest := shareInspect(t, h, "share-change", file)
	os.WriteFile(file, []byte("changed and longer"), 0600)
	if _, err := h.SharePrepare(context.Background(), map[string]any{"operationId": "share-change", "manifestHash": manifest["manifestHash"], "format": "raw"}); err == nil {
		t.Fatal("changed source archived")
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(file, filepath.Join(root, "link")); err != nil {
			t.Fatal(err)
		}
		if _, err := h.ShareInspect(context.Background(), map[string]any{"operationId": "share-symlink", "paths": []any{root}}); err == nil {
			t.Fatal("nested symlink archived")
		}
	}
}
func TestShareArchiveEnumerationAndOutputCaps(t *testing.T) {
	h, root, private := shareFixture(t)
	file := filepath.Join(root, "notes.txt")
	os.WriteFile(file, bytes.Repeat([]byte("a"), 128), 0600)
	if _, err := h.ShareInspect(context.Background(), map[string]any{"operationId": "share-count-cap", "paths": []any{root}, "maxEntries": int64(1)}); err == nil {
		t.Fatal("entry limit bypassed")
	}
	if _, err := h.ShareInspect(context.Background(), map[string]any{"operationId": "share-source-cap", "paths": []any{file}, "maxExpandedBytes": int64(64)}); err == nil {
		t.Fatal("source byte limit bypassed")
	}
	manifest := shareInspect(t, h, "share-output-cap", file)
	if _, err := h.SharePrepare(context.Background(), map[string]any{"operationId": "share-output-cap", "manifestHash": manifest["manifestHash"], "format": "raw", "maxArchiveBytes": int64(1)}); err == nil {
		t.Fatal("archive byte limit bypassed")
	}
	entries, err := os.ReadDir(private)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("failed archive retained a private artifact")
	}
}
func TestShareArchiveRestartReleaseAndPrivatePathIsolation(t *testing.T) {
	h, root, private := shareFixture(t)
	file := filepath.Join(root, "notes.txt")
	os.WriteFile(file, []byte("content"), 0600)
	manifest := shareInspect(t, h, "share-restart", file)
	artifact := sharePrepare(t, h, "share-restart", "raw", manifest)
	operation := h.shareRegistry.operations["share-restart"]
	if _, err := h.FsStat(map[string]any{"path": operation.artifact}); err == nil {
		t.Fatal("private artifact became an ordinary filesystem endpoint")
	}
	fresh := New(NewPathGuard([]string{root}), 2*1024*1024)
	if err := fresh.ConfigureShareStateDirectory(private); err != nil {
		t.Fatal(err)
	}
	if _, err := fresh.ShareReadChunk(context.Background(), map[string]any{"operationId": "share-restart", "artifactId": artifact["artifactId"], "offset": int64(0)}); err == nil {
		t.Fatal("restart reopened an unapproved private artifact")
	}
	if _, err := fresh.ShareRelease(context.Background(), map[string]any{"operationId": "share-restart"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(private)
	if err != nil || len(entries) != 0 {
		t.Fatal("operation-owned orphan was not released", err)
	}
}

func TestShareArchiveBindingCancellationAndQuota(t *testing.T) {
	h, root, _ := shareFixture(t)
	file := filepath.Join(root, "notes.txt")
	os.WriteFile(file, []byte("content"), 0600)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.ShareInspect(ctx, map[string]any{"operationId": "share-cancel", "paths": []any{file}}); err == nil {
		t.Fatal("cancelled scan ran")
	}
	manifest := shareInspect(t, h, "share-binding", file)
	if _, err := h.SharePrepare(context.Background(), map[string]any{"operationId": "share-binding", "manifestHash": "wrong", "format": "raw"}); err == nil {
		t.Fatal("wrong manifest accepted")
	}
	artifact := sharePrepare(t, h, "share-binding", "raw", manifest)
	if _, err := h.ShareReadChunk(context.Background(), map[string]any{"operationId": "share-binding", "artifactId": "wrong", "offset": int64(0)}); err == nil {
		t.Fatal("wrong artifact accepted")
	}
	if _, err := h.ShareReadChunk(context.Background(), map[string]any{"operationId": "share-binding", "artifactId": artifact["artifactId"], "offset": int64(100)}); err == nil {
		t.Fatal("out of bounds read accepted")
	}
	for i := 0; i < shareMaxOperations-1; i++ {
		id := string(rune('a'+i)) + "-share-quota"
		shareInspect(t, h, id, file)
	}
	if _, err := h.ShareInspect(context.Background(), map[string]any{"operationId": "share-over-quota", "paths": []any{file}}); err == nil {
		t.Fatal("operation quota bypassed")
	}
	scoped := h.ConnectionScoped()
	if _, err := scoped.ShareReadChunk(context.Background(), map[string]any{"operationId": "share-binding", "artifactId": artifact["artifactId"], "offset": int64(0)}); err != nil {
		t.Fatal("connection scoped handler lost private registry", err)
	}
}
