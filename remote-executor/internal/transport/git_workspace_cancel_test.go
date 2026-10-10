//go:build !windows

package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/testgit"
)

func prepareSlowGitCommit(t *testing.T) (string, string, map[string]any) {
	t.Helper()
	root := canonicalGitRoot(t)
	transportFixtureGit(t, "init", "-b", "main", root)
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("initial\n"), 0600); err != nil {
		t.Fatal(err)
	}
	transportFixtureGit(t, "-C", root, "add", "file.txt")
	pidPath := filepath.Join(root, "hook.pid")
	hook := fmt.Sprintf("#!/bin/sh\nprintf '%%s' $$ > %s\nsleep 60\n", shellQuote(pidPath))
	if err := os.WriteFile(filepath.Join(root, ".git", "hooks", "pre-commit"), []byte(hook), 0700); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{
		"cwd": root, "expectedRoot": root, "operation": "commit", "message": "must not finish", "timeoutMs": 5000,
		"identity": map[string]any{"GIT_AUTHOR_NAME": "Actor", "GIT_AUTHOR_EMAIL": "actor@example.test", "GIT_COMMITTER_NAME": "Actor", "GIT_COMMITTER_EMAIL": "actor@example.test"},
	}
	return root, pidPath, params
}

func assertGitUnborn(t *testing.T, root string) {
	t.Helper()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := testgit.CommandContext(ctx, "-C", root, "rev-parse", "--verify", "--quiet", "HEAD").Run(); err == nil {
		t.Fatal("cancelled remote write created a commit")
	}
}

func TestGitWorkspaceRemoteCancelAndTimeout(t *testing.T) {
	for _, mode := range []string{"cancel", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			root, pidPath, params := prepareSlowGitCommit(t)
			srv, ts := newTestServer(t)
			defer srv.Close()
			cancel := startExecutor(t, srv.URL, root)
			defer cancel()
			defer close(ts.done)
			select {
			case <-ts.ready:
			case <-time.After(5 * time.Second):
				t.Fatal("handshake timed out")
			}
			ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if mode == "timeout" {
				params["timeoutMs"] = 750
			}
			if err := writeJSON(ctx, ts.conn, rpc.RequestFrame{Type: "rpc", ID: "slow-git", Method: "git.workspace", Params: params}); err != nil {
				t.Fatal(err)
			}
			pid := awaitPID(t, pidPath, 3*time.Second)
			if mode == "cancel" {
				if err := writeJSON(ctx, ts.conn, rpc.CancelFrame{Type: "rpc_cancel", ID: "slow-git"}); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "cancel" {
				// Cancelled RPC contexts deliberately suppress terminal frames. The
				// caller already rejected; verify process death and transport health.
				awaitProcessExit(t, pid, 3*time.Second)
				res, _, err := ts.call(ctx, "after-cancel", "system.ping", map[string]any{})
				if err != nil || !res.OK {
					t.Fatalf("post-cancel ping: %v %+v", err, res)
				}
				assertGitUnborn(t, root)
				return
			}
			for {
				_, data, err := ts.conn.Read(ctx)
				if err != nil {
					t.Fatal(err)
				}
				var result rpc.ResultFrame
				if err := json.Unmarshal(data, &result); err != nil {
					t.Fatal(err)
				}
				if result.ID == "slow-git" {
					if result.OK {
						t.Fatal("slow write unexpectedly succeeded")
					}
					break
				}
			}
			awaitProcessExit(t, pid, 3*time.Second)
			assertGitUnborn(t, root)
		})
	}
}

func TestGitWorkspaceRemoteDisconnectDoesNotReplayWrite(t *testing.T) {
	root, pidPath, params := prepareSlowGitCommit(t)
	server, harness := newReconnectServer(t)
	defer server.Close()
	cancel := startExecutor(t, server.URL, root)
	defer cancel()
	first := harness.nextConnection(t, 5*time.Second)
	if err := writeJSON(context.Background(), first, rpc.RequestFrame{Type: "rpc", ID: "disconnected-git", Method: "git.workspace", Params: params}); err != nil {
		t.Fatal(err)
	}
	pid := awaitPID(t, pidPath, 3*time.Second)
	first.CloseNow()
	harness.release <- struct{}{}
	awaitProcessExit(t, pid, 3*time.Second)
	second := harness.nextConnection(t, 5*time.Second)
	defer func() { harness.release <- struct{}{} }()
	if err := writeJSON(context.Background(), second, rpc.RequestFrame{Type: "rpc", ID: "ping-after-git", Method: "system.ping", Params: map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	awaitCleanResult(t, second, "ping-after-git", "disconnected-git", 3*time.Second)
	assertGitUnborn(t, root)
}
