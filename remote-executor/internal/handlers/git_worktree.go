package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const worktreeReceiptMaxBytes = 32768

type worktreeEntry struct {
	Path     string  `json:"path"`
	Head     *string `json:"head"`
	Branch   *string `json:"branch"`
	Bare     bool    `json:"bare"`
	Detached bool    `json:"detached"`
	Locked   bool    `json:"locked"`
	Prunable bool    `json:"prunable"`
}
type worktreeResult struct {
	Outcome   string            `json:"outcome"`
	Worktree  *worktreeEntry    `json:"worktree"`
	Residuals map[string]any    `json:"residuals"`
	Error     map[string]string `json:"error,omitempty"`
}
type worktreeReceipt struct {
	Digest             string          `json:"digest"`
	Root               string          `json:"root"`
	Repository         string          `json:"repository"`
	RepositoryIdentity string          `json:"repositoryIdentity"`
	Destination        string          `json:"destination"`
	Branch             string          `json:"branch"`
	Kind               string          `json:"kind"`
	Head               string          `json:"head"`
	Dispatched         bool            `json:"dispatched"`
	CommandSucceeded   bool            `json:"commandSucceeded"`
	Result             *worktreeResult `json:"result,omitempty"`
}

// ConfigureWorktreeStateDirectory is instance-private state, never inside a user's repository.
// The caller advertises git.worktree.v1 only after this succeeds. ConnectionScoped copies it.
func (h *Handlers) ConfigureWorktreeStateDirectory(directory string) error {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return fmt.Errorf("worktree state must be an absolute normalized directory")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	actual, err := filepath.EvalSymlinks(directory)
	if err != nil || actual != directory {
		return fmt.Errorf("worktree state directory contains a symlink")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid worktree state directory")
	}
	if filepath.Separator != '\\' && info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("worktree state directory must be private")
	}
	h.worktreeStateDir = directory
	return nil
}
func (h *Handlers) worktreeReceiptPath(id string) (string, error) {
	if h.worktreeStateDir == "" {
		return "", fmt.Errorf("worktree durable state unavailable")
	}
	if len(id) < 8 || len(id) > 128 || strings.ContainsAny(id, "\x00\r\n/\\") {
		return "", fmt.Errorf("invalid worktree requestId")
	}
	dir, err := filepath.EvalSymlinks(h.worktreeStateDir)
	if err != nil || dir != h.worktreeStateDir {
		return "", fmt.Errorf("worktree state identity changed")
	}
	key := sha256.Sum256([]byte(id))
	return filepath.Join(dir, hex.EncodeToString(key[:])+".json"), nil
}
func readWorktreeReceipt(path string) (*worktreeReceipt, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > worktreeReceiptMaxBytes {
		return nil, fmt.Errorf("invalid worktree receipt")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, fmt.Errorf("worktree receipt identity changed")
	}
	bytes, err := io.ReadAll(io.LimitReader(file, worktreeReceiptMaxBytes+1))
	if err != nil || len(bytes) > worktreeReceiptMaxBytes {
		return nil, fmt.Errorf("worktree receipt exceeds budget")
	}
	var receipt worktreeReceipt
	if err = json.Unmarshal(bytes, &receipt); err != nil {
		return nil, err
	}
	return &receipt, nil
}
func saveWorktreeReceipt(path string, receipt *worktreeReceipt, claim bool) error {
	bytes, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if len(bytes) > worktreeReceiptMaxBytes {
		return fmt.Errorf("receipt exceeds budget")
	}
	if claim {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		if _, err = file.Write(bytes); err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	} else {
		file, err := os.CreateTemp(filepath.Dir(path), ".worktree-receipt-")
		if err != nil {
			return err
		}
		temp := file.Name()
		defer os.Remove(temp)
		if _, err = file.Write(bytes); err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err = os.Rename(temp, path); err != nil {
			return err
		}
	}
	if filepath.Separator != '\\' {
		dir, err := os.Open(filepath.Dir(path))
		if err != nil {
			return err
		}
		defer dir.Close()
		return dir.Sync()
	}
	return nil
}
func worktreeUnknown() *worktreeResult {
	return &worktreeResult{Outcome: "unknown", Residuals: map[string]any{"destinationExists": nil, "branchExists": nil}, Error: map[string]string{"code": "WORKTREE_OUTCOME_UNKNOWN", "message": "Reuse the original requestId and reconcile; no automatic cleanup or retry"}}
}
func worktreeEntries(g *workspaceGit) ([]worktreeEntry, bool, error) {
	out, _, err := g.runNUL("worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, false, err
	}
	entries := make([]worktreeEntry, 0)
	var entry *worktreeEntry
	for _, field := range strings.Split(out, "\x00") {
		if field == "" {
			if entry != nil {
				entries = append(entries, *entry)
				entry = nil
			}
			continue
		}
		if strings.HasPrefix(field, "worktree ") {
			entry = &worktreeEntry{Path: strings.TrimPrefix(field, "worktree ")}
			continue
		}
		if entry == nil {
			continue
		}
		if strings.HasPrefix(field, "HEAD ") {
			head := strings.TrimPrefix(field, "HEAD ")
			entry.Head = &head
		}
		if strings.HasPrefix(field, "branch ") {
			branch := strings.TrimPrefix(field, "branch ")
			entry.Branch = &branch
		}
		if field == "bare" {
			entry.Bare = true
		}
		if field == "detached" {
			entry.Detached = true
		}
		if field == "locked" || strings.HasPrefix(field, "locked ") {
			entry.Locked = true
		}
		if field == "prunable" || strings.HasPrefix(field, "prunable ") {
			entry.Prunable = true
		}
		if len(entries) >= 128 {
			return entries, true, nil
		}
	}
	if entry != nil && !g.lastTruncated {
		entries = append(entries, *entry)
	}
	return entries, g.truncated, nil
}
func (h *Handlers) worktreeDestination(root, common, destination string) error {
	if !filepath.IsAbs(destination) || filepath.Clean(destination) != destination || strings.ContainsAny(destination, "\x00\r\n") || len(destination) > 4096 {
		return fmt.Errorf("destination must be an absolute normalized path")
	}
	if !pathWithin(root, destination) || root == destination || pathWithin(common, destination) {
		return fmt.Errorf("destination outside authorized worktree")
	}
	canonical, err := h.guard.CheckCreate(destination)
	if err != nil {
		return err
	}
	if canonical != destination {
		return fmt.Errorf("symlink/junction destination unsupported")
	}
	cursor := destination
	first := true
	for cursor != root {
		st, err := os.Lstat(cursor)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if !first {
				return fmt.Errorf("destination parent must already exist")
			}
		}
		if err == nil {
			if st.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("symlink destination unsupported")
			}
			if first {
				return fmt.Errorf("destination already exists")
			}
			if !st.IsDir() {
				return fmt.Errorf("destination parent is not a directory")
			}
		}
		first = false
		cursor = filepath.Dir(cursor)
	}
	return nil
}
func (h *Handlers) worktreeBranch(g *workspaceGit, name, kind, base string) (string, error) {
	if !validGitRevision(name) || len(name) > 256 || strings.ContainsAny(name, "\t ") {
		return "", fmt.Errorf("invalid branch")
	}
	if _, _, err := g.run("check-ref-format", "refs/heads/"+name); err != nil {
		return "", err
	}
	_, code, err := g.run("show-ref", "--verify", "--quiet", "refs/heads/"+name)
	if code != 0 && code != 1 {
		return "", err
	}
	if kind == "new" && code == 0 {
		return "", fmt.Errorf("branch already exists")
	}
	if kind == "existing" && code != 0 {
		return "", fmt.Errorf("branch does not exist")
	}
	entries, truncated, err := worktreeEntries(g)
	if err != nil {
		return "", err
	}
	if truncated {
		return "", fmt.Errorf("worktree inventory incomplete")
	}
	for _, entry := range entries {
		if entry.Branch != nil && *entry.Branch == "refs/heads/"+name {
			return "", fmt.Errorf("branch already checked out")
		}
	}
	if kind == "existing" {
		base = "refs/heads/" + name
	}
	if base == "" {
		base = "HEAD"
	}
	if !validGitRevision(base) {
		return "", fmt.Errorf("invalid base ref")
	}
	out, _, err := g.run("rev-parse", "--verify", "--end-of-options", base+"^{commit}")
	if err != nil {
		return "", err
	}
	head := strings.TrimSpace(out)
	if (len(head) != 40 && len(head) != 64) || g.truncated {
		return "", fmt.Errorf("invalid base commit")
	}
	return head, nil
}
func (h *Handlers) reconcileWorktree(g *workspaceGit, r *worktreeReceipt) *worktreeResult {
	result := worktreeUnknown()
	// An intent that never reached dispatch cannot claim a matching external creation.
	if !r.Dispatched {
		return result
	}
	identity, err := worktreeRootIdentity(r.Repository)
	if err != nil || identity != r.RepositoryIdentity {
		return result
	}
	_, statErr := os.Lstat(r.Destination)
	exists := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return result
	}
	result.Residuals["destinationExists"] = exists
	_, code, err := g.run("show-ref", "--verify", "--quiet", "refs/heads/"+r.Branch)
	if code == 0 || code == 1 {
		result.Residuals["branchExists"] = code == 0
	} else {
		return result
	}
	entries, truncated, err := worktreeEntries(g)
	if err != nil || truncated {
		return result
	}
	for _, entry := range entries {
		if filepath.Clean(entry.Path) != r.Destination {
			continue
		}
		if !exists || entry.Prunable || entry.Branch == nil || *entry.Branch != "refs/heads/"+r.Branch || entry.Head == nil || *entry.Head != r.Head {
			return result
		}
		actual, err := h.guard.CheckExisting(r.Destination)
		if err != nil || actual != r.Destination {
			return result
		}
		verify := &workspaceGit{ctx: g.ctx, root: r.Destination, remaining: 32768, env: gitWorkspaceEnv(nil)}
		common, _, err := verify.run("rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil {
			return result
		}
		common = strings.TrimSpace(common)
		common, err = filepath.EvalSymlinks(common)
		if err != nil || common != r.Repository {
			return result
		}
		if !r.CommandSucceeded {
			if err := h.checkGitHelpers(verify, false); err != nil {
				return result
			}
			out, _, err := verify.runNUL("status", "--porcelain=v1", "-z", "--untracked-files=no")
			if err != nil || out != "" || verify.truncated {
				return result
			}
		}
		result.Outcome = "created"
		result.Worktree = &entry
		result.Error = nil
		return result
	}
	result.Outcome = "failed"
	result.Error = map[string]string{"code": "WORKTREE_CREATE_FAILED", "message": "No matching registered worktree; residual files and branches left untouched"}
	return result
}

// GitWorktree has no arbitrary argv, delete, prune, automatic switch or network retry.
func (h *Handlers) GitWorktree(ctx context.Context, params map[string]any) (any, error) {
	started := time.Now()
	op := stringParam(params, "operation")
	if len(op) > 32 {
		return nil, fmt.Errorf("invalid worktree operation")
	}
	defer func() { log.Printf("git.worktree operation=%q duration_ms=%d", op, time.Since(started).Milliseconds()) }()
	if op != "list" && op != "prepare" && op != "create" && op != "status" && op != "reconcile" {
		return nil, fmt.Errorf("unsupported worktree operation")
	}
	timeout := intParam(params, "timeoutMs", 10000)
	if timeout < 1 || timeout > 120000 {
		return nil, fmt.Errorf("invalid timeout")
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	probe, err := h.GitWorkspace(runCtx, map[string]any{"operation": "probe", "cwd": stringParam(params, "cwd"), "timeoutMs": float64(timeout), "maxBytes": float64(16384)})
	if err != nil {
		return nil, err
	}
	facts := probe.(map[string]any)
	root, _ := facts["rootPath"].(string)
	common, _ := facts["repositoryPath"].(string)
	if facts["state"] != "ready" || root != stringParam(params, "expectedRoot") || common != stringParam(params, "expectedRepository") {
		return nil, fmt.Errorf("worktree repository identity changed or denied")
	}
	if h.worktreeStateDir != "" && (pathWithin(root, h.worktreeStateDir) || pathWithin(common, h.worktreeStateDir)) {
		return nil, fmt.Errorf("private state must not be inside repository")
	}
	budget := intParam(params, "maxBytes", 131072)
	if budget < 1 {
		return nil, fmt.Errorf("invalid worktree output budget")
	}
	if budget > 131072 {
		budget = 131072
	}
	if wire := h.maxRpcBytes / 8; budget > wire {
		budget = wire
	}
	g := &workspaceGit{ctx: runCtx, root: root, remaining: budget, env: gitWorkspaceEnv(nil)}
	if op == "list" {
		entries, truncated, err := worktreeEntries(g)
		if err != nil {
			return nil, err
		}
		return map[string]any{"entries": entries, "truncated": truncated}, nil
	}
	destination := stringParam(params, "destinationPath")
	name := stringParam(params, "branchName")
	kind := stringParam(params, "branchKind")
	if kind == "" {
		kind = "new"
	}
	if kind != "new" && kind != "existing" {
		return nil, fmt.Errorf("invalid branch kind")
	}
	if op == "prepare" {
		if !validGitRevision(name) {
			return nil, fmt.Errorf("invalid branch")
		}
		_, _, err := g.run("check-ref-format", "refs/heads/"+name)
		if err != nil {
			return nil, err
		}
		_, code, err := g.run("show-ref", "--verify", "--quiet", "refs/heads/"+name)
		if code == 0 {
			return nil, fmt.Errorf("branch already exists")
		}
		if code != 1 {
			return nil, err
		}
		leaf := stringParam(params, "worktreeName")
		if leaf == "" || filepath.Base(leaf) != leaf || len(leaf) > 128 || strings.ContainsAny(leaf, "\x00\r\n") {
			return nil, fmt.Errorf("invalid worktree name")
		}
		if destination == "" {
			parent := filepath.Join(root, ".worktrees")
			st, e := os.Lstat(parent)
			if e == nil && st.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("symlink worktree parent")
			}
			if e == nil && st.IsDir() {
				destination = filepath.Join(parent, leaf)
			} else if errors.Is(e, os.ErrNotExist) {
				destination = filepath.Join(root, "nf-worktree-"+leaf)
			} else {
				return nil, fmt.Errorf("invalid default worktree parent")
			}
		}
		if err := h.worktreeDestination(root, common, destination); err != nil {
			return nil, err
		}
		return map[string]any{"prepared": map[string]any{"branchName": name, "worktreeName": filepath.Base(destination), "destinationPath": destination}}, nil
	}
	id := stringParam(params, "requestId")
	receiptPath, err := h.worktreeReceiptPath(id)
	if err != nil {
		return nil, err
	}
	actor := stringParam(params, "actorKey")
	serverDigest := stringParam(params, "requestDigest")
	if actor == "" || len(actor) > 256 || len(serverDigest) != 64 {
		return nil, fmt.Errorf("worktree actor and frozen digest required")
	}
	// Repository identity, not the caller's current linked-worktree root, binds recovery.
	// The server digest still binds the original revision/workspace proposal.
	canonical, _ := json.Marshal([]string{common, destination, name, kind, stringParam(params, "baseRef"), actor, serverDigest})
	sum := sha256.Sum256(canonical)
	digest := hex.EncodeToString(sum[:])
	// Same lock as other structured Git writes, common-dir keyed across linked worktrees.
	gitWorkspaceWrites.Lock()
	if gitWorkspaceWrites.active[common] {
		gitWorkspaceWrites.Unlock()
		return nil, fmt.Errorf("another Git write is in progress")
	}
	gitWorkspaceWrites.active[common] = true
	gitWorkspaceWrites.Unlock()
	defer func() {
		gitWorkspaceWrites.Lock()
		delete(gitWorkspaceWrites.active, common)
		gitWorkspaceWrites.Unlock()
	}()
	if !filepath.IsAbs(destination) || filepath.Clean(destination) != destination || !pathWithin(root, destination) || pathWithin(common, destination) {
		return nil, fmt.Errorf("receipt destination is outside the authorized worktree")
	}
	admittedDestination, err := h.guard.CheckCreate(destination)
	if err != nil || admittedDestination != destination {
		return nil, fmt.Errorf("receipt destination denied or identity changed")
	}
	existing, readErr := readWorktreeReceipt(receiptPath)
	if readErr == nil {
		if existing.Digest != digest {
			return nil, fmt.Errorf("worktree requestId conflict")
		}
		identity, err := worktreeRootIdentity(common)
		if err != nil || identity != existing.RepositoryIdentity {
			return map[string]any{"result": worktreeUnknown()}, nil
		}
		if existing.Result != nil && existing.Result.Outcome != "unknown" {
			return map[string]any{"result": existing.Result}, nil
		}
		result := h.reconcileWorktree(g, existing)
		existing.Result = result
		if err := saveWorktreeReceipt(receiptPath, existing, false); err != nil {
			return map[string]any{"result": worktreeUnknown()}, nil
		}
		return map[string]any{"result": result}, nil
	}
	if !errors.Is(readErr, os.ErrNotExist) {
		return nil, readErr
	}
	if op != "create" {
		return map[string]any{"result": worktreeUnknown()}, nil
	}
	if err := h.worktreeDestination(root, common, destination); err != nil {
		return nil, err
	}
	head, err := h.worktreeBranch(g, name, kind, stringParam(params, "baseRef"))
	if err != nil {
		return nil, err
	}
	if h.disableShell {
		if err := h.checkGitHelpers(g, true); err != nil {
			return nil, err
		}
	}
	identity, err := worktreeRootIdentity(common)
	if err != nil {
		return nil, err
	}
	receipt := &worktreeReceipt{Digest: digest, Root: root, Repository: common, RepositoryIdentity: identity, Destination: destination, Branch: name, Kind: kind, Head: head}
	if err := saveWorktreeReceipt(receiptPath, receipt, true); err != nil {
		return nil, err
	}
	// A durable intent is never re-executed after crash; a duplicate only observes facts.
	if err := h.worktreeDestination(root, common, destination); err != nil {
		return nil, err
	}
	if err := runCtx.Err(); err != nil {
		return nil, err
	}
	receipt.Dispatched = true
	if err := saveWorktreeReceipt(receiptPath, receipt, false); err != nil {
		return nil, err
	}
	args := []string{"worktree", "add"}
	if kind == "new" {
		args = append(args, "-b", name)
	}
	args = append(args, "--", destination)
	if kind == "new" {
		args = append(args, head)
	} else {
		args = append(args, name)
	}
	_, code, _ := g.run(args...)
	receipt.CommandSucceeded = code == 0
	// Independent bounded verification survives client cancellation and response loss.
	verifyCtx, verifyCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer verifyCancel()
	verify := &workspaceGit{ctx: verifyCtx, root: root, remaining: 131072, env: gitWorkspaceEnv(nil)}
	result := h.reconcileWorktree(verify, receipt)
	receipt.Result = result
	if err := saveWorktreeReceipt(receiptPath, receipt, false); err != nil {
		return map[string]any{"result": worktreeUnknown()}, nil
	}
	return map[string]any{"result": result}, nil
}
