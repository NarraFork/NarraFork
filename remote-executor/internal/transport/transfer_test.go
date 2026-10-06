//go:build !windows

package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/wire"
)

// TestTransferDownload drives a download (executor → server): the server sends
// transfer.begin{download}, the executor streams chunk frames, and the server
// reassembles the file.
func TestTransferDownload(t *testing.T) {
	root := t.TempDir()
	// Create a source file spanning multiple chunks (server chunkSize below).
	const chunkSize = 64 * 1024
	src := filepath.Join(root, "download-src.bin")
	content := make([]byte, chunkSize*3+123) // 3 full chunks + a partial
	for i := range content {
		content[i] = byte(i * 7)
	}
	if err := os.WriteFile(src, content, 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	srv, pts := newPtyTestServer(t) // reuse the single-reader harness
	defer srv.Close()
	cancel := startExecutor(t, srv.URL, root)
	defer cancel()

	select {
	case <-pts.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("handshake timeout")
	}
	ctx := context.Background()

	totalChunks := (len(content) + chunkSize - 1) / chunkSize
	pts.writeFrame(ctx, rpc.RequestFrame{
		Type:   "rpc",
		ID:     "b1",
		Method: "transfer.begin",
		Params: map[string]any{
			"transferId":  "tx1",
			"direction":   "download",
			"remotePath":  src,
			"fileSize":    float64(len(content)),
			"chunkSize":   float64(chunkSize),
			"totalChunks": float64(totalChunks),
			"mtimeMs":     float64(0),
			"verify":      "crc32c",
		},
	})

	// Collect chunk frames until we have the whole file.
	got := make([]byte, len(content))
	filled := make([]bool, totalChunks)
	remaining := totalChunks
	deadline := time.After(15 * time.Second)
	for remaining > 0 {
		select {
		case bin := <-pts.binaries:
			header, payload, ok := wire.DecodeChunkFrame(bin)
			if !ok || header.TransferID != "tx1" {
				continue
			}
			copy(got[header.ChunkIndex*chunkSize:], payload)
			if !filled[header.ChunkIndex] {
				filled[header.ChunkIndex] = true
				remaining--
			}
		case <-deadline:
			t.Fatalf("timed out waiting for chunks, %d remaining", remaining)
		}
	}
	if !bytes.Equal(got, content) {
		t.Fatal("downloaded content mismatch")
	}
}

// TestTransferUpload drives an upload (server → executor): the server sends
// transfer.begin{upload}, pushes chunk frames, then transfer.complete; the
// executor writes the file and finalizes.
func TestTransferUpload(t *testing.T) {
	root := t.TempDir()
	const chunkSize = 32 * 1024
	content := make([]byte, chunkSize*2+50)
	for i := range content {
		content[i] = byte(i*3 + 1)
	}
	dest := filepath.Join(root, "sub", "uploaded.bin")

	srv, pts := newPtyTestServer(t)
	defer srv.Close()
	cancel := startExecutor(t, srv.URL, root)
	defer cancel()

	select {
	case <-pts.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("handshake timeout")
	}
	ctx := context.Background()

	totalChunks := (len(content) + chunkSize - 1) / chunkSize
	pts.writeFrame(ctx, rpc.RequestFrame{
		Type:   "rpc",
		ID:     "u1",
		Method: "transfer.begin",
		Params: map[string]any{
			"transferId":  "tx2",
			"direction":   "upload",
			"remotePath":  dest,
			"fileSize":    float64(len(content)),
			"chunkSize":   float64(chunkSize),
			"totalChunks": float64(totalChunks),
			"mtimeMs":     float64(0),
			"verify":      "crc32c",
		},
	})
	if !pts.awaitResult("u1", 5*time.Second) {
		t.Fatal("transfer.begin (upload) did not ack")
	}

	// Push chunk frames.
	for i := 0; i < totalChunks; i++ {
		offset := i * chunkSize
		end := offset + chunkSize
		if end > len(content) {
			end = len(content)
		}
		frame, _ := wire.EncodeChunkFrame(
			wire.ChunkFrameHeader{TransferID: "tx2", ChunkIndex: i},
			content[offset:end],
		)
		pts.writeBinary(ctx, frame)
	}

	// Complete.
	pts.writeFrame(ctx, rpc.RequestFrame{
		Type:   "rpc",
		ID:     "c1",
		Method: "transfer.complete",
		Params: map[string]any{"transferId": "tx2"},
	})
	if !pts.awaitResult("c1", 10*time.Second) {
		t.Fatal("transfer.complete did not succeed")
	}

	// Verify the file landed correctly.
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("uploaded content mismatch: got %d bytes want %d", len(got), len(content))
	}
}

// writeBinary sends a raw binary frame (test helper on the pty harness server).
func (p *ptyTestServer) writeBinary(ctx context.Context, frame []byte) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if p.conn == nil {
		return
	}
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = p.conn.Write(writeCtx, websocket.MessageBinary, frame)
}

var _ = json.Marshal
