package transport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

func editorWireDigest(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }
func startEditorWriteLoopback(t *testing.T, root, stateRoot string) (*testServer, context.Context) {
	t.Helper()
	server, peer := newTestServer(t)
	h := handlers.New(handlers.NewPathGuard([]string{root}), 128*1024)
	engine, err := handlers.NewEditorEngine(h, stateRoot)
	if err != nil {
		t.Fatal(err)
	}
	h.SetEditorEngine(engine)
	cfg := &config.Config{ServerURL: strings.Replace(server.URL, "http", "ws", 1), DeviceRef: "device", Token: "rdev_fixture", DefaultCwd: root, ReconnectMaxSeconds: 1}
	client := NewClient(cfg, rpc.NewDispatcher(h), rpc.Platform{}, rpc.Capabilities{Features: []string{handlers.FeatureEditorDurableWriteV1}})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	done := make(chan struct{})
	go func() { _ = client.Run(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		peer.conn.CloseNow()
		close(peer.done)
		server.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("fixture client did not exit")
		}
	})
	select {
	case <-peer.ready:
	case <-ctx.Done():
		t.Fatal("editor handshake", ctx.Err())
	}
	return peer, ctx
}
func editorWireCall(t *testing.T, peer *testServer, ctx context.Context, id, method string, params map[string]any) map[string]any {
	t.Helper()
	r, _, err := peer.call(ctx, id, method, params)
	if err != nil || !r.OK {
		t.Fatalf("%s: %v %+v", method, err, r)
	}
	return r.Result.(map[string]any)
}
func editorWireStage(t *testing.T, peer *testServer, ctx context.Context, body []byte) string {
	t.Helper()
	r := editorWireCall(t, peer, ctx, "open", "editor.stage.open", map[string]any{"namespace": "stable-owner", "resourceKey": "resource", "maxBytes": len(body), "idleTimeoutMs": 30000})
	stage := r["stageId"].(string)
	for offset, seq := 0, 0; offset < len(body); seq++ {
		end := min(offset+65536, len(body))
		chunk := body[offset:end]
		editorWireCall(t, peer, ctx, fmt.Sprint(seq), "editor.stage.append", map[string]any{"namespace": "stable-owner", "resourceKey": "resource", "stageId": stage, "seq": seq, "offset": offset, "bytes": len(chunk), "digest": editorWireDigest(chunk), "dataB64": base64.StdEncoding.EncodeToString(chunk)})
		offset = end
	}
	editorWireCall(t, peer, ctx, "seal", "editor.stage.seal", map[string]any{"namespace": "stable-owner", "resourceKey": "resource", "stageId": stage, "totalBytes": len(body), "rawDigest": editorWireDigest(body)})
	return stage
}
func TestEditorWriteFullLoopbackSizesAndLostSuccessQuery(t *testing.T) {
	for _, size := range []int{0, 3 * 1024 * 1024, 20 * 1024 * 1024} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			root := t.TempDir()
			stateRoot := filepath.Join(t.TempDir(), "state")
			path := filepath.Join(root, "document")
			if err := os.WriteFile(path, []byte("before"), 0640); err != nil {
				t.Fatal(err)
			}
			peer, ctx := startEditorWriteLoopback(t, root, stateRoot)
			found := false
			for _, feature := range peer.hello.Capabilities.Features {
				if feature == handlers.FeatureEditorDurableWriteV1 {
					found = true
				}
			}
			if !found {
				t.Fatal("writer hello feature missing")
			}
			meta := editorWireCall(t, peer, ctx, "stat", "fs.stat", map[string]any{"path": path, "editorRoot": root, "editorIdentity": true})
			body := bytes.Repeat([]byte("a"), size)
			stage := editorWireStage(t, peer, ctx, body)
			req := map[string]any{"namespace": "stable-owner", "resourceKey": "resource", "operationId": "op", "requestDigest": editorWireDigest([]byte("op")), "stageId": stage, "expectedRawHash": editorWireDigest([]byte("before")), "metadataPolicy": "preserve", "identity": map[string]any{"deviceId": "device", "pathFlavor": handlers.EditorPathFlavor(), "canonicalPath": meta["resolvedPath"], "workspaceIdentity": meta["rootIdentity"], "runtimeEpoch": meta["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}}
			// Send apply but deliberately never consume its success result. The next
			// RPC collector drops that unmatched frame and recovers solely by query.
			if err := writeJSON(ctx, peer.conn, rpc.RequestFrame{Type: "rpc", ID: "lost-success", Method: "editor.apply", Params: req}); err != nil {
				t.Fatal(err)
			}
			query := map[string]any{"namespace": "stable-owner", "resourceKey": "resource", "operationId": "op", "requestDigest": req["requestDigest"]}
			// Use a ping barrier plus response collection: a query that enters first
			// may honestly be not_found, which is never permission to reapply.
			var q map[string]any
			for i := 0; i < 32; i++ {
				q = editorWireCall(t, peer, ctx, fmt.Sprintf("query-%d", i), "editor.query", query)
				if q["outcome"] != "not_found" {
					break
				}
			}
			if q["outcome"] != "committed" {
				t.Fatal("lost success not recovered", q)
			}
			installed, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			fresh, freshCtx := startEditorWriteLoopback(t, root, stateRoot)
			q = editorWireCall(t, fresh, freshCtx, "restart-query", "editor.query", query)
			if q["outcome"] != "committed" {
				t.Fatal("engine restart lost receipt", q)
			}
			replay := editorWireCall(t, fresh, freshCtx, "replay", "editor.apply", req)
			if replay["outcome"] != "committed" {
				t.Fatal("replay failed", replay)
			}
			after, err := os.Stat(path)
			if err != nil || !os.SameFile(installed, after) {
				t.Fatal("query/replay performed a second rename")
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, body) {
				t.Fatal("loopback body mismatch", err)
			}
		})
	}
}
func TestEditorPrivateStateLoopback(t *testing.T) {
	root := t.TempDir()
	stateRoot := filepath.Join(root, "private-engine")
	path := filepath.Join(root, "document")
	if err := os.WriteFile(path, []byte("STATE_NEEDLE before"), 0640); err != nil {
		t.Fatal(err)
	}
	peer, ctx := startEditorWriteLoopback(t, root, stateRoot)
	meta := editorWireCall(t, peer, ctx, "stat", "fs.stat", map[string]any{"path": path, "editorRoot": root, "editorIdentity": true})
	secret := []byte("STATE_NEEDLE private body")
	stage := editorWireStage(t, peer, ctx, secret)
	private := filepath.Join(stateRoot, stage+".body")
	paths := []string{private, filepath.Join(stateRoot, "engine.lock")}
	if runtime.GOOS != "windows" {
		alias := filepath.Join(root, "private-alias")
		if err := os.Symlink(stateRoot, alias); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, filepath.Join(alias, stage+".body"))
	}
	for _, private := range paths {
		for _, call := range []struct {
			method string
			params map[string]any
		}{
			{"fs.stat", map[string]any{"path": private, "editorIdentity": true, "editorRoot": root}},
			{"fs.read", map[string]any{"path": private}},
			{"fs.write", map[string]any{"path": private, "dataB64": "Zm9yZ2Vk"}},
			{"fs.remove", map[string]any{"path": private}},
			{"transfer.stat", map[string]any{"path": private}},
			{"transfer.begin", map[string]any{"remotePath": private, "direction": "upload", "transferId": "private"}},
		} {
			result, _, err := peer.call(ctx, "denied", call.method, call.params)
			if err != nil || result.OK || !strings.Contains(result.Error, "private state") {
				t.Fatalf("WS %s leaked/modified private state: %v %+v", call.method, err, result)
			}
		}
	}
	for _, call := range []struct {
		method string
		params map[string]any
	}{
		{"fs.list", map[string]any{"path": root}},
		{"glob", map[string]any{"cwd": root, "pattern": "**", "dot": true}},
		{"transfer.stat", map[string]any{"path": root, "recursive": true}},
	} {
		result := editorWireCall(t, peer, ctx, "parent", call.method, call.params)
		b, _ := json.Marshal(result)
		if bytes.Contains(b, []byte(stage)) || bytes.Contains(b, []byte("private-engine")) {
			t.Fatal("WS parent traversal exposed private descendant", call.method, string(b))
		}
	}
	identity := map[string]any{"deviceId": "device", "pathFlavor": handlers.EditorPathFlavor(), "canonicalPath": private, "workspaceIdentity": meta["rootIdentity"], "runtimeEpoch": meta["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}
	read, _, err := peer.call(ctx, "private-raw", "editor.read.open", map[string]any{"resourceKey": "resource", "identity": identity, "maxBytes": 20 * 1024 * 1024, "timeoutMs": 30000})
	if err != nil || read.OK {
		t.Fatal("WS raw read bypassed private state", err, read)
	}
	identity["canonicalPath"] = meta["resolvedPath"]
	body := []byte("STATE_NEEDLE saved")
	writeStage := editorWireStage(t, peer, ctx, body)
	req := map[string]any{"namespace": "stable-owner", "resourceKey": "resource", "operationId": "normal", "requestDigest": editorWireDigest([]byte("normal")), "stageId": writeStage, "expectedRawHash": editorWireDigest([]byte("STATE_NEEDLE before")), "metadataPolicy": "preserve", "identity": identity}
	if result := editorWireCall(t, peer, ctx, "apply", "editor.apply", req); result["outcome"] != "committed" {
		t.Fatal("normal apply was blocked by private deny", result)
	}
	if query := editorWireCall(t, peer, ctx, "query", "editor.query", map[string]any{"namespace": "stable-owner", "resourceKey": "resource", "operationId": "normal", "requestDigest": req["requestDigest"]}); query["outcome"] != "committed" {
		t.Fatal("normal query was blocked", query)
	}
	got, err := os.ReadFile(private)
	if err != nil || !bytes.Equal(got, secret) {
		t.Fatal("generic WS forged private evidence", err)
	}
}

func TestEditorWriterFeatureRequiresConfiguredEngine(t *testing.T) {
	h := handlers.New(handlers.NewPathGuard([]string{t.TempDir()}), 128*1024)
	d := rpc.NewDispatcher(h)
	if _, err := d.Dispatch(context.Background(), "editor.capabilities", map[string]any{}, nil); err == nil {
		t.Fatal("unconfigured fixture advertised editor writer")
	}
	e, err := handlers.NewEditorEngine(h, filepath.Join(t.TempDir(), "stages"))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.ConfigureHostReceipts(filepath.Join(t.TempDir(), "host-receipts")); err != nil {
		t.Fatal(err)
	}
	h.SetEditorEngine(e)
	for _, method := range []string{"editor.hostReceipt.put", "editor.hostReceipt.get", "editor.hostReceipt.settle"} {
		if _, err := d.Dispatch(context.Background(), method, map[string]any{"operationId": "hidden"}, nil); err == nil {
			t.Fatal("WS exposed trusted Host store", method)
		}
	}
}
