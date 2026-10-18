package transport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

func newEditorReadLoopback(t *testing.T) (*testServer, context.Context, map[string]any, string) {
	t.Helper()
	state, peer, root := newCancelTestConnection(t)
	if err := os.WriteFile(filepath.Join(root, "source"), []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { _ = state.serveAuthenticated(); close(served) }()
	t.Cleanup(func() {
		state.close()
		select {
		case <-served:
		case <-time.After(time.Second):
			t.Error("serve loop leaked")
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	ts := &testServer{conn: peer}
	stat, _, err := ts.call(ctx, "stat", "fs.stat", map[string]any{"path": root, "editorIdentity": true})
	if err != nil || !stat.OK {
		t.Fatalf("stat: %v %+v", err, stat)
	}
	meta := stat.Result.(map[string]any)
	params := map[string]any{"resourceKey": "r", "maxBytes": 20 * 1024 * 1024, "timeoutMs": 30000, "identity": map[string]any{"deviceId": "device", "pathFlavor": handlers.EditorPathFlavor(), "canonicalPath": filepath.Join(meta["canonicalRoot"].(string), "source"), "workspaceIdentity": meta["rootIdentity"], "runtimeEpoch": meta["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}}
	return ts, ctx, params, root
}

func TestEditorReadSourceTimeoutCloseLoopback(t *testing.T) {
	for _, mode := range []string{"source replaced", "path denied", "close", "abort", "deadline", "idle"} {
		t.Run(mode, func(t *testing.T) {
			ts, ctx, params, root := newEditorReadLoopback(t)
			identity := params["identity"].(map[string]any)
			if mode == "path denied" {
				outside := filepath.Join(t.TempDir(), "secret")
				if err := os.WriteFile(outside, []byte("secret"), 0600); err != nil {
					t.Fatal(err)
				}
				identity["canonicalPath"] = outside
			}
			if mode == "deadline" {
				params["timeoutMs"] = 100
			}
			opened, _, err := ts.call(ctx, "open", "editor.read.open", params)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "path denied" {
				if opened.OK {
					t.Fatal("outside guard read accepted")
				}
				return
			}
			if !opened.OK {
				t.Fatal("open failed", opened.Error)
			}
			id := opened.Result.(map[string]any)["readId"]
			switch mode {
			case "source replaced":
				path := filepath.Join(root, "source")
				if err := os.Rename(path, path+".old"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("content"), 0600); err != nil {
					t.Fatal(err)
				}
			case "close", "abort":
				closed, _, err := ts.call(ctx, "close", "editor.read.close", map[string]any{"readId": id, "abort": mode == "abort"})
				if err != nil || !closed.OK {
					t.Fatal("close failed", err)
				}
			case "deadline":
				<-time.After(150 * time.Millisecond)
			case "idle":
				<-time.After(10100 * time.Millisecond)
			}
			result, _, err := ts.call(ctx, "chunk", "editor.read.chunk", map[string]any{"readId": id, "offset": 0, "maxBytes": 65536, "timeoutMs": 1000})
			if err != nil || result.OK {
				t.Fatalf("%s did not reject/release: %v %+v", mode, err, result)
			}
		})
	}
}

func TestEditorReadCancelledUndeliveredPullLoopback(t *testing.T) {
	state, peer, root := newCancelTestConnection(t)
	path := filepath.Join(root, "source")
	if err := os.WriteFile(path, []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stat, err := state.dispatcher.Dispatch(ctx, "fs.stat", map[string]any{"path": root, "editorIdentity": true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	meta := stat.(map[string]any)
	params := map[string]any{"resourceKey": "r", "maxBytes": 20 * 1024 * 1024, "timeoutMs": 30000, "identity": map[string]any{"deviceId": "device", "pathFlavor": handlers.EditorPathFlavor(), "canonicalPath": filepath.Join(meta["canonicalRoot"].(string), "source"), "workspaceIdentity": meta["rootIdentity"], "runtimeEpoch": meta["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}}
	result, err := state.dispatcher.Dispatch(ctx, "editor.read.open", params, nil)
	if err != nil {
		t.Fatal(err)
	}
	opened := result.(rpc.EditorRawReadOpen)
	state.writeMu.Lock()
	defer state.writeMu.Unlock()
	barrier := make(chan struct{})
	state.cancels["read-barrier"] = &requestCancel{cancel: func() { close(barrier) }}
	served := make(chan struct{})
	go func() { _ = state.serveAuthenticated(); close(served) }()
	t.Cleanup(func() {
		state.close()
		select {
		case <-served:
		case <-time.After(time.Second):
			t.Error("serve loop leaked")
		}
	})
	pull := map[string]any{"readId": opened.ReadID, "offset": 0, "maxBytes": 1, "timeoutMs": 30000}
	if err := writeJSON(ctx, peer, rpc.RequestFrame{Type: "rpc", ID: "pull", Method: "editor.read.chunk", Params: pull}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(ctx, peer, rpc.CancelFrame{Type: "rpc_cancel", ID: "read-barrier"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-barrier:
	case <-ctx.Done():
		t.Fatal("request not registered")
	}
	// The response write is held by the existing transport fixture's gate.
	// Observe completion of this request's own cleanup, not a guessed sleep.
	finished := make(chan struct{})
	var calls atomic.Int32
	state.cancelMu.Lock()
	entry := state.cancels["pull"]
	if entry == nil {
		state.cancelMu.Unlock()
		t.Fatal("pull completed behind locked write gate")
	}
	original := entry.cancel
	entry.cancel = func() {
		original()
		if calls.Add(1) == 2 {
			close(finished)
		}
	}
	state.cancelMu.Unlock()
	if err := writeJSON(ctx, peer, rpc.CancelFrame{Type: "rpc_cancel", ID: "pull"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("cancelled pull did not finish")
	}
	_, err = state.dispatcher.Dispatch(ctx, "editor.read.chunk", pull, nil)
	if err == nil || !strings.Contains(err.Error(), "EDITOR_NOT_FOUND") {
		t.Fatal("cancelled pull retained its handle", err)
	}
}

func TestEditorReadDisconnectLoopback(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "source"), []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	srv1, a := newTestServer(t)
	defer srv1.Close()
	srv2, b := newTestServer(t)
	defer srv2.Close()
	cancel1 := startExecutor(t, srv1.URL, root)
	defer cancel1()
	defer close(a.done)
	cancel2 := startExecutor(t, srv2.URL, root)
	defer cancel2()
	defer close(b.done)
	for _, peer := range []*testServer{a, b} {
		select {
		case <-peer.ready:
		case <-time.After(5 * time.Second):
			t.Fatal("handshake timeout")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stat, _, err := a.call(ctx, "stat", "fs.stat", map[string]any{"path": root, "editorIdentity": true})
	if err != nil || !stat.OK {
		t.Fatal("stat", err)
	}
	meta := stat.Result.(map[string]any)
	params := map[string]any{"resourceKey": "r", "maxBytes": 20 * 1024 * 1024, "timeoutMs": 30000, "identity": map[string]any{"deviceId": "test-device", "pathFlavor": handlers.EditorPathFlavor(), "canonicalPath": filepath.Join(meta["canonicalRoot"].(string), "source"), "workspaceIdentity": meta["rootIdentity"], "runtimeEpoch": meta["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}}
	var first any
	for i := 0; i < 8; i++ {
		res, _, err := a.call(ctx, fmt.Sprint(i), "editor.read.open", params)
		if err != nil || !res.OK {
			t.Fatalf("open %d: %v %+v", i, err, res)
		}
		if i == 0 {
			first = res.Result.(map[string]any)["readId"]
		}
	}
	res, _, err := b.call(ctx, "foreign", "editor.read.chunk", map[string]any{"readId": first, "offset": 0, "maxBytes": 1, "timeoutMs": 1000})
	if err != nil || res.OK {
		t.Fatal("cross-connection handle accepted", err)
	}
	res, _, err = b.call(ctx, "full", "editor.read.open", params)
	if err != nil || res.OK {
		t.Fatal("global capacity ignored", err)
	}
	// Stop only this test-owned client: disconnect must close all eight FDs and
	// return all eight permits before its replacement connection admits reads.
	cancel1()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		res, _, err = b.call(ctx, "retry", "editor.read.open", params)
		if err != nil {
			t.Fatal(err)
		}
		if res.OK {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("disconnect leaked read permits")
		}
	}
	ids := []any{res.Result.(map[string]any)["readId"]}
	for i := 1; i < 8; i++ {
		res, _, err = b.call(ctx, fmt.Sprint(i), "editor.read.open", params)
		if err != nil || !res.OK {
			t.Fatalf("disconnect failed to release permit %d: %v %+v", i, err, res)
		}
		ids = append(ids, res.Result.(map[string]any)["readId"])
	}
	for _, id := range ids {
		res, _, err := b.call(ctx, "close", "editor.read.close", map[string]any{"readId": id, "abort": true})
		if err != nil || !res.OK {
			t.Fatal("cleanup", err)
		}
	}
}

func TestEditorRawReadLoopback(t *testing.T) {
	for _, size := range []int{0, 3*1024*1024 + 7, 20 * 1024 * 1024} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "raw.bin")
			f, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			block := bytes.Repeat([]byte{0xef, 0xbb, 0xbf, 0x00, 0xff, 0x0d, 0x0a, 0x80}, 8192)
			expected := sha256.New()
			for remaining := size; remaining > 0; {
				n := min(remaining, len(block))
				if _, err := f.Write(block[:n]); err != nil {
					t.Fatal(err)
				}
				expected.Write(block[:n])
				remaining -= n
			}
			f.Close()
			srv, ts := newTestServer(t)
			defer srv.Close()
			cancel := startExecutor(t, srv.URL, root)
			defer cancel()
			defer close(ts.done)
			select {
			case <-ts.ready:
			case <-time.After(5 * time.Second):
				t.Fatal("handshake timeout")
			}
			found := false
			for _, feature := range ts.hello.Capabilities.Features {
				if feature == rpc.FeatureEditorRawReadV1 {
					found = true
				}
			}
			if !found {
				t.Fatal("raw handler feature missing")
			}
			ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
			defer stop()
			stat, _, err := ts.call(ctx, "stat", "fs.stat", map[string]any{"path": root, "editorIdentity": true})
			if err != nil || !stat.OK {
				t.Fatalf("root stat: %v %+v", err, stat)
			}
			identity := stat.Result.(map[string]any)
			resource := map[string]any{"deviceId": "test-device", "pathFlavor": handlers.EditorPathFlavor(), "canonicalPath": filepath.Join(identity["canonicalRoot"].(string), "raw.bin"), "workspaceIdentity": identity["rootIdentity"], "runtimeEpoch": identity["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}
			opened, _, err := ts.call(ctx, "open", "editor.read.open", map[string]any{"resourceKey": "authorized-resource", "identity": resource, "maxBytes": 20 * 1024 * 1024, "timeoutMs": 30000})
			if err != nil || !opened.OK {
				t.Fatalf("open: %v %+v", err, opened)
			}
			preflight := opened.Result.(map[string]any)
			readID := preflight["readId"].(string)
			source := preflight["sourceGeneration"].(string)
			if preflight["totalBytes"].(float64) != float64(size) || preflight["rawDigest"] != hex.EncodeToString(expected.Sum(nil)) {
				t.Fatal("preflight digest/size mismatch")
			}
			got := sha256.New()
			var offset int64
			for seq := 0; ; seq++ {
				credit := 65536
				if seq == 0 {
					credit = 1
				}
				if seq == 1 {
					credit = 7
				}
				result, _, err := ts.call(ctx, fmt.Sprint(seq), "editor.read.chunk", map[string]any{"readId": readID, "offset": offset, "maxBytes": credit, "timeoutMs": 30000})
				if err != nil || !result.OK {
					t.Fatalf("chunk offset %d: %v %+v", offset, err, result)
				}
				chunk := result.Result.(map[string]any)
				data, err := base64.StdEncoding.DecodeString(chunk["dataB64"].(string))
				if err != nil || len(data) > credit || chunk["bytes"] != float64(len(data)) || chunk["offset"] != float64(offset) || chunk["readId"] != readID || chunk["sourceGeneration"] != source {
					t.Fatal("chunk identity/credit mismatch")
				}
				// Every byte is verified in addition to the complete digest.
				for i, b := range data {
					if b != block[(int(offset)+i)%len(block)] {
						t.Fatal("raw byte mismatch")
					}
				}
				got.Write(data)
				offset += int64(len(data))
				if chunk["eof"] == true {
					break
				}
			}
			if offset != int64(size) || !bytes.Equal(got.Sum(nil), expected.Sum(nil)) {
				t.Fatal("EOF total/digest mismatch")
			}
			after, _, err := ts.call(ctx, "after-eof", "editor.read.chunk", map[string]any{"readId": readID, "offset": offset, "maxBytes": 1, "timeoutMs": 1000})
			if err != nil || after.OK {
				t.Fatal("EOF handle remains usable", err)
			}
			for i := 0; i < 2; i++ {
				closed, _, err := ts.call(ctx, "close", "editor.read.close", map[string]any{"readId": readID, "abort": true})
				if err != nil || !closed.OK {
					t.Fatal("idempotent close", err)
				}
			}
			// Actual RPC validation failure is terminal and releases the handle.
			opened, _, err = ts.call(ctx, "reopen", "editor.read.open", map[string]any{"resourceKey": "authorized-resource", "identity": resource, "maxBytes": 20 * 1024 * 1024, "timeoutMs": 30000})
			if err != nil || !opened.OK {
				t.Fatal("reopen", err)
			}
			badID := opened.Result.(map[string]any)["readId"]
			bad, _, err := ts.call(ctx, "bad-offset", "editor.read.chunk", map[string]any{"readId": badID, "offset": -1, "maxBytes": 1, "timeoutMs": 1000})
			if err != nil || bad.OK {
				t.Fatal("invalid offset accepted", err)
			}
			bad, _, err = ts.call(ctx, "released", "editor.read.chunk", map[string]any{"readId": badID, "offset": 0, "maxBytes": 1, "timeoutMs": 1000})
			if err != nil || bad.OK {
				t.Fatal("failed pull left usable handle", err)
			}
			t.Logf("verified %d raw bytes, sha256=%s, max chunk=65536, EOF/error handles released", size, hex.EncodeToString(got.Sum(nil)))
		})
	}
}
