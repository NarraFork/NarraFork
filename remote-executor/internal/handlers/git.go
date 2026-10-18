package handlers

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func (h *Handlers) checkPrivateGitTree(cwd string) error {
	if !h.guard.hasPrivateRoots() {
		return nil
	}
	if len(h.guard.privateRootsWithin(cwd)) > 0 {
		return errExecutorPrivatePath
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	probe := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
	probe.Dir = cwd
	out, _, code, truncated := runCapped(probe, 32768)
	if err := ctx.Err(); err != nil {
		return err
	}
	if truncated {
		return errExecutorPrivatePath
	}
	if code != 0 {
		return nil
	} // no repository; no-index operands are checked separately
	root, err := h.guard.CheckExisting(strings.TrimSpace(string(out)))
	if err != nil {
		return err
	}
	if len(h.guard.privateRootsWithin(root)) > 0 {
		return errExecutorPrivatePath
	}
	return nil
}

// GitStatus runs `git status --porcelain` in cwd.
func (h *Handlers) GitStatus(params map[string]any) (any, error) {
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	if err := h.checkPrivateGitTree(cwd); err != nil {
		return nil, err
	}
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = cwd
	stdout, _, _, _ := runCapped(cmd, h.maxRpcBytes)
	return map[string]any{"stdout": string(stdout)}, nil
}

// GitDiff runs `git diff [args...]` in cwd with an output byte cap.
func (h *Handlers) GitDiff(params map[string]any) (any, error) {
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	maxBytes := intParam(params, "maxBytes", 2*1024*1024)
	if maxBytes > h.maxRpcBytes {
		maxBytes = h.maxRpcBytes
	}

	gitArgs := []string{"diff"}
	if raw, ok := params["args"].([]any); ok {
		for _, a := range raw {
			if s, ok := a.(string); ok {
				if err := h.guard.checkPrivateArgument(cwd, s); err != nil {
					return nil, err
				}
				gitArgs = append(gitArgs, s)
			}
		}
	}
	if err := h.checkPrivateGitTree(cwd); err != nil {
		return nil, err
	}
	cmd := exec.Command("git", gitArgs...)
	cmd.Dir = cwd
	stdout, _, _, truncated := runCapped(cmd, maxBytes)
	return map[string]any{"stdout": string(stdout), "truncated": truncated}, nil
}
