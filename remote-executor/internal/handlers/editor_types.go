package handlers

// Shared by the WebSocket dispatcher and the bounded, credential-free stdio entry.
const FeatureEditorDurableWriteV1 = "editor.durable-write.v1"
const EditorMaxBytes int64 = 20 * 1024 * 1024
const EditorChunkBytes int64 = 64 * 1024

type EditorResourceIdentity struct {
	DeviceID          string `json:"deviceId"`
	PathFlavor        string `json:"pathFlavor"`
	CanonicalPath     string `json:"canonicalPath"`
	WorkspaceIdentity string `json:"workspaceIdentity"`
	RuntimeEpoch      string `json:"runtimeEpoch"`
	RuntimeGeneration int64  `json:"runtimeGeneration"`
	FencingToken      int64  `json:"fencingToken"`
}
type EditorStageOpen struct {
	Namespace     string `json:"namespace"`
	ResourceKey   string `json:"resourceKey"`
	MaxBytes      int64  `json:"maxBytes"`
	IdleTimeoutMs int64  `json:"idleTimeoutMs"`
}
type EditorStageHandle struct {
	StageID     string `json:"stageId"`
	ResourceKey string `json:"resourceKey"`
	ExpiresAt   int64  `json:"expiresAt"`
}
type EditorStageAppend struct {
	Namespace   string `json:"namespace"`
	ResourceKey string `json:"resourceKey"`
	StageID     string `json:"stageId"`
	Seq         int64  `json:"seq"`
	Offset      int64  `json:"offset"`
	Bytes       int64  `json:"bytes"`
	Digest      string `json:"digest"`
	DataB64     string `json:"dataB64"`
}
type EditorStageSeal struct {
	Namespace   string `json:"namespace"`
	ResourceKey string `json:"resourceKey"`
	StageID     string `json:"stageId"`
	TotalBytes  int64  `json:"totalBytes"`
	RawDigest   string `json:"rawDigest"`
}
type EditorStageAbort struct {
	Namespace   string `json:"namespace"`
	ResourceKey string `json:"resourceKey"`
	StageID     string `json:"stageId"`
	Reason      string `json:"reason"`
}
type EditorApplyRequest struct {
	Namespace       string                 `json:"namespace"`
	ResourceKey     string                 `json:"resourceKey"`
	OperationID     string                 `json:"operationId"`
	RequestDigest   string                 `json:"requestDigest"`
	StageID         string                 `json:"stageId"`
	ExpectedRawHash *string                `json:"expectedRawHash"`
	Identity        EditorResourceIdentity `json:"identity"`
	MetadataPolicy  string                 `json:"metadataPolicy"`
}
type EditorProviderError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type EditorApplyResult struct {
	OperationID string               `json:"operationId"`
	Outcome     string               `json:"outcome"`
	RawDigest   *string              `json:"rawDigest"`
	TotalBytes  *int64               `json:"totalBytes"`
	Error       *EditorProviderError `json:"error,omitempty"`
}
type EditorQueryRequest struct {
	Namespace           string `json:"namespace"`
	ResourceKey         string `json:"resourceKey"`
	OperationID         string `json:"operationId"`
	RequestDigest       string `json:"requestDigest"`
	AcknowledgeTerminal bool   `json:"acknowledgeTerminal,omitempty"`
}
type EditorQueryResult struct {
	OperationID string             `json:"operationId"`
	Outcome     string             `json:"outcome"`
	Result      *EditorApplyResult `json:"result"`
}
