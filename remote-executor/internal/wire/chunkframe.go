// Package wire holds the binary chunk-frame codec shared by the rpc and
// handlers packages. It is a dependency-free leaf so both can import it without
// creating an import cycle. Mirrors encodeChunkFrame/decodeChunkFrame in
// server/lib/agent/execution/rpc-types.ts.
package wire

import (
	"encoding/json"
	"errors"
)

const (
	FrameMagic     byte = 0x4e // 'N'
	FrameTypeChunk byte = 0x01
)

var ErrHeaderTooLarge = errors.New("chunk frame header too large")

// ChunkFrameHeader is the small JSON header carried in each binary chunk frame.
type ChunkFrameHeader struct {
	TransferID string `json:"transferId"`
	ChunkIndex int    `json:"chunkIndex"`
}

// EncodeChunkFrame builds a binary chunk frame from a header + raw payload.
// Layout: [magic][frameType][headerLen uint16 LE][header JSON][payload].
func EncodeChunkFrame(header ChunkFrameHeader, payload []byte) ([]byte, error) {
	headerBytes, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	if len(headerBytes) > 0xffff {
		return nil, ErrHeaderTooLarge
	}
	out := make([]byte, 4+len(headerBytes)+len(payload))
	out[0] = FrameMagic
	out[1] = FrameTypeChunk
	out[2] = byte(len(headerBytes))
	out[3] = byte(len(headerBytes) >> 8)
	copy(out[4:], headerBytes)
	copy(out[4+len(headerBytes):], payload)
	return out, nil
}

// IsChunkFrame reports whether a binary message is a transfer chunk frame.
func IsChunkFrame(b []byte) bool {
	return len(b) >= 4 && b[0] == FrameMagic && b[1] == FrameTypeChunk
}

// DecodeChunkFrame parses a binary chunk frame. Returns ok=false when invalid.
func DecodeChunkFrame(b []byte) (ChunkFrameHeader, []byte, bool) {
	var h ChunkFrameHeader
	if !IsChunkFrame(b) {
		return h, nil, false
	}
	headerLen := int(b[2]) | int(b[3])<<8
	if len(b) < 4+headerLen {
		return h, nil, false
	}
	if err := json.Unmarshal(b[4:4+headerLen], &h); err != nil {
		return h, nil, false
	}
	// Copy the payload so callers can retain it after the read buffer is reused.
	payload := make([]byte, len(b)-4-headerLen)
	copy(payload, b[4+headerLen:])
	return h, payload, true
}
