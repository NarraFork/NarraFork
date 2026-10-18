// Mirror of shared/editor-provider-contracts.ts. These are frozen wire shapes
// for editor Phases 6-9. Raw read and durable stage/apply/query are implemented
// and independently feature-gated; watch remains unadvertised. The shared fixture
// shared/editor-provider-contracts.golden.json is decoded strictly here and
// type-checked on the TS side. Required-nullable fields are pointers WITHOUT
// omitempty (they always encode, as null when absent); optional fields use
// omitempty.
package rpc

import "github.com/narrafork/remote-executor/internal/handlers"

type EditorProviderCapabilities struct {
	BoundedRead  bool `json:"boundedRead"`
	V1Save       bool `json:"v1Save"`
	RawRead      bool `json:"rawRead"`
	Stage        bool `json:"stage"`
	DurableApply bool `json:"durableApply"`
	DurableQuery bool `json:"durableQuery"`
	Watch        bool `json:"watch"`
}

type EditorResourceIdentity = handlers.EditorResourceIdentity

type EditorRawReadPreflight struct {
	ResourceKey string                 `json:"resourceKey"`
	Identity    EditorResourceIdentity `json:"identity"`
	MaxBytes    int64                  `json:"maxBytes"`
	TimeoutMs   int64                  `json:"timeoutMs"`
}

type EditorRawReadOpen struct {
	ReadID           string                 `json:"readId"`
	SourceGeneration string                 `json:"sourceGeneration"`
	TotalBytes       int64                  `json:"totalBytes"`
	RawDigest        string                 `json:"rawDigest"`
	Identity         EditorResourceIdentity `json:"identity"`
}

type EditorRawReadChunkRequest struct {
	ReadID    string `json:"readId"`
	Offset    int64  `json:"offset"`
	MaxBytes  int64  `json:"maxBytes"`
	TimeoutMs int64  `json:"timeoutMs"`
}

type EditorRawReadChunk struct {
	ReadID           string `json:"readId"`
	SourceGeneration string `json:"sourceGeneration"`
	Offset           int64  `json:"offset"`
	Bytes            int64  `json:"bytes"`
	DataB64          string `json:"dataB64"`
	EOF              bool   `json:"eof"`
}

type EditorRawReadClose struct {
	ReadID string `json:"readId"`
	Abort  bool   `json:"abort"`
}

type EditorStageOpen = handlers.EditorStageOpen
type EditorStageHandle = handlers.EditorStageHandle
type EditorStageAppend = handlers.EditorStageAppend
type EditorStageSeal = handlers.EditorStageSeal
type EditorStageAbort = handlers.EditorStageAbort
type EditorApplyRequest = handlers.EditorApplyRequest
type EditorProviderError = handlers.EditorProviderError
type EditorApplyResult = handlers.EditorApplyResult
type EditorQueryRequest = handlers.EditorQueryRequest
type EditorQueryResult = handlers.EditorQueryResult

type EditorWatchOpen struct {
	ResourceKey string `json:"resourceKey"`
}

type EditorWatchHandle struct {
	SubscriptionID string `json:"subscriptionId"`
	ResourceKey    string `json:"resourceKey"`
	Generation     int64  `json:"generation"`
}

type EditorWatchNotify struct {
	SubscriptionID string `json:"subscriptionId"`
	Seq            int64  `json:"seq"`
	Generation     int64  `json:"generation"`
	Reason         string `json:"reason"`
}

type EditorWatchClose struct {
	SubscriptionID string `json:"subscriptionId"`
}

var (
	EditorPathFlavors       = []string{"posix", "windows"}
	EditorStageAbortReasons = []string{"cancel", "idle_timeout", "superseded"}
	EditorMetadataPolicies  = []string{"preserve", "reject"}
	EditorApplyOutcomes     = []string{"committed", "rejected", "uncertain"}
	EditorQueryOutcomes     = []string{"committed", "rejected", "uncertain", "not_found", "proven_not_executed"}
	EditorWatchReasons      = []string{"content_changed", "metadata_changed", "deleted", "replaced", "generation_reset"}
	EditorProviderErrors    = []string{
		"EDITOR_IDENTITY_CHANGED",
		"EDITOR_RUNTIME_CHANGED",
		"EDITOR_FENCING_REJECTED",
		"EDITOR_STAGE_DIGEST_MISMATCH",
		"EDITOR_STAGE_SEAL_FAILED",
		"EDITOR_APPLY_REJECTED",
		"EDITOR_NOT_FOUND",
		"EDITOR_UNCERTAIN",
		"EDITOR_PROVIDER_UNSUPPORTED",
	}
)
