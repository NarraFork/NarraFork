package handlers

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func gitTestRun(t *testing.T, cwd string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	cmd.Env = gitWorkspaceEnv(map[string]any{"GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.test", "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.test"})
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture git %v: %s (%v)", args, out, err)
	}
	return strings.TrimSpace(string(out))
}

func gitTestIdentity() map[string]any {
	return map[string]any{"GIT_AUTHOR_NAME": "Acting User", "GIT_AUTHOR_EMAIL": "acting@example.test", "GIT_COMMITTER_NAME": "Acting User", "GIT_COMMITTER_EMAIL": "acting@example.test"}
}

func newGitFixture(t *testing.T) (string, *Handlers) {
	t.Helper()
	root := t.TempDir()
	gitTestRun(t, root, "init", "-b", "main")
	return root, NewWithOptions(NewPathGuard([]string{root}), gitWorkspaceMaxBytes, true)
}

func gitCall(t *testing.T, h *Handlers, root, operation string, extra map[string]any) map[string]any {
	t.Helper()
	params := map[string]any{"cwd": root, "expectedRoot": root, "operation": operation}
	for key, value := range extra {
		params[key] = value
	}
	result, err := h.GitWorkspace(context.Background(), params)
	if err != nil {
		t.Fatalf("%s: %v", operation, err)
	}
	return result.(map[string]any)
}

func TestGitWorkspaceLifecycle(t *testing.T) {
	root, h := newGitFixture(t)
	write := func(path, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	probe := gitCall(t, h, root, "probe", nil)
	if probe["state"] != "ready" || probe["rootPath"] != root {
		t.Fatalf("probe: %v", probe)
	}
	gitCall(t, h, root, "status", nil)
	write("hello\tthere.txt", "initial\n")
	gitCall(t, h, root, "stage", map[string]any{"all": true})
	gitCall(t, h, root, "unstage", map[string]any{"all": true})
	if gitTestRun(t, root, "ls-files") != "" {
		t.Fatal("unborn unstage left index entries")
	}
	gitCall(t, h, root, "stage", map[string]any{"files": []any{"hello\tthere.txt"}})
	commit := gitCall(t, h, root, "commit", map[string]any{"message": "initial", "identity": gitTestIdentity()})
	first := strings.TrimSpace(commit["stdout"].(string))
	if len(first) != 40 {
		t.Fatalf("commit sha: %v", commit)
	}
	if got := gitTestRun(t, root, "show", "-s", "--format=%an <%ae> %cn <%ce>"); got != "Acting User <acting@example.test> Acting User <acting@example.test>" {
		t.Fatalf("identity: %s", got)
	}
	write("hello\tthere.txt", "initial\nsecond\n")
	if diff := gitCall(t, h, root, "diff", map[string]any{"files": []any{"hello\tthere.txt"}})["stdout"].(string); !strings.Contains(diff, "+second") {
		t.Fatalf("diff %q", diff)
	}
	gitCall(t, h, root, "stage", map[string]any{"all": true})
	if diff := gitCall(t, h, root, "diff", map[string]any{"files": []any{"hello\tthere.txt"}, "staged": true})["stdout"].(string); !strings.Contains(diff, "+second") {
		t.Fatalf("staged diff %q", diff)
	}
	gitCall(t, h, root, "unstage", map[string]any{"files": []any{"hello\tthere.txt"}})
	gitCall(t, h, root, "stashPush", map[string]any{"message": "shelved", "identity": gitTestIdentity()})
	if !strings.Contains(gitCall(t, h, root, "stashList", nil)["stdout"].(string), "shelved") {
		t.Fatal("stash missing")
	}
	gitCall(t, h, root, "stashPop", nil)
	gitCall(t, h, root, "stashPush", map[string]any{"identity": gitTestIdentity()})
	gitCall(t, h, root, "stashDrop", map[string]any{"index": 0})
	write("hello\tthere.txt", "changed\n")
	write("new.txt", "new\n")
	if full := gitCall(t, h, root, "fullDiff", nil)["stdout"].(string); !strings.Contains(full, "+new") {
		t.Fatalf("full diff omitted untracked: %q", full)
	}
	gitCall(t, h, root, "discard", map[string]any{"files": []any{"new.txt"}})
	if _, err := os.Stat(filepath.Join(root, "new.txt")); !os.IsNotExist(err) {
		t.Fatal("untracked discard failed")
	}
	gitCall(t, h, root, "discard", map[string]any{"all": true})
	if got := gitTestRun(t, root, "status", "--porcelain"); got != "" {
		t.Fatalf("discard: %s", got)
	}
	write("hello\tthere.txt", "third\n")
	gitCall(t, h, root, "stage", map[string]any{"all": true})
	gitCall(t, h, root, "commit", map[string]any{"message": "second", "identity": gitTestIdentity()})
	log := gitCall(t, h, root, "log", map[string]any{"limit": 1, "skip": 1})["stdout"].(string)
	if !strings.HasPrefix(log, first) {
		t.Fatalf("history pagination: %q", log)
	}
	gitCall(t, h, root, "reset", map[string]any{"mode": "soft", "target": first})
	gitCall(t, h, root, "reset", map[string]any{"mode": "hard", "target": first})
	if got := gitTestRun(t, root, "status", "--porcelain"); got != "" {
		t.Fatalf("reset: %s", got)
	}
}

func TestGitWorkspaceProbeAndSecurity(t *testing.T) {
	root, h := newGitFixture(t)
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0700); err != nil {
		t.Fatal(err)
	}
	if got := gitCall(t, h, sub, "probe", nil)["rootPath"]; got != root {
		t.Fatalf("subdirectory root: %v", got)
	}
	restricted := New(NewPathGuard([]string{sub}), gitWorkspaceMaxBytes)
	if state := gitCall(t, restricted, sub, "probe", nil)["state"]; state != "access_denied" {
		t.Fatalf("root scope expanded: %v", state)
	}
	denied := New(NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: root}, {Action: RuleDeny, Path: sub}}), gitWorkspaceMaxBytes)
	if state := gitCall(t, denied, root, "probe", nil)["state"]; state != "access_denied" {
		t.Fatalf("deny hole ignored: %v", state)
	}
	if runtime.GOOS != "windows" {
		outsideFile := filepath.Join(t.TempDir(), "outside-file")
		if err := os.WriteFile(outsideFile, []byte("link target\n"), 0600); err != nil {
			t.Fatal(err)
		}
		finalLink := filepath.Join(root, "final-link")
		if err := os.Symlink(outsideFile, finalLink); err != nil {
			t.Fatal(err)
		}
		gitCall(t, h, root, "stage", map[string]any{"files": []any{"final-link"}})
		staged := gitTestRun(t, root, "ls-files", "--stage", "--", "final-link")
		if !strings.HasPrefix(staged, "120000 ") {
			t.Fatalf("final symlink was not staged as link entry: %q", staged)
		}
		outsideDir := filepath.Join(t.TempDir(), "outside-dir")
		if err := os.Mkdir(outsideDir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsideDir, filepath.Join(root, "final-dir-link")); err != nil {
			t.Fatal(err)
		}
		gitCall(t, h, root, "stage", map[string]any{"files": []any{"final-dir-link"}})
		stagedDirLink := gitTestRun(t, root, "ls-files", "--stage", "--", "final-dir-link")
		if !strings.HasPrefix(stagedDirLink, "120000 ") {
			t.Fatalf("directory symlink was treated as directory: %q", stagedDirLink)
		}
		middleTarget := filepath.Join(root, "middle-target")
		if err := os.Mkdir(middleTarget, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(middleTarget, "file"), []byte("inside\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(middleTarget, filepath.Join(root, "middle")); err != nil {
			t.Fatal(err)
		}
		if _, err := h.GitWorkspace(context.Background(), map[string]any{"operation": "stage", "cwd": root, "expectedRoot": root, "files": []any{"middle/file"}}); err == nil || !strings.Contains(err.Error(), "traverse symbolic links") {
			t.Fatalf("intermediate symlink accepted: %v", err)
		}
	}
	for _, path := range []string{"../outside", "/etc/passwd", "C:/private", "\\\\server\\share", ":(glob)**", "sub/../file", ".git/config", "a\x00b"} {
		_, err := h.GitWorkspace(context.Background(), map[string]any{"operation": "stage", "cwd": root, "expectedRoot": root, "files": []any{path}})
		if err == nil {
			t.Errorf("unsafe path accepted: %q", path)
		}
	}
	for _, operation := range []string{"commit", "stashPush"} {
		_, err := h.GitWorkspace(context.Background(), map[string]any{"operation": operation, "cwd": root, "expectedRoot": root, "message": "test"})
		if err == nil || !strings.Contains(err.Error(), "identity") {
			t.Errorf("identity missing: %v", err)
		}
	}
	_, err := h.GitWorkspace(context.Background(), map[string]any{"operation": "stage", "cwd": root, "expectedRoot": sub, "all": true})
	if err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("stale root accepted: %v", err)
	}
	if runtime.GOOS != "windows" {
		outside := t.TempDir()
		if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
			t.Fatal(err)
		}
		_, err = h.GitWorkspace(context.Background(), map[string]any{"operation": "diff", "cwd": root, "expectedRoot": root, "files": []any{"escape/secret"}})
		if err == nil {
			t.Fatal("symlink escape accepted")
		}
	}
}

func TestGitWorkspaceBoundedDiffAndCancellation(t *testing.T) {
	root, h := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "large"), []byte(strings.Repeat("line\n", 20000)), 0600); err != nil {
		t.Fatal(err)
	}
	res := gitCall(t, h, root, "diff", map[string]any{"files": []any{"large"}, "maxBytes": 1024})
	if res["truncated"] != true || len(res["stdout"].(string)) > 1024 {
		t.Fatalf("not bounded: %v", res)
	}
	for index := 0; index < 20; index++ {
		name := fmt.Sprintf("status-%02d.txt", index)
		if err := os.WriteFile(filepath.Join(root, name), []byte("change\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	status := gitCall(t, h, root, "status", map[string]any{"maxBytes": 64})
	if status["truncated"] != true {
		t.Fatalf("bounded status did not report truncation: %v", status)
	}
	outputs := status["outputs"].(map[string]string)
	if outputs["status"] == "" {
		t.Fatalf("status list did not receive the output budget first: %v", outputs)
	}
	for _, key := range []string{"status", "stagedNumstat", "unstagedNumstat", "untrackedNumstat"} {
		if output := outputs[key]; output != "" && !strings.HasSuffix(output, "\x00") {
			t.Fatalf("%s ended with a partial NUL record: %q", key, output)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := h.GitWorkspace(ctx, map[string]any{"operation": "status", "cwd": root, "expectedRoot": root})
	if err == nil {
		t.Fatal("cancelled operation succeeded")
	}
}

func TestGitWorkspaceDisableShellDoesNotBypassHooksOrFilters(t *testing.T) {
	root, h := newGitFixture(t)
	hook := filepath.Join(root, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"cwd": root, "expectedRoot": root, "operation": "stage", "all": true}
	if _, err := h.GitWorkspace(context.Background(), params); err == nil || !strings.Contains(err.Error(), "hook requires shell") {
		t.Fatalf("hook bypassed disable-shell: %v", err)
	}
	if err := os.Remove(hook); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "config", "filter.test.clean", "arbitrary-command")
	if _, err := h.GitWorkspace(context.Background(), params); err == nil || !strings.Contains(err.Error(), "configured filters") {
		t.Fatalf("filter bypassed disable-shell: %v", err)
	}
}

func TestGitWorkspaceDisableShellReadFilters(t *testing.T) {
	for _, operation := range []string{"status", "diff", "fullDiff"} {
		t.Run(operation, func(t *testing.T) {
			root, h := newGitFixture(t)
			tracked := filepath.Join(root, "tracked")
			if err := os.WriteFile(tracked, []byte("initial\n"), 0600); err != nil {
				t.Fatal(err)
			}
			gitTestRun(t, root, "add", "tracked")
			gitTestRun(t, root, "commit", "-m", "initial")
			marker := filepath.Join(root, "filter-ran")
			t.Setenv("NF_GIT_HELPER_MARKER", marker)
			gitTestRun(t, root, "config", "filter.payload.clean", `printf invoked > "$NF_GIT_HELPER_MARKER"; cat`)
			if err := os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("tracked filter=payload\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(tracked, []byte("modified content\n"), 0600); err != nil {
				t.Fatal(err)
			}
			params := map[string]any{"cwd": root, "expectedRoot": root, "operation": operation}
			if operation == "diff" {
				params["files"] = []any{"tracked"}
			}
			if _, err := h.GitWorkspace(context.Background(), params); err == nil || !strings.Contains(err.Error(), "configured filters") {
				t.Fatalf("read filter not refused: %v", err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("disable-shell read invoked clean filter")
			}
			// The same fixture actually runs its clean filter when shell is allowed:
			// --no-ext-diff/--no-textconv alone do not prevent this execution.
			permitted := New(NewPathGuard([]string{root}), gitWorkspaceMaxBytes)
			if _, err := permitted.GitWorkspace(context.Background(), params); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(marker); err != nil {
				t.Fatalf("fixture did not exercise a real clean filter: %v", err)
			}
			if err := os.Remove(marker); err != nil {
				t.Fatal(err)
			}
			gitTestRun(t, root, "config", "--unset", "filter.payload.clean")
			gitTestRun(t, root, "config", "filter.payload.process", `printf invoked > "$NF_GIT_HELPER_MARKER"; cat`)
			if _, err := h.GitWorkspace(context.Background(), params); err == nil || !strings.Contains(err.Error(), "configured filters") {
				t.Fatalf("process filter not refused: %v", err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("disable-shell read invoked process filter")
			}
		})
	}
}

func TestGitWorkspaceDisableShellLinkedWorktreeHooks(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "init", "-b", "main")
	gitTestRun(t, root, "commit", "--allow-empty", "-m", "initial")
	worktree := filepath.Join(parent, "linked")
	gitTestRun(t, root, "worktree", "add", "--detach", worktree)
	if err := os.WriteFile(filepath.Join(worktree, "tracked"), []byte("new\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, worktree, "add", "tracked")
	marker := filepath.Join(parent, "hook-ran")
	t.Setenv("NF_GIT_HELPER_MARKER", marker)
	hook := filepath.Join(root, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nprintf invoked > \"$NF_GIT_HELPER_MARKER\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	h := NewWithOptions(NewPathGuard([]string{parent}), gitWorkspaceMaxBytes, true)
	for _, op := range []string{"stage", "commit"} {
		params := map[string]any{"cwd": worktree, "expectedRoot": worktree, "operation": op, "all": true, "message": "blocked", "identity": gitTestIdentity()}
		if _, err := h.GitWorkspace(context.Background(), params); err == nil || !strings.Contains(err.Error(), "pre-commit hook") {
			t.Fatalf("linked worktree common hook not refused: %v", err)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("common-dir hook executed with shell disabled")
	}
	permitted := New(NewPathGuard([]string{parent}), gitWorkspaceMaxBytes)
	gitCall(t, permitted, worktree, "commit", map[string]any{"message": "allowed", "identity": gitTestIdentity()})
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("fixture did not execute common-dir hook: %v", err)
	}
}

func TestGitWorkspaceUnbornDiscardAndEnvironmentIsolation(t *testing.T) {
	root, h := newGitFixture(t)
	outside, _ := newGitFixture(t)
	t.Setenv("GIT_DIR", filepath.Join(outside, ".git"))
	if err := os.WriteFile(filepath.Join(root, "keep"), []byte("one\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "discard"), []byte("two\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitCall(t, h, root, "stage", map[string]any{"all": true})
	if err := os.WriteFile(filepath.Join(root, "keep"), []byte("updated\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitCall(t, h, root, "unstage", map[string]any{"files": []any{"keep"}})
	gitCall(t, h, root, "discard", map[string]any{"files": []any{"discard"}})
	if _, err := os.Stat(filepath.Join(root, "discard")); !os.IsNotExist(err) {
		t.Fatal("unborn discard did not remove selected file")
	}
	if got, err := os.ReadFile(filepath.Join(root, "keep")); err != nil || string(got) != "updated\n" {
		t.Fatal("unstage/discard changed unrelated working content")
	}
	if gitTestRun(t, outside, "ls-files") != "" {
		t.Fatal("inherited GIT_DIR redirected remote write")
	}
	gitCall(t, h, root, "discard", map[string]any{"all": true})
}

func TestGitWorkspaceUnavailableStatesAndNestedRepository(t *testing.T) {
	root, h := newGitFixture(t)
	missing := gitCall(t, h, filepath.Join(root, "missing"), "probe", nil)
	if missing["state"] != "missing_directory" {
		t.Fatalf("missing: %v", missing)
	}
	plain := t.TempDir()
	unrestricted := New(NewPathGuard(nil), gitWorkspaceMaxBytes)
	if state := gitCall(t, unrestricted, plain, "probe", nil)["state"]; state != "not_git" {
		t.Fatalf("plain: %v", state)
	}
	bare := filepath.Join(root, "bare")
	gitTestRun(t, root, "init", "--bare", bare)
	bareProbe := gitCall(t, h, bare, "probe", nil)
	if bareProbe["state"] != "unsupported" || bareProbe["reason"] != "Bare repositories have no working tree" {
		t.Fatalf("bare: %v", bareProbe)
	}
	nested := filepath.Join(root, "nested")
	gitTestRun(t, root, "init", "-b", "main", nested)
	if got := gitCall(t, h, nested, "probe", nil)["rootPath"]; got != nested {
		t.Fatalf("nested escaped to outer repo: %v", got)
	}
	t.Setenv("PATH", t.TempDir())
	if state := gitCall(t, h, root, "probe", nil)["state"]; state != "git_unavailable" {
		t.Fatalf("missing git: %v", state)
	}
}

func TestGitWorkspaceSubmodule(t *testing.T) {
	parent := t.TempDir()
	source := filepath.Join(parent, "source")
	root := filepath.Join(parent, "root")
	for _, path := range []string{source, root} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		gitTestRun(t, path, "init", "-b", "main")
		gitTestRun(t, path, "commit", "--allow-empty", "-m", "initial")
	}
	gitTestRun(t, root, "-c", "protocol.file.allow=always", "submodule", "add", source, "module")
	gitTestRun(t, root, "commit", "-m", "add submodule")
	h := New(NewPathGuard([]string{root}), gitWorkspaceMaxBytes)
	module := filepath.Join(root, "module")
	if got := gitCall(t, h, module, "probe", nil)["rootPath"]; got != module {
		t.Fatalf("submodule escaped to parent: %v", got)
	}
	gitCall(t, h, module, "status", nil)
	// Change the nested repository HEAD: the parent sees one mode-160000
	// gitlink, which must remain independently stageable and diffable.
	if err := os.WriteFile(filepath.Join(module, "nested.txt"), []byte("nested change\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, module, "add", "nested.txt")
	gitTestRun(t, module, "commit", "-m", "nested change")
	parentDiff := gitCall(t, h, root, "diff", map[string]any{"files": []any{"module"}})["stdout"].(string)
	if !strings.Contains(parentDiff, "Subproject commit") {
		t.Fatalf("gitlink diff missing: %q", parentDiff)
	}
	gitCall(t, h, root, "stage", map[string]any{"files": []any{"module"}})
	stagedDiff := gitCall(t, h, root, "diff", map[string]any{"files": []any{"module"}, "staged": true})["stdout"].(string)
	if !strings.Contains(stagedDiff, "Subproject commit") {
		t.Fatalf("staged gitlink diff missing: %q", stagedDiff)
	}
	gitCall(t, h, root, "unstage", map[string]any{"files": []any{"module"}})
	unstaged := gitTestRun(t, root, "diff", "--name-only", "--", "module")
	if unstaged != "module" {
		status := gitTestRun(t, root, "status", "--short")
		raw := gitTestRun(t, root, "diff", "--raw", "--", "module")
		index := gitTestRun(t, root, "ls-files", "--stage", "--", "module")
		t.Fatalf("gitlink unstage lost change: name=%q status=%q raw=%q index=%q", unstaged, status, raw, index)
	}
}

func TestGitWorkspaceWorktreeAndDetached(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "init", "-b", "main")
	gitTestRun(t, root, "commit", "--allow-empty", "-m", "init")
	wt := filepath.Join(parent, "worktree")
	gitTestRun(t, root, "worktree", "add", "--detach", wt)
	h := New(NewPathGuard([]string{parent}), gitWorkspaceMaxBytes)
	probe := gitCall(t, h, wt, "probe", nil)
	if probe["rootPath"] != wt || probe["repositoryPath"] != filepath.Join(root, ".git") {
		t.Fatalf("worktree identity: %v", probe)
	}
	status := gitCall(t, h, wt, "status", nil)["outputs"].(map[string]string)
	if status["branch"] != "HEAD" {
		t.Fatalf("detached: %v", status)
	}
	// The same common repository is busy even through another connection and
	// another worktree (whose HEAD and index are otherwise independent).
	common := probe["repositoryPath"].(string)
	if runtime.GOOS == "windows" {
		common = strings.ToLower(common)
	}
	gitWorkspaceWrites.Lock()
	gitWorkspaceWrites.active[common] = true
	gitWorkspaceWrites.Unlock()
	defer func() {
		gitWorkspaceWrites.Lock()
		delete(gitWorkspaceWrites.active, common)
		gitWorkspaceWrites.Unlock()
	}()
	_, err := h.ConnectionScoped().GitWorkspace(context.Background(), map[string]any{"cwd": wt, "expectedRoot": wt, "operation": "reset", "mode": "soft", "target": "HEAD"})
	if err == nil || !strings.Contains(err.Error(), "repository is busy") {
		t.Fatalf("shared repository lock ignored: %v", err)
	}
}
