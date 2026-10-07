package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/narrafork/remote-executor/internal/history"
)

// SetHistory installs the process-wide private store. ConnectionScoped shares it
// without sharing PTY state, so receipts survive disconnects/reconnects.
func (h *Handlers) SetHistory(manager *history.Manager) {
	manager.SetNativeMutationIO(history.NativeMutationIO{
		Acquire:   acquireFileMutation,
		Capture:   captureHistoryMetadata,
		WithMode:  historyMetadataWithMode,
		Apply:     h.applyHistoryNative,
		Preflight: h.preflightHistoryNative,
	})
	h.history = manager
}

func (h *Handlers) History(ctx context.Context, method string, params map[string]any) (result any, resultErr error) {
	started := time.Now()
	defer func() {
		if duration := time.Since(started); duration >= time.Second {
			outcome := "ok"
			if resultErr != nil {
				outcome = "error"
			}
			log.Printf("history method=%s duration_ms=%d outcome=%s", method, duration.Milliseconds(), outcome)
		}
	}()
	if method != "history.capture" && method != "history.captureTree" && method != "history.mutate" && method != "history.restore" && method != "history.compensate" {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
	}
	if h.history == nil {
		return nil, fmt.Errorf("history unavailable: private stateDir not configured")
	}
	if method == "history.open" {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		root, err := requiredPathParam(params, "root")
		if err != nil {
			return nil, err
		}
		fence := intParam(params, "fence", 0)
		if fence <= 0 || fence > 9007199254740991 {
			return nil, fmt.Errorf("invalid history fence")
		}
		return h.history.Open(ctx, root, stringParam(params, "scopeId"), uint64(fence))
	}
	data, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	// Input cap applies before base64 decoding or journal allocation.
	if int64(len(data)) > h.maxRpcBytes {
		return nil, fmt.Errorf("history request budget exceeded")
	}
	var req history.Request
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, err
	}
	switch method {
	case "history.objectStage":
		var stage history.ObjectStageRequest
		if err := json.Unmarshal(data, &stage); err != nil {
			return nil, err
		}
		return h.history.StageObject(ctx, stage)
	case "history.captureTree":
		return h.history.CaptureTree(ctx, req)
	case "history.capture":
		return h.history.Capture(ctx, req)
	case "history.mutate":
		return h.history.Mutate(ctx, req, "mutate")
	case "history.restore":
		return h.history.Mutate(ctx, req, "restore")
	case "history.status":
		return h.history.Status(ctx, req.Binding, req.OperationID)
	case "history.finalize":
		return h.history.Finalize(ctx, req.Binding, req.OperationID, req.RequestDigest, stringParam(params, "serverCommitId"))
	case "history.compensate":
		return h.history.Compensate(ctx, req)
	case "history.inspect":
		return h.history.Inspect(ctx, req.Binding, req.Paths, stringParam(params, "cursor"))
	case "history.objectRead":
		var object history.Object
		raw, err := json.Marshal(params["object"])
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &object); err != nil {
			return nil, err
		}
		max := intParam(params, "maxBytes", history.ChunkBytes)
		// Budget includes base64 + metadata in the actual wire response.
		if max > (h.maxRpcBytes-8192)*3/4 {
			max = (h.maxRpcBytes - 8192) * 3 / 4
		}
		return h.history.ReadObject(ctx, req.Binding, object, intParam(params, "offset", 0), max)
	default:
		return nil, fmt.Errorf("unknown history method")
	}
}
