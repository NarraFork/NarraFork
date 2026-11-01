package handlers

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const gitWorkspaceMaxBytes int64 = 2 * 1024 * 1024
const gitWorkspaceMaxTimeout int64 = 120000

// gitBranchListLimit mirrors GIT_BRANCH_LIST_LIMIT in shared/git-branches.ts. The
// ref walk asks for one extra record so the server can tell "exactly at the limit"
// from "there are more"; the count also bounds the for-each-ref output, which is
// what keeps this listing cheap on a repository with thousands of refs.
const gitBranchListLimit = 300

// gitBranchRefFormat is byte-for-byte the format the local server uses. Both ends
// feed the same parser, so a remote workspace and a local one cannot disagree about
// upstream tracking, the current branch, or symbolic refs. The separator is `%00`
// (ref-filter hex escape), not `%x00` (pretty-format spelling) — for-each-ref prints
// the latter literally.
const gitBranchRefFormat = "%(refname:lstrip=2)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(contents:subject)%00%(HEAD)%00%(symref)"

// Only active repository writes occupy entries. Shared stash/refs are serialized
// across worktrees and connections, not just within a narrator or transport.
var gitWorkspaceWrites = struct {
	sync.Mutex
	active map[string]bool
}{active: make(map[string]bool)}

type workspaceGit struct {
	ctx           context.Context
	root          string
	remaining     int64
	truncated     bool
	lastTruncated bool
	env           []string
}

func (g *workspaceGit) run(args ...string) (string, int, error) {
	g.lastTruncated = false
	if err := g.ctx.Err(); err != nil {
		return "", -1, err
	}
	// Never invoke a shell, external diff, pager or inherited Git path overrides.
	prefix := []string{"--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false"}
	cmd := exec.CommandContext(g.ctx, "git", append(prefix, args...)...)
	cmd.Dir, cmd.Env = g.root, g.env
	configureProcAttr(cmd)
	cmd.Cancel = func() error { killProcessGroup(cmd); return nil }
	cmd.WaitDelay = time.Second
	stdout := &cappedBuffer{limit: g.remaining}
	stderr := &cappedBuffer{limit: 4096}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	g.remaining -= int64(len(stdout.Bytes()))
	g.lastTruncated = stdout.truncated
	g.truncated = g.truncated || g.lastTruncated
	if g.ctx.Err() != nil {
		return "", -1, fmt.Errorf("Git operation cancelled or timed out: %w", g.ctx.Err())
	}
	code := exitCodeFromError(err, cmd)
	if err != nil && cmd.ProcessState == nil {
		return "", code, err
	}
	if code != 0 {
		return string(stdout.Bytes()), code, fmt.Errorf("git %s failed: %s", args[0], stderr.Bytes())
	}
	return string(stdout.Bytes()), code, nil
}

// NUL-delimited Git protocols must never expose a partial trailing record. The
// process still drains to completion through cappedBuffer; only the returned
// prefix is rolled back to the last complete delimiter when this command hit
// its byte budget.
func (g *workspaceGit) runNUL(args ...string) (string, int, error) {
	out, code, err := g.run(args...)
	if !g.lastTruncated {
		return out, code, err
	}
	if end := strings.LastIndexByte(out, 0); end >= 0 {
		out = out[:end+1]
	} else {
		out = ""
	}
	return out, code, err
}

func gitWorkspaceEnv(identity map[string]any) []string {
	env := make([]string, 0, len(os.Environ())+6)
	for _, item := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(item, "=", 2)[0])
		if !strings.HasPrefix(key, "GIT_") {
			env = append(env, item)
		}
	}
	env = append(env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	for _, key := range []string{"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"} {
		if v, ok := identity[key].(string); ok {
			env = append(env, key+"="+v)
		}
	}
	return env
}

func validateGitIdentity(params map[string]any) (map[string]any, error) {
	identity, _ := params["identity"].(map[string]any)
	for _, key := range []string{"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"} {
		v, ok := identity[key].(string)
		if !ok || strings.TrimSpace(v) == "" || strings.ContainsAny(v, "\x00\r\n<>") || len(v) > 1024 {
			return nil, fmt.Errorf("current operation user Git identity is required (%s)", key)
		}
	}
	return identity, nil
}

// All operations are worktree-wide. A grant for a subdirectory or a guard with
// denied holes cannot be widened into permission to manage the enclosing tree.
func (h *Handlers) checkGitTree(root string) error {
	root, err := h.guard.CheckExisting(root)
	if err != nil {
		return err
	}
	if len(h.guard.privateRootsWithin(root)) > 0 {
		return errExecutorPrivatePath
	}
	for _, rule := range h.guard.rules {
		if rule.action == RuleDeny && pathWithin(root, rule.root) {
			return fmt.Errorf("whole Git worktree contains a denied path; workspace management is restricted")
		}
	}
	return nil
}

func (g *workspaceGit) isGitlink(path string) bool {
	out, code, err := g.run("ls-files", "--stage", "-z", "--", path)
	if err != nil && code != 1 {
		return false
	}
	for _, record := range strings.Split(out, "\x00") {
		if strings.HasPrefix(record, "160000 ") {
			return true
		}
	}
	return false
}

// checkGitEntryPath protects every parent component, while deliberately keeping
// the final directory entry lexical: Git manages a final symlink as a 120000
// link entry and must not be redirected to its target.
func (h *Handlers) checkGitEntryPath(root, path string) (string, error) {
	joined := filepath.Join(root, filepath.FromSlash(path))
	relative, err := filepath.Rel(root, joined)
	if err != nil || filepath.IsAbs(relative) {
		return "", fmt.Errorf("Git file path escapes the authorized worktree")
	}
	components := strings.Split(relative, string(filepath.Separator))
	current := root
	// Deleted files may have no remaining parent directories. Validate the
	// nearest existing ancestor, while inspecting every existing component
	// on the way so intermediate symlinks cannot bypass the entry checks.
	existingParent := root
	for index, component := range components {
		current = filepath.Join(current, component)
		metadata, statErr := os.Lstat(current)
		if statErr != nil {
			if errors.Is(statErr, os.ErrNotExist) {
				break
			}
			return "", fmt.Errorf("inspect Git path: %w", statErr)
		}
		if metadata.Mode()&os.ModeSymlink != 0 {
			if index != len(components)-1 {
				return "", fmt.Errorf("Git paths cannot traverse symbolic links")
			}
			// Final symlink is the managed entry itself; do not EvalSymlinks it.
			continue
		}
		if index != len(components)-1 {
			resolved, resolveErr := filepath.EvalSymlinks(current)
			if resolveErr != nil || !pathWithin(root, resolved) {
				return "", fmt.Errorf("Git file path escapes the authorized worktree")
			}
			existingParent = current
		}
	}
	parent, err := h.guard.CheckExisting(existingParent)
	if err != nil || !pathWithin(root, parent) {
		return "", fmt.Errorf("Git file path escapes the authorized worktree")
	}
	return joined, nil
}

func validateGitFilePath(path string) error {
	if path == "" || len(path) > 4096 || strings.ContainsAny(path, "\x00\\:") || strings.HasPrefix(path, "/") {
		return fmt.Errorf("invalid relative Git file path")
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." || strings.EqualFold(part, ".git") || part == "" || (filepath.Separator == '\\' && (strings.HasSuffix(part, ".") || strings.HasSuffix(part, " "))) {
			return fmt.Errorf("unsafe relative Git file path")
		}
	}
	return nil
}

func (h *Handlers) gitFilePaths(g *workspaceGit, root string, params map[string]any) ([]string, error) {
	raw, present := params["files"]
	if !present {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok || len(items) > 1000 {
		return nil, fmt.Errorf("files must be an array of at most 1000 relative paths")
	}
	files := make([]string, 0, len(items))
	for _, item := range items {
		path, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("invalid relative Git file path")
		}
		if err := validateGitFilePath(path); err != nil {
			return nil, err
		}
		joined, err := h.checkGitEntryPath(root, path)
		if err != nil {
			return nil, err
		}
		// A parent-repository submodule is a directory on disk but a single
		// mode-160000 gitlink in the parent's index. Permit only that exact
		// directory entry; ordinary directories remain non-file pathspecs.
		if stat, statErr := os.Lstat(joined); statErr == nil && stat.IsDir() && !g.isGitlink(path) {
			return nil, fmt.Errorf("Git file actions require a file, not a directory")
		}
		files = append(files, path)
	}
	return files, nil
}

// --disable-shell is also respected for indirect execution via Git. Do not
// silently bypass hooks: refuse operations that need shell execution. Even
// read-only status/diff can invoke clean/process filters while comparing a file
// with its index representation. PathGuard is not an OS sandbox against races.
func (h *Handlers) checkGitHelpers(g *workspaceGit, write bool) error {
	if !h.disableShell {
		return nil
	}
	config, code, err := g.run("config", "--get-regexp", `^filter\..*\.(clean|smudge|process)$`)
	if err != nil && code != 1 {
		return err
	}
	if config != "" || g.truncated {
		return fmt.Errorf("shell execution is disabled; Git operation may invoke configured filters")
	}
	if !write {
		return nil
	}
	config, code, err = g.run("config", "--get-regexp", `^(diff\..*\.(command|textconv)|diff\.external|gpg\..*program|merge\..*\.driver)$`)
	if err != nil && code != 1 {
		return err
	}
	if config != "" || g.truncated {
		return fmt.Errorf("shell execution is disabled; Git write may invoke configured diff/signing/merge helpers")
	}
	signing, code, err := g.run("config", "--bool", "--get", "commit.gpgsign")
	if err != nil && code != 1 {
		return err
	}
	if strings.TrimSpace(signing) == "true" {
		return fmt.Errorf("shell execution is disabled; Git signing helper cannot run")
	}
	// Git resolves both core.hooksPath and the shared hooks directory of a
	// linked worktree; private gitDir/hooks is not its default hook location.
	hooks, _, err := g.run("rev-parse", "--git-path", "hooks")
	if err != nil {
		return err
	}
	if g.truncated {
		return fmt.Errorf("Git hooks path exceeds metadata budget")
	}
	hooks = strings.TrimRight(hooks, "\r\n")
	if !filepath.IsAbs(hooks) {
		hooks = filepath.Join(g.root, hooks)
	}
	hooks, err = h.guard.CheckCreate(hooks)
	if err != nil {
		return fmt.Errorf("cannot authorize Git hooks directory: %w", err)
	}
	for _, name := range []string{"pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-checkout", "post-index-change", "reference-transaction", "post-rewrite", "pre-auto-gc", "pre-merge-commit", "post-merge"} {
		entry, err := os.Stat(filepath.Join(hooks, name))
		if err != nil && !errors.Is(err, os.ErrNotExist) && !errors.Is(err, os.ErrInvalid) {
			return fmt.Errorf("cannot inspect Git hook safely: %w", err)
		}
		if err == nil && !entry.IsDir() && (filepath.Separator == '\\' || entry.Mode().Perm()&0111 != 0) {
			return fmt.Errorf("shell execution is disabled; Git %s hook requires shell execution", name)
		}
	}
	return nil
}

func validGitRevision(ref string) bool {
	return ref != "" && len(ref) <= 1024 && !strings.HasPrefix(ref, "-") && !strings.ContainsAny(ref, "\x00\r\n")
}

// GitWorkspace is the only full Git-management RPC. It accepts operations, not
// caller-supplied argv or shell text. Its deadline covers probing and all steps.
func (h *Handlers) GitWorkspace(ctx context.Context, params map[string]any) (any, error) {
	op := stringParam(params, "operation")
	if len(op) > 32 {
		return nil, fmt.Errorf("invalid Git operation")
	}
	started := time.Now()
	defer func() {
		// Never log cwd, file names, messages, patches, or credentials.
		key := sha256.Sum256([]byte(stringParam(params, "cwd")))
		log.Printf("git.workspace operation=%q workspace=%x duration_ms=%d", op, key[:8], time.Since(started).Milliseconds())
	}()
	timeout := intParam(params, "timeoutMs", 30000)
	maxBytes := intParam(params, "maxBytes", gitWorkspaceMaxBytes)
	if timeout < 1 || timeout > gitWorkspaceMaxTimeout || maxBytes < 1 {
		return nil, fmt.Errorf("invalid Git operation budget")
	}
	if maxBytes > gitWorkspaceMaxBytes {
		maxBytes = gitWorkspaceMaxBytes
	}
	// NUL/control characters can expand six-fold in JSON. Reserve envelope
	// headroom before collecting, rather than rejecting an oversized frame later.
	wireBudget := h.maxRpcBytes / 8
	if wireBudget < 1 {
		return nil, fmt.Errorf("Git RPC byte budget is too small")
	}
	if maxBytes > wireBudget {
		maxBytes = wireBudget
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	probeFailure := func(state string, err error) (any, error) {
		if op != "probe" {
			return nil, err
		}
		return map[string]any{"state": state, "reason": err.Error()}, nil
	}
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		state := "access_denied"
		if errors.Is(err, os.ErrNotExist) {
			state = "missing_directory"
		}
		return probeFailure(state, err)
	}
	if st, err := os.Stat(cwd); err != nil || !st.IsDir() {
		return probeFailure("missing_directory", fmt.Errorf("Git cwd is not a directory"))
	}
	if _, err := exec.LookPath("git"); err != nil {
		return probeFailure("git_unavailable", err)
	}
	if op == "status" || op == "lineStats" {
		release, err := gitStatusAdmissions.admit(runCtx)
		if err != nil {
			return nil, err
		}
		// Keep global admission through root discovery and all failure/cancel
		// paths. Each g.run/runStatus joins cmd.Wait before this defer runs.
		defer release()
	}
	g := &workspaceGit{ctx: runCtx, root: cwd, remaining: 16384, env: gitWorkspaceEnv(nil)}
	bare, _, bareErr := g.run("rev-parse", "--is-bare-repository")
	if runCtx.Err() != nil {
		return nil, bareErr
	}
	if bareErr == nil {
		if g.lastTruncated {
			return probeFailure("unsupported", fmt.Errorf("Git workspace probe exceeded its output budget"))
		}
		if strings.TrimSpace(bare) == "true" {
			return probeFailure("unsupported", fmt.Errorf("Bare repositories have no working tree"))
		}
	}
	root, _, err := g.run("rev-parse", "--show-toplevel")
	if err != nil {
		state := "not_git"
		if strings.Contains(err.Error(), "dubious ownership") || strings.Contains(err.Error(), "Permission denied") {
			state = "access_denied"
		}
		if runCtx.Err() != nil {
			return nil, err
		}
		return probeFailure(state, err)
	}
	root = strings.TrimRight(root, "\r\n")
	root, err = h.guard.CheckExisting(root)
	if err != nil {
		return probeFailure("access_denied", err)
	}
	if err := h.checkGitTree(root); err != nil {
		return probeFailure("access_denied", err)
	}
	g.root = root
	common, _, err := g.run("rev-parse", "--git-common-dir")
	if err != nil {
		return nil, err
	}
	common = strings.TrimRight(common, "\r\n")
	if !filepath.IsAbs(common) {
		common = filepath.Join(root, common)
	}
	common, err = h.guard.CheckExisting(common)
	if err != nil {
		return probeFailure("access_denied", err)
	}
	if err := h.checkGitTree(common); err != nil {
		return probeFailure("access_denied", err)
	}
	// A linked worktree has a private git-dir in addition to its shared common-dir.
	gitDir, _, err := g.run("rev-parse", "--git-dir")
	if err != nil {
		return nil, err
	}
	gitDir = strings.TrimRight(gitDir, "\r\n")
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(root, gitDir)
	}
	if err := h.checkGitTree(gitDir); err != nil {
		return probeFailure("access_denied", err)
	}
	if g.truncated {
		return nil, fmt.Errorf("Git repository identity exceeds metadata budget")
	}
	if op == "probe" {
		// HEAD only: keep discovery independent of the potentially large status scan.
		branch, _, branchErr := g.run("symbolic-ref", "--quiet", "--short", "HEAD")
		var label any
		if branchErr == nil && !g.truncated {
			label = strings.TrimSpace(branch)
		}
		return map[string]any{"state": "ready", "rootPath": root, "repositoryPath": common, "branch": label}, nil
	}
	if expected := stringParam(params, "expectedRoot"); expected == "" || !samePath(expected, root) {
		return nil, fmt.Errorf("Git workspace changed; refresh before retrying")
	}
	g.remaining, g.truncated = maxBytes, false
	// Whole-worktree reads must not let supplied file actions add per-file processes.
	if _, present := params["files"]; (op == "watch" || op == "status" || op == "lineStats" || op == "branches") && present {
		return nil, fmt.Errorf("%s does not accept files", op)
	}
	if op == "commitDetail" || op == "commitDiff" {
		// Historical paths are validated lexically only: they may no longer exist,
		// and these operations read the object database, never the working tree.
		if _, present := params["files"]; present {
			return nil, fmt.Errorf("commit preview does not accept files")
		}
		if err := h.checkGitHelpers(g, false); err != nil {
			return nil, err
		}
		return h.workspaceCommitPreview(g, op, params, maxBytes)
	}
	files, err := h.gitFilePaths(g, root, params)
	if err != nil {
		return nil, err
	}
	write := false
	switch op {
	case "stage", "unstage", "commit", "discard", "stashPush", "stashPop", "stashDrop", "reset",
		"checkout", "push", "fetch":
		write = true
	case "watch", "status", "lineStats", "diff", "fullDiff", "log", "stashList", "branches":
	default:
		return nil, fmt.Errorf("unknown Git workspace operation")
	}
	lockKey := common
	if filepath.Separator == '\\' {
		lockKey = strings.ToLower(common)
	}
	if op == "status" || op == "lineStats" {
		release, err := gitStatusQueries.acquire(runCtx, root)
		if err != nil {
			return nil, err
		}
		// Canonical root serialization is separate from the already-held global
		// admission. Every run waits for its subprocess, including on cancellation.
		defer release()
	}
	if err := h.checkGitHelpers(g, write); err != nil {
		return nil, err
	}
	if write {
		gitWorkspaceWrites.Lock()
		if gitWorkspaceWrites.active[lockKey] {
			gitWorkspaceWrites.Unlock()
			return nil, fmt.Errorf("Git repository is busy; refresh before retrying")
		}
		gitWorkspaceWrites.active[lockKey] = true
		gitWorkspaceWrites.Unlock()
		defer func() {
			gitWorkspaceWrites.Lock()
			delete(gitWorkspaceWrites.active, lockKey)
			gitWorkspaceWrites.Unlock()
		}()
	}
	if op == "commit" || op == "stashPush" {
		identity, err := validateGitIdentity(params)
		if err != nil {
			return nil, err
		}
		g.env = gitWorkspaceEnv(identity)
	}
	message := stringParam(params, "message")
	if len(message) > 100000 || strings.ContainsRune(message, 0) {
		return nil, fmt.Errorf("invalid Git message")
	}
	result := map[string]any{}
	run := func(args ...string) (string, error) { out, _, err := g.run(args...); return out, err }
	g.remaining, g.truncated = 256, false
	head, headCode, headErr := g.run("rev-parse", "--verify", "--quiet", "HEAD")
	if headErr != nil && headCode != 1 {
		return nil, headErr
	}
	if g.lastTruncated {
		return nil, fmt.Errorf("Git HEAD identity exceeds metadata budget")
	}
	hasHead := headCode == 0
	g.remaining, g.truncated = maxBytes, false // metadata isn't part of the user-visible output budget
	var out string
	switch op {
	case "lineStats":
		return h.gitWorkspaceLineStats(g, maxBytes)
	case "watch":
		return h.gitWorkspaceWatch(g, head)
	case "status":
		outputs := map[string]string{"head": strings.TrimSpace(head)}
		g.remaining = 4096
		var branchCode int
		outputs["branch"], branchCode, err = g.run("symbolic-ref", "--quiet", "--short", "HEAD")
		branchTruncated := g.lastTruncated
		g.remaining, g.truncated = maxBytes, false
		if g.ctx.Err() != nil {
			return nil, g.ctx.Err()
		}
		if err != nil && branchCode == 1 && hasHead {
			outputs["branch"], err = "HEAD", nil
		}
		if err != nil {
			return nil, err
		}
		if branchTruncated {
			return nil, fmt.Errorf("Git branch identity exceeds metadata budget")
		}
		// Status never computes line counts or enumerates untracked files twice.
		outputs["status"], err = g.runStatus()
		if err != nil {
			return nil, err
		}
		result["outputs"] = outputs
		result["totalFilesExact"] = !g.truncated
	case "diff":
		if len(files) != 1 {
			return nil, fmt.Errorf("diff requires exactly one file")
		}
		out, err = h.workspaceFileDiff(g, files[0], boolParam(params, "staged"))
	case "fullDiff":
		var parts []string
		for _, args := range [][]string{{"diff", "--no-ext-diff", "--no-textconv", "--cached"}, {"diff", "--no-ext-diff", "--no-textconv"}} {
			part, e := run(args...)
			if e != nil {
				return nil, e
			}
			parts = append(parts, part)
		}
		if !g.truncated {
			// List is bounded separately; it is not included in the returned patch.
			remaining := g.remaining
			g.remaining = gitWorkspaceMaxBytes
			paths, e := run("ls-files", "--others", "--exclude-standard", "-z")
			if e != nil {
				return nil, e
			}
			listTruncated := g.truncated
			g.remaining, g.truncated = remaining, false
			for _, path := range strings.Split(paths, "\x00") {
				if path == "" || g.truncated {
					continue
				}
				if _, e := h.gitFilePaths(g, root, map[string]any{"files": []any{path}}); e != nil {
					continue
				}
				part, e := h.workspaceFileDiff(g, path, false)
				if e != nil {
					return nil, e
				}
				parts = append(parts, part)
			}
			g.truncated = g.truncated || listTruncated
		}
		out = strings.Join(parts, "")
	case "stage", "unstage":
		if !boolParam(params, "all") && len(files) == 0 {
			break
		}
		args := []string{"add"}
		if op == "stage" && boolParam(params, "all") {
			args = append(args, "-A")
		}
		if op == "unstage" {
			if hasHead {
				args = []string{"reset", "HEAD"}
			} else {
				args = []string{"rm", "--cached", "-r", "-f", "--ignore-unmatch"}
			}
		}
		args = append(args, "--")
		if boolParam(params, "all") {
			args = append(args, ".")
		} else {
			args = append(args, files...)
		}
		out, err = run(args...)
	case "commit":
		if strings.TrimSpace(message) == "" {
			return nil, fmt.Errorf("commit message is required")
		}
		_, err = run("commit", "-m", message)
		if err == nil {
			g.remaining = 256
			out, err = run("rev-parse", "HEAD")
		}
	case "discard":
		out, err = h.workspaceDiscard(g, files, boolParam(params, "all"), hasHead)
	case "log":
		if !hasHead {
			break
		}
		limit, skip := intParam(params, "limit", 50), intParam(params, "skip", 0)
		if limit < 1 || limit > 200 || skip < 0 || skip > 1000000 {
			return nil, fmt.Errorf("invalid Git history pagination")
		}
		args := []string{"log", fmt.Sprintf("--max-count=%d", limit), fmt.Sprintf("--skip=%d", skip), "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P"}
		if branch := stringParam(params, "branch"); branch != "" {
			if !validGitRevision(branch) {
				return nil, fmt.Errorf("invalid Git revision")
			}
			args = append(args, branch)
		}
		out, err = run(append(args, "--")...)
	case "stashList":
		out, err = run("stash", "list", "--max-count=201", "--format=%gd%x00%gs%x00%ai")
		if strings.Count(out, "\n") > 200 {
			g.truncated = true
		}
	case "stashPush":
		args := []string{"stash", "push", "--include-untracked"}
		if message != "" {
			args = append(args, "-m", message)
		}
		out, err = run(args...)
	case "stashPop":
		out, err = run("stash", "pop")
		if err != nil {
			conflicts, e := run("diff", "--name-only", "--diff-filter=U", "-z")
			if e == nil && conflicts != "" {
				result["hasConflicts"], err = true, nil
			}
		}
	case "stashDrop":
		index := intParam(params, "index", -1)
		if index < 0 || index > 1000000 {
			return nil, fmt.Errorf("invalid stash index")
		}
		out, err = run("stash", "drop", "stash@{"+strconv.FormatInt(index, 10)+"}")
	case "reset":
		mode, target := stringParam(params, "mode"), stringParam(params, "target")
		if (mode != "soft" && mode != "hard") || !validGitRevision(target) {
			return nil, fmt.Errorf("invalid reset target or mode")
		}
		out, err = run("reset", "--"+mode, target, "--")
	case "branches":
		return h.gitWorkspaceBranches(g, head, hasHead)
	case "checkout":
		out, err = h.gitWorkspaceCheckout(g, params)
	case "push":
		if h.disableShell {
			// A push runs the credential helper and pre-push hooks: both are external
			// programs, which --disable-shell exists to prevent.
			return nil, fmt.Errorf("shell execution is disabled; Git push may run credential helpers or hooks")
		}
		if !hasHead {
			return nil, fmt.Errorf("cannot push from a repository with no commits")
		}
		branch, branchCode, branchErr := g.run("symbolic-ref", "--quiet", "--short", "HEAD")
		if g.ctx.Err() != nil {
			return nil, g.ctx.Err()
		}
		name := strings.TrimSpace(branch)
		if branchErr != nil || name == "" {
			if branchErr != nil && branchCode != 1 {
				return nil, branchErr
			}
			return nil, errDetachedHead
		}
		remote, remoteErr := h.gitRemote(g, params)
		if remoteErr != nil {
			return nil, remoteErr
		}
		args := []string{"push", "--porcelain"}
		if boolParam(params, "setUpstream") {
			args = append(args, "--set-upstream")
		}
		// Explicit refspec and never "+": a non-fast-forward must be reported.
		// The destination follows branch.<name>.merge, so `main` tracking
		// `origin/master` updates master rather than creating origin/main.
		refspec, refspecErr := pushRefspec(g, name, remote)
		if refspecErr != nil {
			return nil, refspecErr
		}
		out, err = run(append(args, remote, refspec)...)
	case "fetch":
		if h.disableShell {
			return nil, fmt.Errorf("shell execution is disabled; Git fetch may run credential helpers")
		}
		remote, remoteErr := h.gitRemote(g, params)
		if remoteErr != nil {
			return nil, remoteErr
		}
		args := []string{"fetch"}
		if boolParam(params, "prune") {
			args = append(args, "--prune")
		}
		out, err = run(append(args, remote)...)
	}
	if err != nil {
		return nil, err
	}
	result["stdout"], result["truncated"] = out, g.truncated
	return result, nil
}

var errDetachedHead = fmt.Errorf("cannot push from a detached HEAD; check out a branch first")

// metadata runs one short Git command against a temporary byte budget, then
// restores the user-visible allowance. Branch identity, remote names and ref lookups
// are all a few hundred bytes; letting them spend the operation budget would turn a
// large listing into a misleading "truncated".
func (g *workspaceGit) metadata(budget int64, args ...string) (string, int, error) {
	remaining, truncated := g.remaining, g.truncated
	g.remaining, g.truncated = budget, false
	out, code, err := g.run(args...)
	hit := g.lastTruncated
	g.remaining, g.truncated = remaining, truncated
	if hit {
		return "", code, fmt.Errorf("%s output exceeds metadata budget", args[0])
	}
	return out, code, err
}

func matchingRemote(remotes []string, upstream string) string {
	best := ""
	upstream = strings.TrimSpace(upstream)
	for _, remote := range remotes {
		if remote == upstream || strings.HasPrefix(upstream, remote+"/") {
			if len(remote) > len(best) {
				best = remote
			}
		}
	}
	return best
}

func safeBranchDest(name string) bool {
	return name != "" && len(name) <= 200 && !strings.HasPrefix(name, "-") &&
		!strings.HasPrefix(name, "/") && !strings.HasSuffix(name, "/") &&
		!strings.Contains(name, "..") && !strings.Contains(name, "//") &&
		!strings.ContainsAny(name, " \t\r\n\x00~^:?*[\\")
}

// pushRefspec is `refs/heads/<local>:refs/heads/<dest>` with no leading "+".
// dest is the configured upstream branch when this remote is the one the
// branch tracks, and the local name otherwise.
func pushRefspec(g *workspaceGit, branch, remote string) (string, error) {
	dest := branch
	configured, code, err := g.metadata(4096, "config", "--get", "branch."+branch+".remote")
	if g.ctx.Err() != nil {
		return "", g.ctx.Err()
	}
	if err == nil && strings.TrimSpace(configured) == remote {
		merge, mergeCode, mergeErr := g.metadata(4096, "config", "--get", "branch."+branch+".merge")
		if g.ctx.Err() != nil {
			return "", g.ctx.Err()
		}
		if mergeErr == nil {
			const prefix = "refs/heads/"
			ref := strings.TrimSpace(merge)
			if strings.HasPrefix(ref, prefix) {
				candidate := strings.TrimPrefix(ref, prefix)
				if !safeBranchDest(candidate) {
					return "", fmt.Errorf("invalid Git branch name")
				}
				dest = candidate
			}
		} else if mergeCode != 1 {
			return "", mergeErr
		}
	} else if err != nil && code != 1 {
		return "", err
	}
	if !safeBranchDest(branch) || !safeBranchDest(dest) {
		return "", fmt.Errorf("invalid Git branch name")
	}
	return "refs/heads/" + branch + ":refs/heads/" + dest, nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func validGitRemoteName(name string) bool {
	return name != "" && len(name) <= 100 && !strings.HasPrefix(name, "-") &&
		!strings.Contains(name, "..") && !strings.ContainsAny(name, " \t\r\n\x00~^:?*[\\")
}

// gitRemote picks the configured remote a push/fetch may use, mirroring the local
// resolver: the caller's choice must be a remote git itself lists, otherwise the
// current branch's upstream, then "origin", then a repository with one remote.
// Only names are ever accepted, so no URL, flag or refspec can reach the command.
func (h *Handlers) gitRemote(g *workspaceGit, params map[string]any) (string, error) {
	out, _, err := g.metadata(4096, "remote")
	if err != nil {
		if g.ctx.Err() != nil {
			return "", g.ctx.Err()
		}
		return "", err
	}
	var remotes []string
	for _, line := range strings.Split(out, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			remotes = append(remotes, name)
		}
	}
	if requested := stringParam(params, "remote"); requested != "" {
		if !validGitRemoteName(requested) {
			return "", fmt.Errorf("invalid Git remote name")
		}
		if !containsString(remotes, requested) {
			return "", fmt.Errorf("Git remote is not configured: %s", requested)
		}
		return requested, nil
	}
	// Exit 128 is the ordinary "no upstream configured" answer, not a failure.
	if upstream, _, upErr := g.metadata(4096, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); upErr == nil {
		if remote := matchingRemote(remotes, upstream); remote != "" {
			return remote, nil
		}
	}
	if g.ctx.Err() != nil {
		return "", g.ctx.Err()
	}
	if containsString(remotes, "origin") {
		return "origin", nil
	}
	if len(remotes) == 1 {
		return remotes[0], nil
	}
	if len(remotes) == 0 {
		return "", fmt.Errorf("this repository has no Git remote configured")
	}
	return "", fmt.Errorf("cannot choose a Git remote; configure an upstream or pass a remote")
}

// gitBranchTarget resolves a branch that is not being created: an existing local
// branch is switched to directly, a remote-tracking ref is checked out with
// --track (which also sets its upstream). show-ref exit code 1 means "no such ref".
func gitBranchTarget(g *workspaceGit, branch string) ([]string, error) {
	_, localCode, localErr := g.metadata(4096, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	if g.ctx.Err() != nil {
		return nil, g.ctx.Err()
	}
	if localErr == nil {
		return []string{branch}, nil
	}
	if localCode != 1 {
		return nil, localErr
	}
	_, remoteCode, remoteErr := g.metadata(4096, "show-ref", "--verify", "--quiet", "refs/remotes/"+branch)
	if g.ctx.Err() != nil {
		return nil, g.ctx.Err()
	}
	if remoteErr == nil {
		return []string{"--track", branch}, nil
	}
	if remoteCode != 1 {
		return nil, remoteErr
	}
	return nil, fmt.Errorf("Git branch not found: %s", branch)
}

func (h *Handlers) gitWorkspaceCheckout(g *workspaceGit, params map[string]any) (string, error) {
	branch := stringParam(params, "branch")
	if !validGitRevision(branch) {
		return "", fmt.Errorf("invalid Git branch name")
	}
	// git owns the naming rules; a name that passes the schema can still be refused.
	if _, _, err := g.metadata(4096, "check-ref-format", "--branch", branch); err != nil {
		if g.ctx.Err() != nil {
			return "", g.ctx.Err()
		}
		return "", fmt.Errorf("invalid Git branch name")
	}
	args := []string{"checkout"}
	if boolParam(params, "create") {
		args = append(args, "-b", branch)
		if start := stringParam(params, "startPoint"); start != "" {
			if !validGitRevision(start) {
				return "", fmt.Errorf("invalid Git start point")
			}
			// A remote-tracking start point is checked out with --track so the new
			// branch records its upstream even when branch.autoSetupMerge is false.
			_, remoteCode, remoteErr := g.metadata(4096, "show-ref", "--verify", "--quiet", "refs/remotes/"+start)
			if g.ctx.Err() != nil {
				return "", g.ctx.Err()
			}
			if remoteErr == nil {
				args = append(args, "--track", start)
			} else if remoteCode != 1 {
				return "", remoteErr
			} else {
				args = append(args, start)
			}
		}
	} else {
		target, err := gitBranchTarget(g, branch)
		if err != nil {
			return "", err
		}
		args = append(args, target...)
	}
	out, _, err := g.run(append(args, "--")...)
	return out, err
}

// gitWorkspaceBranches returns the two raw ref listings plus the metadata the
// server cannot derive from them; the server parses everything with the same
// parser it uses for a local workspace.
func (h *Handlers) gitWorkspaceBranches(g *workspaceGit, head string, hasHead bool) (any, error) {
	outputs := map[string]string{"headSha": "", "branch": ""}
	if hasHead {
		outputs["headSha"] = strings.TrimSpace(head)
	}
	branch, code, err := g.metadata(4096, "symbolic-ref", "--quiet", "--short", "HEAD")
	if g.ctx.Err() != nil {
		return nil, g.ctx.Err()
	}
	if err == nil {
		outputs["branch"] = strings.TrimSpace(branch)
	} else if code != 1 {
		return nil, err
	}
	for _, listing := range []struct{ key, ref string }{
		{"heads", "refs/heads"},
		{"remoteRefs", "refs/remotes"},
	} {
		// The format is `--format=…`; a bare argument is read as a ref pattern and
		// git then prints its default columns instead of this format.
		out, _, runErr := g.run("for-each-ref", "--sort=-committerdate",
			fmt.Sprintf("--count=%d", gitBranchListLimit+1), "--format="+gitBranchRefFormat, listing.ref)
		if runErr != nil {
			return nil, runErr
		}
		outputs[listing.key] = out
	}
	if out, _, runErr := g.run("worktree", "list", "--porcelain"); runErr != nil {
		return nil, runErr
	} else {
		outputs["worktrees"] = out
	}
	if out, _, runErr := g.run("remote"); runErr != nil {
		return nil, runErr
	} else {
		outputs["remoteNames"] = out
	}
	return map[string]any{"outputs": outputs, "truncated": g.truncated}, nil
}

func (h *Handlers) workspaceFileDiff(g *workspaceGit, path string, staged bool) (string, error) {
	// `ls-files --error-unmatch` avoids parsing porcelain quoted/newline filenames.
	_, code, err := g.run("ls-files", "--error-unmatch", "--", path)
	if err != nil && code != 1 {
		return "", err
	}
	args := []string{"diff", "--no-ext-diff", "--no-textconv"}
	if staged {
		args = append(args, "--cached")
	}
	if code == 1 && !staged {
		out, status, err := g.run(append(args, "--no-index", "--", os.DevNull, path)...)
		if status == 1 {
			return out, nil
		}
		return out, err
	}
	out, _, err := g.run(append(args, "--", path)...)
	return out, err
}

func (h *Handlers) workspaceDiscard(g *workspaceGit, files []string, all, hasHead bool) (string, error) {
	if all {
		files = []string{"."}
	}
	if len(files) == 0 {
		return "", nil
	}
	// Classify against HEAD, not the index: staged additions are still new files.
	if !hasHead {
		// In an unborn repository every indexed path is an addition. Remove
		// only the selected index entries, then clean those now-untracked paths.
		if _, _, err := g.run(append([]string{"rm", "--cached", "-r", "-f", "--ignore-unmatch", "--"}, files...)...); err != nil {
			return "", err
		}
		out, _, err := g.run(append([]string{"clean", "-fd", "--"}, files...)...)
		return out, err
	}
	tracked, _, err := g.run(append([]string{"ls-tree", "-r", "--name-only", "-z", "HEAD", "--"}, files...)...)
	if err != nil || g.truncated {
		return "", fmt.Errorf("cannot enumerate discard safely: %v", err)
	}
	trackedFiles := strings.Split(strings.TrimSuffix(tracked, "\x00"), "\x00")
	if tracked != "" {
		if _, _, err := g.run(append([]string{"restore", "--source=HEAD", "--staged", "--worktree", "--"}, trackedFiles...)...); err != nil {
			return "", err
		}
	}
	if _, _, err := g.run(append([]string{"reset", "HEAD", "--"}, files...)...); err != nil {
		return "", err
	}
	out, _, err := g.run(append([]string{"clean", "-fd", "--"}, files...)...)
	return out, err
}
