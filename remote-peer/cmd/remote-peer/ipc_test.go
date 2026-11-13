package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestProductionIPCEnvelopeExplicitPairAndSameFileRestart(t *testing.T) {
	dir, err := os.MkdirTemp(".", ".ipc-test-")
	if err != nil {
		t.Fatal(err)
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	name := "peer"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(dir, name)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-buildvcs=false", "-o", binary, ".")
	var output boundedOutput
	build.Stdout = &output
	build.Stderr = &output
	if err := build.Run(); err != nil {
		t.Fatalf("build: %v %s", err, output.String())
	}
	cfg := map[string]any{"mode": "narrafork", "signalUrl": "ws://127.0.0.1:1/signal/instance", "bridgeUrl": "http://127.0.0.1:2", "bridgeSecret": strings.Repeat("b", 32), "allowLocalhost": true, "statePath": filepath.Join(dir, "private", "state.json"), "stunUrls": []string{}, "backendIdentity": map[string]any{"nfVersion": "1.2.3", "sourceCommit": strings.Repeat("a", 40), "repository": "owner/repo", "bootstrapAbi": 1, "apiEpoch": 1, "wireVersion": 2, "capabilities": []string{"projects"}}, "requestPolicy": []any{map[string]any{"id": "login", "methods": []string{"POST"}, "path": "^/api/auth/login$", "phase": "paired", "profile": "request", "requestBytes": 1048576, "responseBytes": 1048576}}}
	identity := ""
	for run := 0; run < 2; run++ {
		childCtx, stop := context.WithTimeout(ctx, 10*time.Second)
		cmd := exec.CommandContext(childCtx, binary)
		cmd.Dir = dir
		in, err := cmd.StdinPipe()
		if err != nil {
			stop()
			t.Fatal(err)
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			stop()
			t.Fatal(err)
		}
		var stderr boundedOutput
		cmd.Stderr = &stderr
		if err = cmd.Start(); err != nil {
			stop()
			t.Fatal(err)
		}
		lines := make(chan map[string]any, 64)
		go func() {
			defer close(lines)
			scan := bufio.NewScanner(out)
			scan.Buffer(make([]byte, 8192), 65537)
			for scan.Scan() {
				var v map[string]any
				if json.Unmarshal(scan.Bytes(), &v) == nil {
					select {
					case lines <- v:
					case <-childCtx.Done():
						return
					}
				}
			}
		}()
		send := func(id, typ string, payload any) {
			t.Helper()
			err := json.NewEncoder(in).Encode(map[string]any{"ipcVersion": 2, "epoch": "epoch", "requestId": id, "type": typ, "payload": payload})
			if err != nil {
				stop()
				t.Fatal(err)
			}
		}
		receive := func(id, typ string) map[string]any {
			t.Helper()
			for {
				select {
				case v, ok := <-lines:
					if !ok {
						stop()
						t.Fatalf("stdout ended: %s", stderr.String())
					}
					if v["ipcVersion"] != float64(2) || v["epoch"] != "epoch" {
						stop()
						t.Fatal("bad envelope", v)
					}
					if v["requestId"] != id {
						if v["type"] == "status" {
							continue
						}
						stop()
						t.Fatal("wrong request ID", v)
					}
					if v["type"] != typ {
						stop()
						t.Fatal("wrong result type", v)
					}
					return v["payload"].(map[string]any)
				case <-childCtx.Done():
					stop()
					t.Fatal("IPC timeout")
				}
			}
		}
		send("init", "init", map[string]any{"config": cfg})
		ready := receive("init", "ready")
		if len(ready) != 2 || ready["pairingSecret"] != nil {
			stop()
			t.Fatal("ready leaked invitation", ready)
		}
		if identity == "" {
			identity = ready["publicKey"].(string)
		} else if ready["publicKey"] != identity {
			stop()
			t.Fatal("restart replaced identity")
		}
		send("grants", "grants.list", map[string]any{})
		receive("grants", "command.result")
		send("create", "pair.create", map[string]any{})
		result := receive("create", "command.result")
		invitation := result["result"].(map[string]any)["invitation"].(map[string]any)
		if invitation["pairingSecret"] == nil || invitation["signalUrl"] != "ws://127.0.0.1:1/signal/browser" {
			stop()
			t.Fatal("bad explicit invitation", invitation)
		}
		send("cancel", "pair.cancel", map[string]any{"inviteId": invitation["pairId"]})
		receive("cancel", "command.result")
		send("stop", "shutdown", map[string]any{})
		receive("stop", "command.result")
		_ = in.Close()
		err = cmd.Wait()
		stop()
		if err != nil {
			t.Fatal("IPC shutdown", err)
		}
	}
}
