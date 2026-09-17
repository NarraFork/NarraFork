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
	if _, err := h.guard.CheckExisting(root); err != nil {
		return err
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
		}
	}
	parent, err := h.guard.CheckExisting(filepath.Dir(joined))
	if err != nil || !pathWithin(root, parent) {
		return "", fmt.Errorf("Git file path escapes the authorized worktree")
	}
	return joined, nil
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
		if !ok || path == "" || len(path) > 4096 || strings.ContainsAny(path, "\x00\\:") || strings.HasPrefix(path, "/") {
			return nil, fmt.Errorf("invalid relative Git file path")
		}
		for _, part := range strings.Split(path, "/") {
			if part == ".." || strings.EqualFold(part, ".git") || part == "" || (filepath.Separator == '\\' && (strings.HasSuffix(part, ".") || strings.HasSuffix(part, " "))) {
				return nil, fmt.Errorf("unsafe relative Git file path")
			}
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
		return map[string]any{"state": "ready", "rootPath": root, "repositoryPath": common}, nil
	}
	if expected := stringParam(params, "expectedRoot"); expected == "" || !samePath(expected, root) {
		return nil, fmt.Errorf("Git workspace changed; refresh before retrying")
	}
	g.remaining, g.truncated = maxBytes, false
	files, err := h.gitFilePaths(g, root, params)
	if err != nil {
		return nil, err
	}
	write := false
	switch op {
	case "stage", "unstage", "commit", "discard", "stashPush", "stashPop", "stashDrop", "reset":
		write = true
	case "status", "diff", "fullDiff", "log", "stashList":
	default:
		return nil, fmt.Errorf("unknown Git workspace operation")
	}
	lockKey := common
	if filepath.Separator == '\\' {
		lockKey = strings.ToLower(common)
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
	case "status":
		outputs := map[string]string{"head": strings.TrimSpace(head)}
		g.remaining = 4096
		outputs["branch"], _, err = g.run("symbolic-ref", "--quiet", "--short", "HEAD")
		branchTruncated := g.lastTruncated
		g.remaining, g.truncated = maxBytes, false
		if err != nil && hasHead {
			outputs["branch"], err = "HEAD", nil
		}
		if err != nil {
			return nil, err
		}
		if branchTruncated {
			return nil, fmt.Errorf("Git branch identity exceeds metadata budget")
		}
		// Status is the authoritative changed-file list, so it always receives the
		// shared budget first. A map here made execution order random and could spend
		// the entire budget on numstat before returning any file records.
		commands := []struct {
			key  string
			args []string
		}{
			{"status", []string{"status", "--porcelain=v1", "-z", "--untracked-files=all"}},
			{"stagedNumstat", []string{"diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z"}},
			{"unstagedNumstat", []string{"diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"}},
		}
		for _, command := range commands {
			if g.truncated {
				break
			}
			outputs[command.key], _, err = g.runNUL(command.args...)
			if err != nil {
				return nil, err
			}
		}
		if !g.truncated {
			// Count untracked lines using Git's binary detection and capped diff output.
			// A partial list or numstat record is omitted, while the top-level truncated
			// flag tells callers that counts and statistics are lower bounds.
			untracked, _, listErr := g.runNUL("ls-files", "--others", "--exclude-standard", "-z")
			if listErr != nil {
				return nil, listErr
			}
			for _, path := range strings.Split(untracked, "\x00") {
				if path == "" || g.truncated {
					continue
				}
				if _, pathErr := h.gitFilePaths(g, root, map[string]any{"files": []any{path}}); pathErr != nil {
					continue
				}
				stats, code, statErr := g.runNUL("diff", "--no-ext-diff", "--no-textconv", "--no-index", "--numstat", "-z", "--", os.DevNull, path)
				if statErr != nil && code != 1 {
					return nil, statErr
				}
				outputs["untrackedNumstat"] += stats
			}
		}
		result["outputs"] = outputs
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
		args := []string{"log", fmt.Sprintf("--max-count=%d", limit), fmt.Sprintf("--skip=%d", skip), "--format=%H%x00%h%x00%s%x00%an%x00%aI"}
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
	}
	if err != nil {
		return nil, err
	}
	result["stdout"], result["truncated"] = out, g.truncated
	return result, nil
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
