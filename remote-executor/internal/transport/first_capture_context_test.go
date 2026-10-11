package transport

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

func firstFrameFixture(method, phase string) rpc.RequestFrame {
	root := windowsbackup.NativeDescriptor{VolumeID: "volume", FileID: "root", CreationTime: "1", PathKey: "root-slot"}
	o := &windowsbackup.FirstCaptureOrigin{Version: 1, DeviceID: "device", ExecutorSourceID: "source", ScopeID: "scope", Root: root, HelperInstanceID: "helper", HelperKeyEpoch: 1, OperationID: "operation", RequestDigest: strings.Repeat("a", 64), LeaseID: "lease", Fence: 1, ConnectionID: "connection", SessionID: "session", RuntimeGeneration: 1, Action: "capture_exact", Phase: phase, OuterRPCID: "rpc-original"}
	params := map[string]any{"version": 1, "path": "ordinary", "nonce": strings.Repeat("A", 32)}
	if method == windowsbackup.FirstCaptureMethod {
		params = map[string]any{"version": 1, "token": strings.Repeat("Q", 32), "preauthRpcId": "preauth-rpc", "preauthNonce": strings.Repeat("A", 32), "captureNonce": strings.Repeat("B", 32)}
	}
	return rpc.RequestFrame{Type: "rpc", ID: o.OuterRPCID, Method: method, Params: params, WindowsFirstCaptureOrigin: o}
}
func TestFirstCaptureFrameStrictOriginalMethodAndFields(t *testing.T) {
	for _, kind := range []string{"valid", "missing-origin", "frame-id", "method-swap", "phase", "unknown-field", "duplicate-field", "param-actor", "wrong-version"} {
		t.Run(kind, func(t *testing.T) {
			req := firstFrameFixture(windowsbackup.FirstCapturePreauthorizeMethod, "preauthorize")
			switch kind {
			case "missing-origin":
				req.WindowsFirstCaptureOrigin = nil
			case "frame-id":
				req.ID = "other"
			case "method-swap":
				req.Method = "history.inspect"
			case "phase":
				req.WindowsFirstCaptureOrigin.Phase = "status_original"
			case "param-actor":
				req.Params["actorSubjectKey"] = "forged"
			case "wrong-version":
				req.WindowsFirstCaptureOrigin.Version = 2
			}
			raw, err := json.Marshal(req)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "unknown-field" {
				raw = []byte(strings.Replace(string(raw), "\"type\":", "\"unknown\":1,\"type\":", 1))
			}
			if kind == "duplicate-field" {
				raw = []byte(strings.Replace(string(raw), "\"version\":1", "\"version\":1,\"version\":1", 1))
			}
			var decoded rpc.RequestFrame
			err = decodeFirstCaptureFrame(raw, &decoded)
			if kind == "valid" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("invalid first envelope accepted")
			}
		})
	}
}
func TestFirstCaptureContextExactCurrentConnectionAndMissingMaterial(t *testing.T) {
	req := firstFrameFixture(windowsbackup.FirstCaptureMethod, "capture")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entry := &requestCancel{cancel: func() {}}
	s := &connectionState{ctx: ctx, cancels: map[string]*requestCancel{req.ID: entry}, metadataSession: &rpc.WindowsMetadataSession{Version: 1, ConnectionID: "connection", SessionID: "session", RuntimeGeneration: 1}}
	s.authenticated.Store(true)
	installed, err := s.firstCaptureRequestContext(ctx, req, entry)
	if err != nil {
		t.Fatal(err)
	}
	o, err := windowsbackup.FirstCaptureRequest(installed, req.Method)
	if err != nil || o != *req.WindowsFirstCaptureOrigin {
		t.Fatal("origin was reconstructed or changed")
	}
	h := handlers.New(nil, 64<<10)
	if _, err := rpc.NewDispatcher(h).Dispatch(installed, req.Method, req.Params, nil); err == nil {
		t.Fatal("missing enrolled config silently fell back to history/FS")
	}
	s.metadataSession.SessionID = "other"
	if _, err := s.firstCaptureRequestContext(ctx, req, entry); err == nil {
		t.Fatal("foreign current session accepted")
	}
	s.metadataSession.SessionID = "session"
	delete(s.cancels, req.ID)
	if _, err := s.firstCaptureRequestContext(ctx, req, entry); err == nil {
		t.Fatal("old pending RPC reused")
	}
}
