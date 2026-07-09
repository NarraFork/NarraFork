package handlers

import (
	"os/exec"
)

// GitStatus runs `git status --porcelain` in cwd.
func (h *Handlers) GitStatus(params map[string]any) (any, error) {
	cwd, err := h.guardedPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = cwd
	stdout, _, _, _ := runCapped(cmd, h.maxRpcBytes)
	return map[string]any{"stdout": string(stdout)}, nil
}

// GitDiff runs `git diff [args...]` in cwd with an output byte cap.
func (h *Handlers) GitDiff(params map[string]any) (any, error) {
	cwd, err := h.guardedPath(params, "cwd")
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
				gitArgs = append(gitArgs, s)
			}
		}
	}
	cmd := exec.Command("git", gitArgs...)
	cmd.Dir = cwd
	stdout, _, _, truncated := runCapped(cmd, maxBytes)
	return map[string]any{"stdout": string(stdout), "truncated": truncated}, nil
}
