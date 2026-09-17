package transport

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/rpc"
)

// Build and launch the actual CLI in its own process and temporary HOME. Only
// this test-owned process is stopped; no running NarraFork server is contacted.
func startGitBinaryExecutor(t *testing.T, serverURL, root string) context.CancelFunc {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "executor")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	buildCtx, stopBuild := context.WithTimeout(context.Background(), 60*time.Second)
	defer stopBuild()
	build := exec.CommandContext(buildCtx, "go", "build", "-o", binary, "./cmd/narrafork-executor")
	build.Dir = filepath.Join("..", "..")
	build.Stdout, build.Stderr = io.Discard, io.Discard
	if err := build.Run(); err != nil {
		t.Fatalf("build isolated executor CLI: %v", err)
	}
	ctx, stop := context.WithTimeout(context.Background(), 60*time.Second)
	cmd := exec.CommandContext(ctx, binary, "--server", strings.Replace(serverURL, "http", "ws", 1), "--device", "test-device", "--token-stdin", "--cwd", root, "--allow-root", root, "--disable-shell")
	cmd.Stdin = strings.NewReader("rdev_test\n")
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "NARRAFORK_EXECUTOR_") && !strings.HasPrefix(item, "HOME=") && !strings.HasPrefix(item, "XDG_CONFIG_HOME=") {
			cmd.Env = append(cmd.Env, item)
		}
	}
	home := t.TempDir()
	cmd.Env = append(cmd.Env, "HOME="+home, "XDG_CONFIG_HOME="+home)
	cmd.WaitDelay = 2 * time.Second
	if runtime.GOOS != "windows" {
		cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	}
	if err := cmd.Start(); err != nil {
		stop()
		t.Fatalf("start isolated executor: %v", err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	return func() { stop(); <-done }
}

// Exercises the real Go CLI -> websocket -> Dispatcher -> Git subprocess
// round trip with an isolated loopback server and disposable repository. No DB,
// production device, shell RPC, or local-backend substitution is involved.
func TestGitWorkspaceRemoteLifecycle(t *testing.T) {
	root := t.TempDir()
	cmd := exec.Command("git", "init", "-b", "main", root)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("init: %v %s", err, out)
	}
	srv, ts := newTestServer(t)
	defer srv.Close()
	cancel := startGitBinaryExecutor(t, srv.URL, root)
	defer cancel()
	defer close(ts.done)
	select {
	case <-ts.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("executor handshake timed out")
	}
	t.Logf("isolated executor version=%s platform=%s/%s shell=%v", ts.hello.AgentVersion, ts.hello.Platform.OS, ts.hello.Platform.Arch, ts.hello.Capabilities.Shell)
	if !ts.hello.Capabilities.Git || ts.hello.Capabilities.Shell {
		t.Fatal("CLI capabilities did not preserve Git with --disable-shell")
	}
	found := false
	for _, feature := range ts.hello.Capabilities.Features {
		if feature == rpc.FeatureGitWorkspaceV1 {
			found = true
		}
	}
	if !found {
		t.Fatal("executor did not advertise full Git capability")
	}
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	seq := 0
	call := func(operation string, extra map[string]any) map[string]any {
		t.Helper()
		seq++
		params := map[string]any{"cwd": root, "expectedRoot": root, "operation": operation}
		for key, value := range extra {
			params[key] = value
		}
		res, _, err := ts.call(ctx, fmt.Sprintf("git-%d", seq), "git.workspace", params)
		if err != nil || !res.OK {
			t.Fatalf("remote %s: err=%v result=%+v", operation, err, res)
		}
		return res.Result.(map[string]any)
	}
	identity := map[string]any{"GIT_AUTHOR_NAME": "Remote Acting User", "GIT_AUTHOR_EMAIL": "remote@example.test", "GIT_COMMITTER_NAME": "Remote Acting User", "GIT_COMMITTER_EMAIL": "remote@example.test"}
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if p := call("probe", nil); p["rootPath"] != root {
		t.Fatalf("remote root: %v", p)
	}
	call("status", nil)
	write("initial\n")
	call("stage", map[string]any{"all": true})
	call("unstage", map[string]any{"all": true})
	call("stage", map[string]any{"files": []any{"file.txt"}})
	sha := strings.TrimSpace(call("commit", map[string]any{"message": "first", "identity": identity})["stdout"].(string))
	write("initial\nupdated\n")
	if diff := call("diff", map[string]any{"files": []any{"file.txt"}})["stdout"].(string); !strings.Contains(diff, "+updated") {
		t.Fatalf("remote diff: %q", diff)
	}
	call("stage", map[string]any{"all": true})
	call("diff", map[string]any{"files": []any{"file.txt"}, "staged": true})
	call("unstage", map[string]any{"files": []any{"file.txt"}})
	call("stashPush", map[string]any{"identity": identity, "message": "saved remotely"})
	if list := call("stashList", nil)["stdout"].(string); !strings.Contains(list, "saved remotely") {
		t.Fatalf("remote stash: %q", list)
	}
	call("stashPop", nil)
	call("stashPush", map[string]any{"identity": identity})
	call("stashDrop", map[string]any{"index": 0})
	write("second\n")
	call("stage", map[string]any{"all": true})
	call("commit", map[string]any{"message": "second", "identity": identity})
	log := call("log", map[string]any{"limit": 1, "skip": 0})["stdout"].(string)
	if !strings.Contains(log, "Remote Acting User") || !strings.Contains(log, "second") {
		t.Fatalf("remote identity/history: %q", log)
	}
	call("reset", map[string]any{"mode": "soft", "target": sha})
	call("reset", map[string]any{"mode": "hard", "target": sha})
	write("discard me\n")
	call("discard", map[string]any{"files": []any{"file.txt"}})
	write("discard all\n")
	call("discard", map[string]any{"all": true})
	write(strings.Repeat("bounded remote patch\n", 20000))
	full := call("fullDiff", map[string]any{"maxBytes": 512})
	if full["truncated"] != true || len(full["stdout"].(string)) > 512 {
		t.Fatalf("remote diff output was not bounded")
	}
	for index := 0; index < 20; index++ {
		path := filepath.Join(root, fmt.Sprintf("status-%02d.txt", index))
		if err := os.WriteFile(path, []byte("change\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	boundedStatus := call("status", map[string]any{"maxBytes": 64})
	boundedOutputs := boundedStatus["outputs"].(map[string]any)
	statusPrefix, _ := boundedOutputs["status"].(string)
	if boundedStatus["truncated"] != true || statusPrefix == "" || !strings.HasSuffix(statusPrefix, "\x00") {
		t.Fatalf("remote status did not return a complete bounded prefix: %v", boundedStatus)
	}
	bare := filepath.Join(root, "bare.git")
	if out, err := exec.Command("git", "init", "--bare", bare).CombinedOutput(); err != nil {
		t.Fatalf("init bare: %v %s", err, out)
	}
	bareResult, _, err := ts.call(ctx, "bare-probe", "git.workspace", map[string]any{"cwd": bare, "operation": "probe"})
	if err != nil || !bareResult.OK {
		t.Fatalf("remote bare probe failed: %v %+v", err, bareResult)
	}
	bareProbe := bareResult.Result.(map[string]any)
	if bareProbe["state"] != "unsupported" || bareProbe["reason"] != "Bare repositories have no working tree" {
		t.Fatalf("remote bare probe was misclassified: %v", bareProbe)
	}
	res, _, err := ts.call(ctx, "bad-path", "git.workspace", map[string]any{"cwd": root, "expectedRoot": root, "operation": "stage", "files": []any{"../forbidden"}})
	if err != nil || res.OK {
		t.Fatalf("remote path refusal: %v %+v", err, res)
	}
	res, _, err = ts.call(ctx, "outside", "git.workspace", map[string]any{"cwd": filepath.Dir(root), "operation": "probe"})
	if err != nil || !res.OK || res.Result.(map[string]any)["state"] != "access_denied" {
		t.Fatalf("remote root refusal: %v %+v", err, res)
	}
}
