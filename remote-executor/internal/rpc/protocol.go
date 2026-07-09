// Package rpc defines the wire protocol between the NarraFork server and this
// remote executor. It mirrors server/lib/agent/execution/rpc-types.ts exactly.
// Keep the two in sync and bump ProtocolVersion on any breaking change.
package rpc

import "github.com/narrafork/remote-executor/internal/wire"

const ProtocolVersion = 1

// ── Frame envelope ────────────────────────────────────────────────────────────

// Frame is the common shape used to peek at a message's type before decoding
// it into a concrete frame struct.
type Frame struct {
	Type string `json:"type"`
}

// ── Handshake ───────────────────────────────────────────────────────────────

type Platform struct {
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	ShellPath      string `json:"shellPath,omitempty"`
	ShellType      string `json:"shellType,omitempty"`
	ShellLoginWrap bool   `json:"shellLoginWrap,omitempty"`
}

type Capabilities struct {
	Git     bool `json:"git"`
	Ripgrep bool `json:"ripgrep"`
	Pty     bool `json:"pty"`
}

type HelloFrame struct {
	Type            string       `json:"type"` // "hello"
	ProtocolVersion int          `json:"protocolVersion"`
	DeviceRef       string       `json:"deviceRef"`
	Token           string       `json:"token,omitempty"`
	AgentVersion    string       `json:"agentVersion"`
	Platform        Platform     `json:"platform"`
	DefaultCwd      string       `json:"defaultCwd,omitempty"`
	Capabilities    Capabilities `json:"capabilities"`
}

type HelloAckFrame struct {
	Type      string  `json:"type"` // "hello_ack"
	OK        bool    `json:"ok"`
	Error     string  `json:"error,omitempty"`
	SessionID string  `json:"sessionId,omitempty"`
	Limits    *Limits `json:"limits,omitempty"`
}

type Limits struct {
	MaxRpcBytes  int64 `json:"maxRpcBytes"`
	RpcTimeoutMs int64 `json:"rpcTimeoutMs"`
}

// ── RPC frames ────────────────────────────────────────────────────────────────

type RequestFrame struct {
	Type   string          `json:"type"` // "rpc"
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params map[string]any  `json:"params"`
}

type StreamFrame struct {
	Type    string `json:"type"` // "rpc_stream"
	ID      string `json:"id"`
	Channel string `json:"channel,omitempty"`
	ChunkB64 string `json:"chunkB64"`
}

type ResultFrame struct {
	Type   string `json:"type"` // "rpc_result"
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type CancelFrame struct {
	Type string `json:"type"` // "rpc_cancel"
	ID   string `json:"id"`
}

// ── Binary chunk frame codec (re-exported from the wire leaf package) ───────

const (
	TransferFrameMagic     = wire.FrameMagic
	TransferFrameTypeChunk = wire.FrameTypeChunk
)

// ChunkFrameHeader aliases the wire header type.
type ChunkFrameHeader = wire.ChunkFrameHeader

// EncodeChunkFrame builds a binary chunk frame from a header + raw payload.
func EncodeChunkFrame(header ChunkFrameHeader, payload []byte) ([]byte, error) {
	return wire.EncodeChunkFrame(header, payload)
}

// IsChunkFrame reports whether a binary message is a transfer chunk frame.
func IsChunkFrame(b []byte) bool { return wire.IsChunkFrame(b) }

// DecodeChunkFrame parses a binary chunk frame. Returns ok=false when invalid.
func DecodeChunkFrame(b []byte) (ChunkFrameHeader, []byte, bool) {
	return wire.DecodeChunkFrame(b)
}
