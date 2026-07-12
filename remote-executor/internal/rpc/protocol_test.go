package rpc

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/narrafork/remote-executor/internal/handlers"
)

func TestDispatcherSystemPing(t *testing.T) {
	dispatcher := NewDispatcher(handlers.New(handlers.NewPathGuard(nil), 1024))
	result, err := dispatcher.Dispatch(context.Background(), "system.ping", nil, nil)
	if err != nil {
		t.Fatalf("system.ping failed: %v", err)
	}
	payload, ok := result.(map[string]any)
	if !ok || payload["ok"] != true {
		t.Fatalf("unexpected system.ping result: %#v", result)
	}
}

func TestDispatcherFsRemove(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "remove.txt")
	if err := os.WriteFile(file, []byte("remove"), 0o644); err != nil {
		t.Fatal(err)
	}
	dispatcher := NewDispatcher(handlers.New(handlers.NewPathGuard([]string{root}), 1024))
	if _, err := dispatcher.Dispatch(
		context.Background(),
		"fs.remove",
		map[string]any{"path": file},
		nil,
	); err != nil {
		t.Fatalf("fs.remove failed: %v", err)
	}
	if _, err := os.Lstat(file); !os.IsNotExist(err) {
		t.Fatalf("file still exists after fs.remove: %v", err)
	}
}

func TestChunkFrameRoundTrip(t *testing.T) {
	payload := []byte{1, 2, 3, 4, 5, 250, 251, 252}
	frame, err := EncodeChunkFrame(ChunkFrameHeader{TransferID: "tx_abc", ChunkIndex: 42}, payload)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if frame[0] != TransferFrameMagic || frame[1] != TransferFrameTypeChunk {
		t.Fatalf("bad frame prefix: %v", frame[:2])
	}
	h, got, ok := DecodeChunkFrame(frame)
	if !ok {
		t.Fatal("decode failed")
	}
	if h.TransferID != "tx_abc" || h.ChunkIndex != 42 {
		t.Fatalf("bad header: %+v", h)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch: %v", got)
	}
}

func TestChunkFrameEmptyPayload(t *testing.T) {
	frame, _ := EncodeChunkFrame(ChunkFrameHeader{TransferID: "t", ChunkIndex: 0}, nil)
	h, got, ok := DecodeChunkFrame(frame)
	if !ok || len(got) != 0 || h.ChunkIndex != 0 {
		t.Fatalf("empty payload decode failed: ok=%v len=%d", ok, len(got))
	}
}

func TestChunkFrameLargePayload(t *testing.T) {
	payload := make([]byte, 1024*1024)
	for i := range payload {
		payload[i] = byte(i)
	}
	frame, _ := EncodeChunkFrame(ChunkFrameHeader{TransferID: "big", ChunkIndex: 7}, payload)
	_, got, ok := DecodeChunkFrame(frame)
	if !ok || !bytes.Equal(got, payload) {
		t.Fatalf("large payload round-trip failed")
	}
}

func TestIsChunkFrameRejectsNonFrames(t *testing.T) {
	if IsChunkFrame(nil) {
		t.Fatal("nil should not be a chunk frame")
	}
	if IsChunkFrame([]byte(`{"type":"rpc"}`)) {
		t.Fatal("JSON text should not be a chunk frame")
	}
	if IsChunkFrame([]byte{0x00, 0x01, 0, 0}) {
		t.Fatal("wrong magic should not be a chunk frame")
	}
}

func TestDecodeChunkFrameTruncatedHeader(t *testing.T) {
	// headerLen claims 100 but no header bytes follow.
	bad := []byte{TransferFrameMagic, TransferFrameTypeChunk, 100, 0}
	if _, _, ok := DecodeChunkFrame(bad); ok {
		t.Fatal("expected decode failure on truncated header")
	}
}

// TestChunkFrameCrossImplHeaderLen verifies the uint16 LE header length matches
// the TS encoder's DataView.setUint16(.., true) layout for a >255 byte header.
func TestChunkFrameHeaderLenLE(t *testing.T) {
	longID := ""
	for len(longID) < 300 {
		longID += "abcd"
	}
	frame, err := EncodeChunkFrame(ChunkFrameHeader{TransferID: longID, ChunkIndex: 1}, []byte{9})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	h, got, ok := DecodeChunkFrame(frame)
	if !ok || h.TransferID != longID || len(got) != 1 || got[0] != 9 {
		t.Fatalf("long-header round-trip failed: ok=%v", ok)
	}
}
