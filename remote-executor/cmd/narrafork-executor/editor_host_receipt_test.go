package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func hostRecordFixture(t *testing.T, p *stdioPeer, root, id string) map[string]any {
	t.Helper()
	stat := p.must(t, "fs.stat", map[string]any{"path": root, "editorIdentity": true})
	digest := stdioDigest([]byte("saved"))
	return map[string]any{"version": 1, "createdAt": time.Now().UnixMilli(), "userId": "user", "narratorId": "narrator", "deviceId": "local", "operationId": id, "hostOperationId": "host-" + id, "leaseId": "lease", "effectId": "effect", "saved": map[string]any{"hash": digest, "bytes": 5, "snapshotRevision": 1, "hashKind": "raw-sha256"}, "requestDigest": stdioDigest([]byte(id)), "namespace": "owner", "resourceKey": "resource", "root": root, "identity": map[string]any{"deviceId": "local", "pathFlavor": map[bool]string{true: "windows", false: "posix"}[runtime.GOOS == "windows"], "canonicalPath": filepath.Join(root, "document"), "workspaceIdentity": stat["rootIdentity"], "runtimeEpoch": stat["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}, "rawDigest": digest, "bytes": 5}
}
func hostProof(id string) map[string]any {
	return map[string]any{"operationId": id, "outcome": "committed", "rawDigest": stdioDigest([]byte("saved")), "totalBytes": 5}
}
func testEditorHostReceiptBinary(t *testing.T, binary string) {
	for name, encode := range map[string]func(string) []byte{
		"utf8-bom": func(text string) []byte { return append([]byte{0xef, 0xbb, 0xbf}, []byte(text)...) },
		"utf16le": func(text string) []byte {
			raw := []byte{0xff, 0xfe}
			for _, ch := range []byte(text) {
				raw = append(raw, ch, 0)
			}
			return raw
		},
	} {
		t.Run("native-host-v1-"+name, func(t *testing.T) {
			root := t.TempDir()
			store := filepath.Join(t.TempDir(), "host")
			state := filepath.Join(t.TempDir(), "state")
			path := filepath.Join(root, "document")
			before := encode("before\n")
			if err := os.WriteFile(path, before, 0640); err != nil {
				t.Fatal(err)
			}
			p := startEditorPeer(t, binary, root, state, true, store)
			save := func(peer *stdioPeer, id string, base []byte, text string) []byte {
				raw := encode(text)
				textHash := stdioDigest([]byte(text))
				rawHash := stdioDigest(raw)
				if textHash == rawHash {
					t.Fatal("v1 fixture did not split hash domains")
				}
				req := prepareStdio(t, peer, root, path, id, base, raw)
				record := hostRecordFixture(t, peer, root, id)
				record["namespace"], record["resourceKey"], record["identity"], record["requestDigest"] = req["namespace"], req["resourceKey"], req["identity"], req["requestDigest"]
				record["rawDigest"], record["bytes"] = rawHash, len(raw)
				record["saved"] = map[string]any{"hash": textHash, "bytes": len(raw), "snapshotRevision": 1}
				peer.must(t, "editor.hostReceipt.put", map[string]any{"value": record})
				peer.must(t, "editor.apply", req) // discard this success; recover only by durable query
				query := map[string]any{"namespace": req["namespace"], "resourceKey": req["resourceKey"], "operationId": id, "requestDigest": req["requestDigest"]}
				proof := peer.must(t, "editor.query", query)["result"].(map[string]any)
				if proof["rawDigest"] != rawHash {
					t.Fatal("installation proof used text hash")
				}
				peer.must(t, "editor.hostReceipt.settle", map[string]any{"operationId": id, "receipt": proof})
				got := peer.must(t, "editor.hostReceipt.get", map[string]any{"operationId": id})["value"].(map[string]any)
				if got["saved"].(map[string]any)["hash"] != textHash || got["receipt"].(map[string]any)["rawDigest"] != rawHash {
					t.Fatal("v1 saved hash was rewritten into raw domain")
				}
				query["acknowledgeTerminal"] = true
				peer.must(t, "editor.query", query)
				bytesOnDisk, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(bytesOnDisk, raw) {
					t.Fatal("encoded v1 bytes were altered", err)
				}
				return raw
			}
			first := save(p, "v1-first", before, "ok\n")
			if err := p.finish(); err != nil {
				t.Fatal(err)
			}
			cold := startEditorPeer(t, binary, root, state, true, store)
			got := cold.must(t, "editor.hostReceipt.get", map[string]any{"operationId": "v1-first"})["value"].(map[string]any)
			saved := got["saved"].(map[string]any)
			proof := got["receipt"].(map[string]any)
			if _, present := saved["hashKind"]; present || saved["hash"] != stdioDigest([]byte("ok\n")) || proof["rawDigest"] != stdioDigest(first) {
				t.Fatal("cold process lost legacy text/raw distinction")
			}
			save(cold, "v1-next", first, "next\n")
		})
	}
	t.Run("native-host-receipt", func(t *testing.T) {
		root := t.TempDir()
		store := filepath.Join(t.TempDir(), "host-receipts")
		p := startEditorPeer(t, binary, root, filepath.Join(t.TempDir(), "stages-a"), true, store)
		caps := p.must(t, "editor.capabilities", map[string]any{})
		found := false
		for _, v := range caps["features"].([]any) {
			if v == "editor.host-receipt.v1" {
				found = true
			}
		}
		if !found {
			t.Fatal("native Host receipt capability missing")
		}
		record := hostRecordFixture(t, p, root, "terminal")
		// Large bounded metadata must leave room for a later terminal envelope.
		record["namespace"] = strings.Repeat("n", 7000)
		record["resourceKey"] = strings.Repeat("r", 5000)
		p.must(t, "editor.hostReceipt.put", map[string]any{"value": record})
		p.must(t, "editor.hostReceipt.put", map[string]any{"value": record})
		wrong := map[string]any{}
		for k, v := range record {
			wrong[k] = v
		}
		wrong["userId"] = "other"
		if r := p.call(t, "editor.hostReceipt.put", map[string]any{"value": wrong}); r.OK {
			t.Fatal("immutable Host association was overwritten")
		}
		if r := p.call(t, "editor.hostReceipt.get", map[string]any{"operationId": "../arbitrary"}); r.OK {
			t.Fatal("Host receipt accepted a path as op ID")
		}
		badProof := hostProof("terminal")
		badProof["totalBytes"] = 4
		if r := p.call(t, "editor.hostReceipt.settle", map[string]any{"operationId": "terminal", "receipt": badProof}); r.OK {
			t.Fatal("mismatched positive proof accepted")
		}
		badProof = hostProof("terminal")
		badProof["outcome"] = "uncertain"
		if r := p.call(t, "editor.hostReceipt.settle", map[string]any{"operationId": "terminal", "receipt": badProof}); r.OK {
			t.Fatal("uncertain proof became Host-settled")
		}
		p.must(t, "editor.hostReceipt.settle", map[string]any{"operationId": "terminal", "receipt": hostProof("terminal")})
		p.must(t, "editor.hostReceipt.settle", map[string]any{"operationId": "terminal", "receipt": hostProof("terminal")})
		if err := p.finish(); err != nil {
			t.Fatal("first Host helper did not exit cleanly", err)
		}
		// After actual process exit, a newly started binary has another stage
		// state dir and recovers the same durable association/terminal proof.
		second := startEditorPeer(t, binary, root, filepath.Join(t.TempDir(), "stages-b"), false, store)
		got := second.must(t, "editor.hostReceipt.get", map[string]any{"operationId": "terminal"})["value"].(map[string]any)
		if got["userId"] != "user" || got["receipt"].(map[string]any)["outcome"] != "committed" {
			t.Fatal("fresh helper lost original association/positive proof")
		}
		p = second
		second = startEditorPeer(t, binary, root, filepath.Join(t.TempDir(), "stages-c"), false, store)
		for i := 0; i < 255; i++ {
			r := hostRecordFixture(t, p, root, fmt.Sprintf("pending-%d", i))
			p.must(t, "editor.hostReceipt.put", map[string]any{"value": r})
		}
		// Inventory is full: only the Host-settled terminal may be reclaimed.
		next := hostRecordFixture(t, p, root, "after-pressure")
		p.must(t, "editor.hostReceipt.put", map[string]any{"value": next})
		if old := p.must(t, "editor.hostReceipt.get", map[string]any{"operationId": "terminal"}); old["value"] != nil {
			t.Fatal("terminal pressure retention failed")
		}
		if pending := p.must(t, "editor.hostReceipt.get", map[string]any{"operationId": "pending-0"}); pending["value"] == nil {
			t.Fatal("pressure deleted unknown sole proof")
		}
		if r := p.call(t, "editor.hostReceipt.put", map[string]any{"value": hostRecordFixture(t, p, root, "beyond-unknown-cap")}); r.OK {
			t.Fatal("unknown sole-proof capacity was not enforced")
		}
		// Both independent helpers race to settle the SAME original record.
		// Exactly one distinct proof wins; the other cannot overwrite it.
		var wg sync.WaitGroup
		success := make(chan bool, 2)
		for _, item := range []struct {
			p     *stdioPeer
			proof map[string]any
		}{{p, hostProof("pending-1")}, {second, map[string]any{"operationId": "pending-1", "outcome": "rejected", "rawDigest": nil, "totalBytes": nil}}} {
			wg.Add(1)
			go func(peer *stdioPeer, proof map[string]any) {
				defer wg.Done()
				success <- peer.call(t, "editor.hostReceipt.settle", map[string]any{"operationId": "pending-1", "receipt": proof}).OK
			}(item.p, item.proof)
		}
		wg.Wait()
		close(success)
		wins := 0
		for ok := range success {
			if ok {
				wins++
			}
		}
		if wins != 1 {
			t.Fatal("cross-helper receipt lock did not preserve immutable terminal proof", wins)
		}
	})
	t.Run("native-host-private-fs-guard", func(t *testing.T) {
		root := t.TempDir()
		state := filepath.Join(root, "editor-native")
		store := filepath.Join(root, "editor-native-operations")
		p := startEditorPeer(t, binary, root, state, true, store)
		record := hostRecordFixture(t, p, root, "private-probe")
		p.must(t, "editor.hostReceipt.put", map[string]any{"value": record})
		paths := []string{filepath.Join(state, "engine.lock"), filepath.Join(store, "private-probe.json")}
		if runtime.GOOS != "windows" {
			alias := filepath.Join(root, "private-alias")
			if err := os.Symlink(store, alias); err != nil {
				t.Fatal(err)
			}
			paths = append(paths, filepath.Join(alias, "private-probe.json"))
		}
		for _, path := range paths {
			r := p.call(t, "fs.stat", map[string]any{"path": path, "editorIdentity": true, "editorRoot": root})
			if r.OK || !strings.Contains(r.Error, "private state") {
				t.Fatalf("stdio metadata leaked private state: %+v", r)
			}
		}
		if value := p.must(t, "editor.hostReceipt.get", map[string]any{"operationId": "private-probe"})["value"]; value == nil {
			t.Fatal("trusted H3 IO was blocked")
		}
		path := filepath.Join(root, "document")
		if err := os.WriteFile(path, []byte("before"), 0640); err != nil {
			t.Fatal(err)
		}
		req := prepareStdio(t, p, root, path, "normal-probe", []byte("before"), []byte("after"))
		if r := p.must(t, "editor.apply", req); r["outcome"] != "committed" {
			t.Fatal("normal stdio editor apply was blocked", r)
		}
		if q := p.must(t, "editor.query", map[string]any{"namespace": req["namespace"], "resourceKey": req["resourceKey"], "operationId": req["operationId"], "requestDigest": req["requestDigest"]}); q["outcome"] != "committed" {
			t.Fatal("normal query was blocked", q)
		}
	})
	t.Run("native-host-root-replaced", func(t *testing.T) {
		root := t.TempDir()
		store := filepath.Join(t.TempDir(), "store")
		p := startEditorPeer(t, binary, root, filepath.Join(t.TempDir(), "state"), false, store)
		record := hostRecordFixture(t, p, root, "original")
		p.must(t, "editor.hostReceipt.put", map[string]any{"value": record})
		if err := os.Rename(store, store+"-old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(store, 0700); err != nil {
			t.Fatal(err)
		}
		if r := p.call(t, "editor.hostReceipt.get", map[string]any{"operationId": "original"}); r.OK {
			t.Fatal("replacement Host root was trusted")
		}
		if r := p.call(t, "editor.hostReceipt.put", map[string]any{"value": record}); r.OK {
			t.Fatal("replacement Host root received writes")
		}
		files, err := os.ReadDir(store)
		if err != nil || len(files) != 0 {
			t.Fatal("replacement directory was mutated", err)
		}
	})
	t.Run("native-host-init-fails-before-capability", func(t *testing.T) {
		root := t.TempDir()
		store := filepath.Join(t.TempDir(), "unsafe")
		if runtime.GOOS != "windows" && os.Geteuid() != 0 {
			if err := os.Mkdir(store, 0500); err != nil {
				t.Fatal(err)
			}
			defer os.Chmod(store, 0700)
		} else {
			if err := os.WriteFile(store, []byte("not a directory"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "editor-stdio", "--root", root, "--state-dir", filepath.Join(t.TempDir(), "state"), "--host-receipts-dir", store)
		cmd.Stdin = strings.NewReader("{\"type\":\"rpc\",\"id\":\"probe\",\"method\":\"editor.capabilities\",\"params\":{}}\n")
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err == nil {
			t.Fatal("unwritable Host store advertised capability")
		}
		if stdout.Len() != 0 || stderr.Len() == 0 {
			t.Fatal("Host store failure did not stay pre-capability/pre-dispatch")
		}
	})
}
