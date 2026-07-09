//go:build !windows

package handlers

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

// nopSender discards frames (upload direction receives, never sends).
type nopSender struct{}

func (nopSender) SendBinary([]byte) error { return nil }
func (nopSender) BufferedAmount() int     { return 0 }

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

	beginParams := map[string]any{
		"transferId":  "resume1",
		"direction":   "upload",
		"remotePath":  dst,
		"fileSize":    float64(len(content)),
		"chunkSize":   float64(chunkSize),
		"totalChunks": float64(totalChunks),
		"mtimeMs":     float64(0),
		"verify":      "crc32c",
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
		saveManifest(sess.path, sess.chunkSize, sess.fileSize, sess.received)
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

// TestOutOfOrderChunks verifies WriteChunk correctly places chunks written in
// reverse order (parallel senders deliver out of order).
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
