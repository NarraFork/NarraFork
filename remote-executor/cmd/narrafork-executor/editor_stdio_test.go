package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

type stdioPeer struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	out      *bufio.Scanner
	stderr   bytes.Buffer
	cancel   context.CancelFunc
	seq      int
	waitOnce sync.Once
	waitErr  error
}

func (p *stdioPeer) finish() error {
	p.waitOnce.Do(func() { p.in.Close(); p.waitErr = p.cmd.Wait(); p.cancel() })
	return p.waitErr
}

func startEditorPeer(t *testing.T, binary, root, state string, epoch bool, hostReceipts ...string) *stdioPeer {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	args := []string{"editor-stdio", "--root", root, "--state-dir", state}
	if len(hostReceipts) > 0 {
		args = append(args, "--host-receipts-dir", hostReceipts[0])
	}
	if epoch {
		args = append(args, "--epoch", "host-fixture-epoch")
	}
	cmd := exec.CommandContext(ctx, binary, args...)
	empty := t.TempDir()
	cmd.Env = []string{"HOME=" + empty, "USERPROFILE=" + empty, "XDG_CONFIG_HOME=" + empty, "NARRAFORK_SERVER_URL=invalid://must-not-connect", "NARRAFORK_TOKEN_STDIN=true"}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	peer := &stdioPeer{cmd: cmd, in: in, out: bufio.NewScanner(out), cancel: cancel}
	cmd.Stderr = &peer.stderr
	peer.out.Buffer(make([]byte, 4096), 64*1024)
	if err = cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := peer.finish(); err != nil {
			t.Errorf("stdio child exit: %v stderr=%s", err, peer.stderr.String())
		}
	})
	return peer
}
func (p *stdioPeer) call(t *testing.T, method string, params map[string]any) rpc.ResultFrame {
	t.Helper()
	p.seq++
	req := rpc.RequestFrame{Type: "rpc", ID: fmt.Sprint(p.seq), Method: method, Params: params}
	if err := json.NewEncoder(p.in).Encode(req); err != nil {
		t.Fatal("stdio input", err)
	}
	if !p.out.Scan() {
		t.Fatal("stdio stdout closed", p.out.Err())
	}
	var result rpc.ResultFrame
	if err := json.Unmarshal(p.out.Bytes(), &result); err != nil {
		t.Fatal("non-RPC stdout", err, string(p.out.Bytes()))
	}
	if result.ID != req.ID || result.Type != "rpc_result" {
		t.Fatalf("bad stdio frame %+v", result)
	}
	return result
}
func (p *stdioPeer) must(t *testing.T, method string, params map[string]any) map[string]any {
	t.Helper()
	r := p.call(t, method, params)
	if !r.OK {
		t.Fatal(method, r.Error)
	}
	return r.Result.(map[string]any)
}
func stdioDigest(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }
func prepareStdio(t *testing.T, p *stdioPeer, root, path, operation string, before, body []byte) map[string]any {
	t.Helper()
	caps := p.must(t, "editor.capabilities", map[string]any{})
	if caps["maxChunkBytes"] != float64(65536) || caps["maxBytes"] != float64(20971520) || caps["protocolVersion"] != float64(1) {
		t.Fatalf("bad capabilities %+v", caps)
	}
	stat := p.must(t, "fs.stat", map[string]any{"path": path, "editorIdentity": true, "editorRoot": root})
	if stat["runtimeEpoch"] != caps["runtimeEpoch"] {
		t.Fatal("probe epoch mismatch")
	}
	s := p.must(t, "editor.stage.open", map[string]any{"namespace": "stdio-owner", "resourceKey": "stdio-resource", "maxBytes": len(body), "idleTimeoutMs": 30000})
	for offset, seq := 0, 0; offset < len(body); seq++ {
		end := min(offset+65536, len(body))
		b := body[offset:end]
		p.must(t, "editor.stage.append", map[string]any{"namespace": "stdio-owner", "resourceKey": "stdio-resource", "stageId": s["stageId"], "seq": seq, "offset": offset, "bytes": len(b), "digest": stdioDigest(b), "dataB64": base64.StdEncoding.EncodeToString(b)})
		offset = end
	}
	p.must(t, "editor.stage.seal", map[string]any{"namespace": "stdio-owner", "resourceKey": "stdio-resource", "stageId": s["stageId"], "totalBytes": len(body), "rawDigest": stdioDigest(body)})
	var expected any
	if before != nil {
		expected = stdioDigest(before)
	}
	return map[string]any{"namespace": "stdio-owner", "resourceKey": "stdio-resource", "operationId": operation, "requestDigest": stdioDigest([]byte(operation)), "stageId": s["stageId"], "expectedRawHash": expected, "metadataPolicy": "preserve", "identity": map[string]any{"deviceId": "local", "pathFlavor": handlers.EditorPathFlavor(), "canonicalPath": stat["resolvedPath"], "workspaceIdentity": stat["rootIdentity"], "runtimeEpoch": stat["runtimeEpoch"], "runtimeGeneration": 1, "fencingToken": 1}}
}
func TestEditorStdioCompiledBinary(t *testing.T) {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	binary := filepath.Join(t.TempDir(), "executor"+ext)
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("compile real helper: %v %s", err, output)
	}
	testEditorHostReceiptBinary(t, binary)
	for _, size := range []int{0, 3 * 1024 * 1024, 20 * 1024 * 1024} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			root := t.TempDir()
			state := filepath.Join(t.TempDir(), "private-state")
			path := filepath.Join(root, "document")
			before := []byte("before")
			if err := os.WriteFile(path, before, 0640); err != nil {
				t.Fatal(err)
			}
			p := startEditorPeer(t, binary, root, state, true)
			body := bytes.Repeat([]byte("a"), size)
			req := prepareStdio(t, p, root, path, "operation", before, body)
			if result := p.must(t, "editor.apply", req); result["outcome"] != "committed" {
				t.Fatalf("%+v", result)
			}
			query := map[string]any{"namespace": req["namespace"], "resourceKey": req["resourceKey"], "operationId": req["operationId"], "requestDigest": req["requestDigest"]}
			// Another independently started helper recovers the same durable receipt.
			second := startEditorPeer(t, binary, root, state, false)
			if q := second.must(t, "editor.query", query); q["outcome"] != "committed" {
				t.Fatal("fresh process lost receipt", q)
			}
			query["acknowledgeTerminal"] = true
			if q := second.must(t, "editor.query", query); q["outcome"] != "committed" {
				t.Fatal("stdio terminal acknowledgment rejected", q)
			}
			delete(query, "acknowledgeTerminal")
			if err := os.RemoveAll(root); err != nil {
				t.Fatal(err)
			}
			third := startEditorPeer(t, binary, root, state, false)
			if q := third.must(t, "editor.query", query); q["outcome"] != "committed" {
				t.Fatal("deleted scope lost historical receipt", q)
			}
		})
	}
	t.Run("concurrent-short-processes", func(t *testing.T) {
		root := t.TempDir()
		state := filepath.Join(t.TempDir(), "private-state")
		path := filepath.Join(root, "document")
		if err := os.WriteFile(path, []byte("base"), 0600); err != nil {
			t.Fatal(err)
		}
		a := startEditorPeer(t, binary, root, state, true)
		b := startEditorPeer(t, binary, root, state, true)
		ra := prepareStdio(t, a, root, path, "a", []byte("base"), []byte("one"))
		rb := prepareStdio(t, b, root, path, "b", []byte("base"), []byte("two"))
		var wg sync.WaitGroup
		outcomes := make(chan string, 2)
		for _, item := range []struct {
			p *stdioPeer
			r map[string]any
		}{{a, ra}, {b, rb}} {
			wg.Add(1)
			go func(p *stdioPeer, r map[string]any) {
				defer wg.Done()
				outcomes <- p.must(t, "editor.apply", r)["outcome"].(string)
			}(item.p, item.r)
		}
		wg.Wait()
		close(outcomes)
		success := 0
		for outcome := range outcomes {
			if outcome == "committed" {
				success++
			}
		}
		if success != 1 {
			t.Fatal("cross-process lock did not serialize source baseline", success)
		}
	})
	t.Run("limited-surfaces", func(t *testing.T) {
		root := t.TempDir()
		state := filepath.Join(t.TempDir(), "private-state")
		p := startEditorPeer(t, binary, root, state, false)
		caps := p.must(t, "editor.capabilities", map[string]any{})
		if caps["runtimeEpoch"] == "" {
			t.Fatal("missing session epoch")
		}
		if r := p.call(t, "exec.start", map[string]any{"command": "unreachable"}); r.OK {
			t.Fatal("stdio exposed shell")
		}
		outside := filepath.Join(t.TempDir(), "secret")
		if err := os.WriteFile(outside, []byte("secret"), 0600); err != nil {
			t.Fatal(err)
		}
		if r := p.call(t, "fs.stat", map[string]any{"path": outside}); r.OK {
			t.Fatal("stdio path guard widened")
		}
		p2 := startEditorPeer(t, binary, root, state, false)
		if other := p2.must(t, "editor.capabilities", map[string]any{}); other["runtimeEpoch"] == caps["runtimeEpoch"] {
			t.Fatal("new helper reused process epoch")
		}
	})
	t.Run("idle-exit", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "editor-stdio", "--root", t.TempDir(), "--state-dir", filepath.Join(t.TempDir(), "state"))
		in, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		defer in.Close()
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		started := time.Now()
		err = cmd.Run()
		if err == nil || ctx.Err() != nil || time.Since(started) > 14*time.Second || stdout.Len() != 0 || !bytes.Contains(stderr.Bytes(), []byte("idle timeout")) {
			t.Fatalf("idle bound/stdio isolation: %v %s", err, stderr.String())
		}
	})
	t.Run("stdout-backpressure-exit", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "editor-stdio", "--root", t.TempDir(), "--state-dir", filepath.Join(t.TempDir(), "state"))
		line := []byte("{\"type\":\"rpc\",\"id\":\"caps\",\"method\":\"editor.capabilities\",\"params\":{}}\n")
		cmd.Stdin = bytes.NewReader(bytes.Repeat(line, 2048))
		out, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		defer out.Close()
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		err = cmd.Run()
		if err == nil || ctx.Err() != nil || !bytes.Contains(stderr.Bytes(), []byte("timeout")) {
			t.Fatalf("blocked stdout was not deadline bounded: %v %s", err, stderr.String())
		}
	})
	t.Run("bounded-invalid-input", func(t *testing.T) {
		root := t.TempDir()
		state := filepath.Join(t.TempDir(), "state")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "editor-stdio", "--root", root, "--state-dir", state)
		cmd.Env = []string{"HOME=" + t.TempDir()}
		cmd.Stdin = bytes.NewReader(bytes.Repeat([]byte("x"), 128*1024+1))
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err == nil {
			t.Fatal("oversized frame accepted")
		}
		if stdout.Len() != 0 || stderr.Len() == 0 || stderr.Len() > 4096 {
			t.Fatal("invalid stdout/stderr isolation")
		}
	})
}
