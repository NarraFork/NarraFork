// Package history provides target IO and a private, durable evidence journal.
// It deliberately contains no editor, encoding, or inverse-change algorithms.
package history

import (
	"context"
	"errors"
	"os"
)

// Only this typed pre-dispatch refusal can produce a rejected receipt. Errors
// from Apply (including this error after admission) remain uncertain.
var ErrUnsupportedCrossFilesystem = errors.New("unsupported_cross_filesystem")

// NativeMutationIO preserves platform metadata for existing regular replacements.
// Missing support must fail before intent/target IO, never silently drop ACL/xattrs.
type NativeApplyRequest struct {
	Path                     string
	Before                   State
	Desired                  State
	BeforeBytes              []byte
	DesiredBytes             []byte
	BeforeMetadata           []byte
	DesiredMetadata          []byte
	PrivateRecoveryDirectory string
}

type NativeMutationIO struct {
	Capture  func(context.Context, *os.File) ([]byte, error)
	WithMode func(context.Context, []byte, uint32) ([]byte, error)
	// Preflight must not mutate targets; the entire batch is checked before any
	// durable dispatch admission. A nil callback does not upgrade legacy adapters.
	Preflight func(context.Context, NativeApplyRequest) error
	Apply     func(context.Context, NativeApplyRequest) error
	Acquire   func(context.Context) (func(), error)
	Validate  func(context.Context, string, State, State) error
	Replace   func(context.Context, string, State, []byte, []byte) error
}

const (
	BlobBytes     int64 = 32 << 20
	EvidenceBytes int64 = 256 << 20
	ChunkBytes    int64 = 1 << 20
	MaxFiles            = 1000
	MaxReceipts         = 100000
	JournalBytes  int64 = 64 << 20
	QuotaBytes    int64 = 5 << 30
)

type Binding struct {
	SourceInstanceID    string `json:"sourceInstanceId"`
	WorkspaceInstanceID string `json:"workspaceInstanceId"`
	ScopeID             string `json:"scopeId"`
	Root                string `json:"root"`
	RootIdentity        string `json:"rootIdentity"`
	Fence               uint64 `json:"fence"`
}

type Object struct {
	SourceInstanceID    string `json:"sourceInstanceId"`
	WorkspaceInstanceID string `json:"workspaceInstanceId"`
	ScopeID             string `json:"scopeId"`
	ObjectID            string `json:"objectId"`
	Algorithm           string `json:"algorithm"`
	Digest              string `json:"digest"`
	SizeBytes           int64  `json:"sizeBytes"`
	Kind                string `json:"kind"`
	Path                string `json:"path"`
}

type State struct {
	Incarnation string  `json:"incarnation,omitempty"`
	Metadata    *Object `json:"metadata,omitempty"`
	Kind        string  `json:"kind"`
	Object      *Object `json:"object,omitempty"`
	Mode        uint32  `json:"mode,omitempty"`
}

type Change struct {
	Path     string `json:"path"`
	Expected State  `json:"expected"`
	Desired  State  `json:"desired"`
	// Inline content is bounded and never persisted in the receipt.
	ContentBase64 *string `json:"contentBase64,omitempty"`
}

type Effect struct {
	Path     string `json:"path"`
	Before   State  `json:"before"`
	Intended State  `json:"intended"`
	After    *State `json:"after,omitempty"`
	Outcome  string `json:"outcome"`
}

type CaptureAttempt struct {
	Phase    string  `json:"phase"`
	Tree     *Object `json:"tree,omitempty"`
	Coverage string  `json:"coverage"`
	Reason   string  `json:"reason,omitempty"`
}

type Receipt struct {
	CaptureKind         string           `json:"captureKind,omitempty"`
	CapturePhase        string           `json:"capturePhase,omitempty"`
	CaptureAttempts     []CaptureAttempt `json:"captureAttempts,omitempty"`
	EntryCount          int              `json:"entryCount,omitempty"`
	ExcludedCount       int              `json:"excludedCount,omitempty"`
	CandidateBytes      int64            `json:"candidateBytes,omitempty"`
	Consistency         string           `json:"consistency,omitempty"`
	PolicyDigest        string           `json:"policyDigest,omitempty"`
	OperationID         string           `json:"operationId"`
	RequestDigest       string           `json:"requestDigest"`
	PayloadDigest       string           `json:"payloadDigest"`
	Binding             Binding          `json:"binding"`
	Kind                string           `json:"kind"`
	State               string           `json:"state"`
	Effects             []Effect         `json:"effects"`
	Tree                *Object          `json:"tree,omitempty"`
	Coverage            string           `json:"coverage,omitempty"`
	TemporalConsistency string           `json:"temporalConsistency,omitempty"`
	Reason              string           `json:"reason,omitempty"`
	StartedAt           string           `json:"startedAt"`
	FinishedAt          string           `json:"finishedAt,omitempty"`
	ServerCommitID      string           `json:"serverCommitId,omitempty"`
}

type TreeCapturePolicy struct {
	DeniedDirectories []string `json:"deniedDirectories"`
	PolicyDigest      string   `json:"policyDigest"`
}

type Request struct {
	TreePolicy    *TreeCapturePolicy `json:"treePolicy,omitempty"`
	CapturePhase  string             `json:"capturePhase,omitempty"`
	Binding       Binding            `json:"binding"`
	OperationID   string             `json:"operationId"`
	RequestDigest string             `json:"requestDigest"`
	Changes       []Change           `json:"changes,omitempty"`
	// Capture only explicitly admitted paths; never scans an unreviewed repository.
	Paths               []string `json:"paths,omitempty"`
	OriginalOperationID string   `json:"originalOperationId,omitempty"`
}

type ObjectRead struct {
	Object        Object `json:"object"`
	ContentBase64 string `json:"contentBase64"`
	Offset        int64  `json:"offset"`
	EOF           bool   `json:"eof"`
}

type Observation struct {
	Path  string `json:"path"`
	State *State `json:"state,omitempty"`
	Error string `json:"error,omitempty"`
}

type Inspection struct {
	Binding      Binding       `json:"binding"`
	Observations []Observation `json:"observations"`
	Pending      []Receipt     `json:"pending"`
	NextCursor   string        `json:"nextCursor,omitempty"`
}
