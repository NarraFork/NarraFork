package handlers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func worktreeFixture(t *testing.T) (string, *Handlers, map[string]any) {
	t.Helper()
	root, h := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "seed.txt"), []byte("seed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", "seed.txt")
	gitTestRun(t, root, "commit", "-m", "seed")
	if err := h.ConfigureWorktreeStateDirectory(filepath.Join(t.TempDir(), "private-state")); err != nil {
		t.Fatal(err)
	}
	common := gitTestRun(t, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	return root, h, map[string]any{"cwd": root, "expectedRoot": root, "expectedRepository": common, "operation": "create", "requestId": "fixture-request-id", "requestDigest": strings.Repeat("a", 64), "actorKey": "actor", "branchKind": "new", "branchName": "feature", "destinationPath": filepath.Join(root, "linked")}
}
func worktreeCall(t *testing.T, h *Handlers, params map[string]any) map[string]any {
	t.Helper()
	value, err := h.GitWorktree(context.Background(), params)
	if err != nil {
		t.Fatal(err)
	}
	return value.(map[string]any)
}
func TestGitWorktreeCreateAndDurableReceipt(t *testing.T) {
	root, h, params := worktreeFixture(t)
	result := worktreeCall(t, h, params)["result"].(*worktreeResult)
	if result.Outcome != "created" || result.Worktree == nil || result.Worktree.Path != filepath.Join(root, "linked") {
		t.Fatalf("creation: %#v", result)
	}
	if got := gitTestRun(t, root, "branch", "--show-current"); got != "main" {
		t.Fatalf("source switched to %s", got)
	}
	// New handler and connection preserve disk receipts instead of blindly dispatching again.
	replacement := NewWithOptions(h.guard, h.maxRpcBytes, true)
	if err := replacement.ConfigureWorktreeStateDirectory(h.worktreeStateDir); err != nil {
		t.Fatal(err)
	}
	params["operation"] = "reconcile"
	again := worktreeCall(t, replacement.ConnectionScoped(), params)["result"].(*worktreeResult)
	if again.Outcome != "created" {
		t.Fatalf("reconcile %#v", again)
	}
	params["operation"] = "create"
	if replay := worktreeCall(t, replacement, params)["result"].(*worktreeResult); replay.Outcome != "created" {
		t.Fatal(replay)
	}
	params["branchName"] = "different"
	if _, err := replacement.GitWorktree(context.Background(), params); err == nil {
		t.Fatal("requestId mismatch accepted")
	}
}
func TestGitWorktreeListLinkedWorkspace(t *testing.T) {
	root, h, params := worktreeFixture(t)
	worktreeCall(t, h, params)
	linked := filepath.Join(root, "linked")
	params["operation"] = "list"
	params["cwd"] = linked
	params["expectedRoot"] = linked
	entries := worktreeCall(t, h, params)["entries"].([]worktreeEntry)
	if len(entries) != 2 {
		t.Fatalf("linked inventory %#v", entries)
	}
}
func TestGitWorktreeRejectsEscapeSymlinkAndDenyHole(t *testing.T) {
	root, h, params := worktreeFixture(t)
	params["destinationPath"] = filepath.Join(filepath.Dir(root), "outside")
	if _, err := h.GitWorktree(context.Background(), params); err == nil {
		t.Fatal("destination escape accepted")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "outside")); !os.IsNotExist(err) {
		t.Fatal("outside path was created")
	}
	parent := filepath.Join(root, "symlink-parent")
	if err := os.Symlink(t.TempDir(), parent); err == nil {
		params["destinationPath"] = filepath.Join(parent, "linked")
		if _, err := h.GitWorktree(context.Background(), params); err == nil {
			t.Fatal("symlink parent accepted")
		}
	}
	params["destinationPath"] = filepath.Join(root, "linked")
	denied := NewPathGuardWithRules([]PathRule{{Path: root, Action: RuleAllow}, {Path: filepath.Join(root, "secret"), Action: RuleDeny}})
	blocked := NewWithOptions(denied, h.maxRpcBytes, true)
	if err := blocked.ConfigureWorktreeStateDirectory(filepath.Join(t.TempDir(), "state")); err != nil {
		t.Fatal(err)
	}
	if _, err := blocked.GitWorktree(context.Background(), params); err == nil {
		t.Fatal("whole-root denied hole accepted")
	}
}
func TestGitWorktreeUnknownReceiptNeverRetriesAdd(t *testing.T) {
	root, h, params := worktreeFixture(t)
	params["operation"] = "status"
	result := worktreeCall(t, h, params)["result"].(*worktreeResult)
	if result.Outcome != "unknown" {
		t.Fatal(result)
	}
	if got := gitTestRun(t, root, "branch", "--list", "feature"); got != "" {
		t.Fatal("status created a branch")
	}
	if _, err := os.Stat(filepath.Join(root, "linked")); !os.IsNotExist(err) {
		t.Fatal("status created destination")
	}
}
func TestGitWorktreeRejectsConfiguredCheckoutHelpers(t *testing.T) {
	root, h, params := worktreeFixture(t)
	gitTestRun(t, root, "config", "filter.exfiltrate.smudge", "touch /tmp/should-never-run")
	if _, err := h.GitWorktree(context.Background(), params); err == nil {
		t.Fatal("disable-shell bypassed")
	}
	if _, err := os.Stat(filepath.Join(root, "linked")); !os.IsNotExist(err) {
		t.Fatal("unsafe checkout created destination")
	}
}
func TestGitWorktreePendingReceiptReconcilesFromLinkedRoot(t *testing.T) {
	root, h, params := worktreeFixture(t)
	worktreeCall(t, h, params)
	path, err := h.worktreeReceiptPath(params["requestId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := readWorktreeReceipt(path)
	if err != nil {
		t.Fatal(err)
	}
	receipt.Result = worktreeUnknown()
	receipt.CommandSucceeded = false
	if err := saveWorktreeReceipt(path, receipt, false); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, "linked")
	params["operation"] = "reconcile"
	params["cwd"] = linked
	params["expectedRoot"] = linked
	if err := os.WriteFile(filepath.Join(linked, "seed.txt"), []byte("interrupted content\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if result := worktreeCall(t, h, params)["result"].(*worktreeResult); result.Outcome != "unknown" {
		t.Fatal("dirty checkout certified", result)
	}
	gitTestRun(t, linked, "checkout", "--", "seed.txt")
	if result := worktreeCall(t, h, params)["result"].(*worktreeResult); result.Outcome != "created" {
		t.Fatal("clean checkout not recovered", result)
	}
	if len(strings.Split(gitTestRun(t, root, "worktree", "list", "--porcelain"), "worktree ")) != 3 {
		t.Fatal("recovery added another worktree")
	}
}
func TestGitWorktreeRepositoryReplacementDoesNotReuseOldReceipt(t *testing.T) {
	root, h, params := worktreeFixture(t)
	worktreeCall(t, h, params)
	if err := os.Rename(filepath.Join(root, ".git"), filepath.Join(root, ".old-git")); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "init", "-b", "main")
	params["operation"] = "reconcile"
	if result := worktreeCall(t, h, params)["result"].(*worktreeResult); result.Outcome != "unknown" {
		t.Fatal("old receipt trusted on replaced repository", result)
	}
	if got := gitTestRun(t, root, "branch", "--list", "feature"); got != "" {
		t.Fatal("recovery recreated branch")
	}
}
func TestGitWorktreeCommonRepositoryLockAndPrivateState(t *testing.T) {
	root, h, params := worktreeFixture(t)
	common := params["expectedRepository"].(string)
	gitWorkspaceWrites.Lock()
	gitWorkspaceWrites.active[common] = true
	gitWorkspaceWrites.Unlock()
	_, err := h.GitWorktree(context.Background(), params)
	gitWorkspaceWrites.Lock()
	delete(gitWorkspaceWrites.active, common)
	gitWorkspaceWrites.Unlock()
	if err == nil || !strings.Contains(err.Error(), "in progress") {
		t.Fatal("common repository lock bypassed", err)
	}
	if err := h.ConfigureWorktreeStateDirectory(filepath.Join(root, "private-state")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.GitWorktree(context.Background(), params); err == nil {
		t.Fatal("state inside user repository accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "linked")); !os.IsNotExist(err) {
		t.Fatal("refused creation touched destination")
	}
}
func TestGitWorktreeUnsupportedOperations(t *testing.T) {
	_, h, params := worktreeFixture(t)
	for _, op := range []string{"delete", "prune", "argv"} {
		params["operation"] = op
		if _, err := h.GitWorktree(context.Background(), params); err == nil {
			t.Fatal("unsupported operation accepted")
		}
	}
}
