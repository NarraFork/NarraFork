package handlers

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const gitStatusMaxRecords = 10000

var errGitStatusLimit = errors.New("Git status output limit reached")

// statusOutput retains complete logical porcelain-v1 records only. Renames/copies
// have two NUL-delimited paths and are committed atomically, including at a cap.
// It runs on exec's stdout copier, which is joined before its fields are read.
type statusOutput struct {
	limit      int64
	maxRecords int
	output     strings.Builder
	pending    []byte
	oldPath    bool
	records    int
	truncated  bool
	stop       context.CancelFunc
}

func (s *statusOutput) Write(p []byte) (int, error) {
	for i, b := range p {
		if s.records >= s.maxRecords || int64(s.output.Len()+len(s.pending)) >= s.limit {
			s.truncated = true
			s.stop()
			return i, errGitStatusLimit
		}
		s.pending = append(s.pending, b)
		if b != 0 {
			continue
		}
		if !s.oldPath && len(s.pending) >= 4 && strings.ContainsAny(string(s.pending[:2]), "RC") {
			s.oldPath = true
			continue
		}
		s.output.Write(s.pending)
		s.pending = s.pending[:0]
		s.oldPath = false
		s.records++
	}
	return len(p), nil
}

// Unlike generic runNUL, status stops Git as soon as either budget is exceeded;
// it never drains an arbitrarily large worktree result before returning a prefix.
func (g *workspaceGit) runStatus() (string, error) {
	if err := g.ctx.Err(); err != nil {
		return "", err
	}
	ctx, stop := context.WithCancel(g.ctx)
	defer stop()
	args := []string{"--no-pager", "--no-literal-pathspecs", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", stagingExcludeSpec()}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir, cmd.Env = g.root, g.env
	configureProcAttr(cmd)
	cmd.Cancel = func() error { killProcessGroup(cmd); return nil }
	cmd.WaitDelay = time.Second
	stdout := &statusOutput{limit: g.remaining, maxRecords: gitStatusMaxRecords, stop: stop}
	stderr := &cappedBuffer{limit: 4096}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	// Caller cancellation/deadline wins over a simultaneous intentional cap stop.
	if g.ctx.Err() != nil {
		return "", fmt.Errorf("Git operation cancelled or timed out: %w", g.ctx.Err())
	}
	if err != nil && !stdout.truncated {
		return "", fmt.Errorf("git status failed: %w: %s", err, stderr.Bytes())
	}
	if len(stdout.pending) > 0 && !stdout.truncated {
		return "", fmt.Errorf("git status returned an incomplete porcelain record")
	}
	g.lastTruncated = stdout.truncated
	g.truncated = g.truncated || stdout.truncated
	out := stdout.output.String()
	g.remaining -= int64(len(out))
	return out, nil
}
