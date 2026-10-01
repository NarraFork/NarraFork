// Package rpc defines the wire protocol between the NarraFork server and this
// remote executor. It mirrors server/lib/agent/execution/rpc-types.ts exactly.
// Keep the two in sync and bump ProtocolVersion on any breaking change.
package rpc

import (
	"encoding/json"

	"github.com/narrafork/remote-executor/internal/wire"
)

const ProtocolVersion = 1

// FeatureFsStatResolvedPathV1 means fs.stat returns the canonical path approved
// by PathGuard. It is negotiated independently of the protocol version so old
// executors can remain connected for tools that do not need canonical paths.
const FeatureFsStatResolvedPathV1 = "fs.stat.resolved-path.v1"

// FeatureFsReadAtomicResolvedPathV1 means fs.read accepts expectedResolvedPath
// and verifies the opened file still has that canonical identity before reading.
const FeatureFsReadAtomicResolvedPathV1 = "fs.read.atomic-resolved-path.v1"

// FeatureFsWriteAtomicResolvedPathV1 means fs.write verifies expectedResolvedPath
// immediately before writing to the canonical create/existing path.
const FeatureFsWriteAtomicResolvedPathV1 = "fs.write.atomic-resolved-path.v1"

// FeatureGlobBoundedV1 guarantees cancellation/deadline checks during enumeration
// (including unmatched entries) and count/byte caps before collecting results.
const FeatureGlobBoundedV1 = "glob.bounded.v1"

// FeatureFsReadBoundedV1 means fs.read enforces cancellation/deadlines between
// bounded chunks and revalidates canonical identity and file size before returning.
const FeatureFsReadBoundedV1 = "fs.read.bounded.v1"

// Executor-serialized check-and-replace; not an OS-level CAS against external writers.
const FeatureFsConditionalWriteV1 = "fs.write.conditional.v1"

// FeatureGitWorkspaceV1 covers structured, bounded, cancellable full Git management.
const FeatureGitWorkspaceV1 = "git.workspace.v1"

// FeatureGitWorkspaceWatchV1 adds bounded metadata-only workspace fingerprints.
const FeatureGitWorkspaceWatchV1 = "git.workspace.watch.v1"

// ── Frame envelope ────────────────────────────────────────────────────────────

// Frame is the common shape used to peek at a message's type before decoding
// it into a concrete frame struct.
type Frame struct {
	Type string `json:"type"`
}

// ── Handshake ───────────────────────────────────────────────────────────────

type AuthInitFrame struct {
	Type          string `json:"type"` // "auth_init"
	AuthVersion   int    `json:"authVersion"`
	DeviceRef     string `json:"deviceRef"`
	ExecutorNonce string `json:"executorNonce"`
}

type AuthChallengeFrame struct {
	Type          string `json:"type"` // "auth_challenge"
	AuthVersion   int    `json:"authVersion"`
	DeviceRef     string `json:"deviceRef"`
	ExecutorNonce string `json:"executorNonce"`
	ServerNonce   string `json:"serverNonce"`
	Proof         string `json:"proof"`
}

type AuthProofFrame struct {
	Type          string `json:"type"` // "auth_proof"
	AuthVersion   int    `json:"authVersion"`
	DeviceRef     string `json:"deviceRef"`
	ExecutorNonce string `json:"executorNonce"`
	ServerNonce   string `json:"serverNonce"`
	Proof         string `json:"proof"`
}

type Platform struct {
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	ShellPath      string `json:"shellPath,omitempty"`
	ShellType      string `json:"shellType,omitempty"`
	ShellLoginWrap bool   `json:"shellLoginWrap,omitempty"`
}

type Capabilities struct {
	Git      bool     `json:"git"`
	Ripgrep  bool     `json:"ripgrep"`
	Pty      bool     `json:"pty"`
	Shell    bool     `json:"shell"`
	Features []string `json:"features,omitempty"`
}

// MarshalJSON keeps the capability rollout additive: every executor built from
// this package advertises canonical fs.stat support, while a legacy hello that
// is merely decoded remains unchanged and continues to lack the feature.
func (c Capabilities) MarshalJSON() ([]byte, error) {
	features := append([]string(nil), c.Features...)
	for _, required := range []string{
		FeatureFsStatResolvedPathV1,
		FeatureFsReadAtomicResolvedPathV1,
		FeatureFsWriteAtomicResolvedPathV1,
		FeatureGlobBoundedV1,
		FeatureFsReadBoundedV1,
		FeatureFsConditionalWriteV1,
		FeatureGitWorkspaceV1,
		FeatureGitWorkspaceWatchV1,
	} {
		seen := false
		for _, feature := range features {
			if feature == required {
				seen = true
				break
			}
		}
		if !seen {
			features = append(features, required)
		}
	}
	return json.Marshal(struct {
		Git      bool     `json:"git"`
		Ripgrep  bool     `json:"ripgrep"`
		Pty      bool     `json:"pty"`
		Shell    bool     `json:"shell"`
		Features []string `json:"features,omitempty"`
	}{
		Git:      c.Git,
		Ripgrep:  c.Ripgrep,
		Pty:      c.Pty,
		Shell:    c.Shell,
		Features: features,
	})
}

// PathRuleFrame reports one enforced path guard rule to the server.
//
// Reporting only: the server never sends rules back. The executor's own config is
// the authority, and this exists so the UI can show the operator when a saved rule
// set has not been applied on the machine yet.
type PathRuleFrame struct {
	Action string `json:"action"`
	Path   string `json:"path"`
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
	// PathRules is the ordered guard list in force. Optional and additive, so an
	// older server simply ignores it and no protocol bump is required. Always
	// non-nil when omitted is ambiguous: absent means "not reported", while an
	// empty array means "reported as unrestricted".
	PathRules []PathRuleFrame `json:"pathRules,omitempty"`
	// PathRulesUnrestricted distinguishes "no rules configured" from "did not
	// report", which an empty/omitted array alone cannot express.
	PathRulesUnrestricted bool `json:"pathRulesUnrestricted,omitempty"`
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
	Type   string         `json:"type"` // "rpc"
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

type StreamFrame struct {
	Type     string `json:"type"` // "rpc_stream"
	ID       string `json:"id"`
	Channel  string `json:"channel,omitempty"`
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
