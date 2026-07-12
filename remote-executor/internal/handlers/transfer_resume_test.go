//go:build !windows

package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// nopSender discards frames (upload direction receives, never sends).
type nopSender struct{}

func (nopSender) SendBinary([]byte) error { return nil }
func (nopSender) BufferedAmount() int     { return 0 }

type slowCountingSender struct {
	count atomic.Int64
}

func (s *slowCountingSender) SendBinary([]byte) error {
	time.Sleep(time.Millisecond)
	s.count.Add(1)
	return nil
}

func (s *slowCountingSender) BufferedAmount() int { return 0 }

// TestUploadResume verifies the executor persists a resume manifest and, on a
// second begin with a matching fingerprint, reports already-received chunks so
// the sender can skip them. It then completes the transfer from where it left
// off and validates the final file.
func TestUploadResume(t *testing.T) {
	root := t.TempDir()
	dst := filepath.Join(root, "resume", "file.bin")

	const chunkSize = 1024
	content := make([]byte, chunkSize*40) // 40 chunks
	for i := range content {
		content[i] = byte(i % 251)
	}
	totalChunks := len(content) / chunkSize

	h := New(NewPathGuard([]string{root}), 10*1024*1024)
	transfers := NewTransfers(h, nopSender{})
	ctx := context.Background()

	contentDigest := fmt.Sprintf("%x", sha256.Sum256(content))
	beginParams := map[string]any{
		"transferId":  "resume1",
		"direction":   "upload",
		"remotePath":  dst,
		"fileSize":    float64(len(content)),
		"chunkSize":   float64(chunkSize),
		"totalChunks": float64(totalChunks),
		"mtimeMs":     float64(0),
		"verify":      "crc32c",
		"contentIdentity": map[string]any{
			"algorithm": "sha256",
			"digest":    contentDigest,
		},
	}

	// First session: write the first 33 chunks (manifest persists every 32).
	if _, err := transfers.Begin(ctx, beginParams); err != nil {
		t.Fatalf("begin 1: %v", err)
	}
	for i := 0; i < 33; i++ {
		off := i * chunkSize
		transfers.WriteChunk("resume1", i, content[off:off+chunkSize])
	}
	// Simulate an interruption: drop the session without completing. The manifest
	// + .part remain on disk.
	sess := transfers.get("resume1")
	if sess != nil && sess.recvFile != nil {
		_ = sess.recvFile.Sync()
		saveManifest(
			sess.manifestPath,
			sess.manifestTmpPath,
			sess.chunkSize,
			sess.fileSize,
			sess.contentIdentity,
			sess.received,
		)
		_ = sess.recvFile.Close()
	}
	transfers.mu.Lock()
	delete(transfers.sessions, "resume1")
	transfers.mu.Unlock()

	// Manifest must exist and report >= 32 completed chunks.
	if _, err := os.Stat(dst + ".nfmeta"); err != nil {
		t.Fatalf("manifest not persisted: %v", err)
	}

	// Second session with a NEW transfer id but the same destination/fingerprint.
	beginParams["transferId"] = "resume2"
	res, err := transfers.Begin(ctx, beginParams)
	if err != nil {
		t.Fatalf("begin 2: %v", err)
	}
	completed := res.(map[string]any)["completedChunks"].([]int)
	if len(completed) < 32 {
		t.Fatalf("expected >=32 resumed chunks, got %d", len(completed))
	}

	// Send the remaining chunks (skip already-completed ones).
	done := map[int]bool{}
	for _, i := range completed {
		done[i] = true
	}
	for i := 0; i < totalChunks; i++ {
		if done[i] {
			continue
		}
		off := i * chunkSize
		transfers.WriteChunk("resume2", i, content[off:off+chunkSize])
	}

	completeRes, err := transfers.Complete(map[string]any{"transferId": "resume2"})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if ok := completeRes.(map[string]any)["ok"].(bool); !ok {
		t.Fatalf("complete not ok: %+v", completeRes)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatal("resumed file content mismatch")
	}
	// Manifest cleaned up after completion.
	if _, err := os.Stat(dst + ".nfmeta"); !os.IsNotExist(err) {
		t.Fatal("manifest should be removed after completion")
	}
}

func TestUploadResumeRejectsMismatchedContentIdentity(t *testing.T) {
	root := t.TempDir()
	dst := filepath.Join(root, "identity-mismatch.bin")
	const chunkSize = 4
	contentA := []byte("AAAABBBB")
	contentB := []byte("CCCCDDDD")
	digestA := fmt.Sprintf("%x", sha256.Sum256(contentA))
	digestB := fmt.Sprintf("%x", sha256.Sum256(contentB))
	transfers := NewTransfers(New(NewPathGuard([]string{root}), 10*1024*1024), nopSender{})

	begin := func(transferID, digest string) map[string]any {
		return map[string]any{
			"transferId":  transferID,
			"direction":   "upload",
			"remotePath":  dst,
			"fileSize":    float64(len(contentA)),
			"chunkSize":   float64(chunkSize),
			"totalChunks": float64(2),
			"verify":      "none",
			"contentIdentity": map[string]any{
				"algorithm": "sha256",
				"digest":    digest,
			},
		}
	}

	if _, err := transfers.Begin(context.Background(), begin("identity-a", digestA)); err != nil {
		t.Fatalf("begin first upload: %v", err)
	}
	transfers.WriteChunk("identity-a", 0, contentA[:chunkSize])
	_, _ = transfers.Abort(map[string]any{
		"transferId": "identity-a", "preservePartial": true,
	})

	res, err := transfers.Begin(context.Background(), begin("identity-b", digestB))
	if err != nil {
		t.Fatalf("begin replacement upload: %v", err)
	}
	result := res.(map[string]any)
	if completed := result["completedChunks"].([]int); len(completed) != 0 {
		t.Fatalf("mismatched content resumed stale chunks: %v", completed)
	}
	if restarted, _ := result["restarted"].(bool); !restarted {
		t.Fatal("mismatched content identity should restart the upload")
	}
	transfers.WriteChunk("identity-b", 0, contentB[:chunkSize])
	transfers.WriteChunk("identity-b", 1, contentB[chunkSize:])
	complete, err := transfers.Complete(map[string]any{
		"transferId": "identity-b",
		"sha256":     digestB,
	})
	if err != nil || !complete.(map[string]any)["ok"].(bool) {
		t.Fatalf("complete replacement upload: result=%v error=%v", complete, err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read replacement upload: %v", err)
	}
	if !bytes.Equal(got, contentB) {
		t.Fatalf("replacement content mismatch: got %q want %q", got, contentB)
	}
}

func TestUploadResumeRejectsLegacyManifestWithoutIdentity(t *testing.T) {
	root := t.TempDir()
	dst := filepath.Join(root, "legacy-manifest.bin")
	if err := os.WriteFile(dst+".nfpart", []byte("stale!!!"), 0o644); err != nil {
		t.Fatalf("write stale part: %v", err)
	}
	legacyManifest := []byte(`{"chunkSize":4,"fileSize":8,"completedChunks":[0]}`)
	if err := os.WriteFile(dst+".nfmeta", legacyManifest, 0o644); err != nil {
		t.Fatalf("write legacy manifest: %v", err)
	}
	content := []byte("fresh!!!")
	digest := fmt.Sprintf("%x", sha256.Sum256(content))
	transfers := NewTransfers(New(NewPathGuard([]string{root}), 10*1024*1024), nopSender{})
	res, err := transfers.Begin(context.Background(), map[string]any{
		"transferId":  "legacy-restart",
		"direction":   "upload",
		"remotePath":  dst,
		"fileSize":    float64(len(content)),
		"chunkSize":   float64(4),
		"totalChunks": float64(2),
		"verify":      "none",
		"contentIdentity": map[string]any{
			"algorithm": "sha256",
			"digest":    digest,
		},
	})
	if err != nil {
		t.Fatalf("begin with legacy manifest: %v", err)
	}
	result := res.(map[string]any)
	if completed := result["completedChunks"].([]int); len(completed) != 0 {
		t.Fatalf("legacy manifest resumed stale chunks: %v", completed)
	}
	if restarted, _ := result["restarted"].(bool); !restarted {
		t.Fatal("legacy manifest should force a fresh upload")
	}
	info, err := os.Stat(dst + ".nfpart")
	if err != nil {
		t.Fatalf("stat restarted part: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("stale part was not truncated: %d bytes", info.Size())
	}
	_, _ = transfers.Abort(map[string]any{
		"transferId": "legacy-restart", "preservePartial": false,
	})
}

func TestTransferBeginRejectsRegistrationAfterClose(t *testing.T) {
	root := t.TempDir()
	transfers := NewTransfers(New(NewPathGuard([]string{root}), 10*1024*1024), nopSender{})
	transfers.Close()
	_, err := transfers.Begin(context.Background(), map[string]any{
		"transferId":  "closed-manager",
		"direction":   "upload",
		"remotePath":  filepath.Join(root, "closed.bin"),
		"fileSize":    float64(0),
		"chunkSize":   float64(1024),
		"totalChunks": float64(0),
		"verify":      "none",
		"contentIdentity": map[string]any{
			"algorithm": "sha256",
			"digest":    fmt.Sprintf("%x", sha256.Sum256(nil)),
		},
	})
	if err == nil {
		t.Fatal("begin should fail after transfer manager close")
	}
	if transfers.get("closed-manager") != nil {
		t.Fatal("closed manager retained a newly registered session")
	}
}

// TestOutOfOrderChunks verifies WriteChunk correctly places chunks written in
// reverse order (parallel senders deliver out of order).
func TestTransferClosePreservesUploadCheckpoint(t *testing.T) {
	root := t.TempDir()
	dst := filepath.Join(root, "disconnect-resume.bin")
	const chunkSize = 1024

	h := New(NewPathGuard([]string{root}), 10*1024*1024)
	transfers := NewTransfers(h, nopSender{})
	content := make([]byte, chunkSize*4)
	contentDigest := fmt.Sprintf("%x", sha256.Sum256(content))
	params := map[string]any{
		"transferId":  "before-disconnect",
		"direction":   "upload",
		"remotePath":  dst,
		"fileSize":    float64(len(content)),
		"chunkSize":   float64(chunkSize),
		"totalChunks": float64(4),
		"verify":      "none",
		"contentIdentity": map[string]any{
			"algorithm": "sha256",
			"digest":    contentDigest,
		},
	}
	if _, err := transfers.Begin(context.Background(), params); err != nil {
		t.Fatalf("begin upload: %v", err)
	}
	transfers.WriteChunk("before-disconnect", 0, content[:chunkSize])
	transfers.Close()

	if _, err := os.Stat(dst + ".nfpart"); err != nil {
		t.Fatalf("partial upload was not preserved: %v", err)
	}
	if _, err := os.Stat(dst + ".nfmeta"); err != nil {
		t.Fatalf("resume manifest was not preserved: %v", err)
	}

	params["transferId"] = "after-reconnect"
	resumedTransfers := NewTransfers(h, nopSender{})
	res, err := resumedTransfers.Begin(context.Background(), params)
	if err != nil {
		t.Fatalf("resume upload: %v", err)
	}
	completed := res.(map[string]any)["completedChunks"].([]int)
	if len(completed) != 1 || completed[0] != 0 {
		t.Fatalf("unexpected resumed chunks: %v", completed)
	}
	_, _ = resumedTransfers.Abort(map[string]any{
		"transferId": "after-reconnect", "preservePartial": false,
	})
}

func TestTransferCloseStopsDownloadSender(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "large-download.bin")
	const chunkSize = 1024
	if err := os.WriteFile(src, make([]byte, chunkSize*256), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	sender := &slowCountingSender{}
	transfers := NewTransfers(New(NewPathGuard([]string{root}), 10*1024*1024), sender)
	if _, err := transfers.Begin(context.Background(), map[string]any{
		"transferId":  "download-disconnect",
		"direction":   "download",
		"remotePath":  src,
		"fileSize":    float64(chunkSize * 256),
		"chunkSize":   float64(chunkSize),
		"totalChunks": float64(256),
		"verify":      "none",
	}); err != nil {
		t.Fatalf("begin download: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for sender.count.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if sender.count.Load() < 3 {
		t.Fatal("download sender did not start")
	}
	transfers.Close()
	countAfterClose := sender.count.Load()
	time.Sleep(30 * time.Millisecond)
	if got := sender.count.Load(); got > countAfterClose+1 {
		t.Fatalf("download sender continued after close: before=%d after=%d", countAfterClose, got)
	}
}

func TestOutOfOrderChunks(t *testing.T) {
	root := t.TempDir()
	dst := filepath.Join(root, "ooo.bin")
	const chunkSize = 512
	content := make([]byte, chunkSize*10)
	for i := range content {
		content[i] = byte(i)
	}
	totalChunks := len(content) / chunkSize

	h := New(NewPathGuard([]string{root}), 10*1024*1024)
	transfers := NewTransfers(h, nopSender{})
	if _, err := transfers.Begin(context.Background(), map[string]any{
		"transferId":  "ooo",
		"direction":   "upload",
		"remotePath":  dst,
		"fileSize":    float64(len(content)),
		"chunkSize":   float64(chunkSize),
		"totalChunks": float64(totalChunks),
		"verify":      "none",
	}); err != nil {
		t.Fatalf("begin: %v", err)
	}
	// Write in reverse order.
	for i := totalChunks - 1; i >= 0; i-- {
		off := i * chunkSize
		transfers.WriteChunk("ooo", i, content[off:off+chunkSize])
	}
	if _, err := transfers.Complete(map[string]any{"transferId": "ooo"}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, content) {
		t.Fatal("out-of-order reassembly mismatch")
	}
}
