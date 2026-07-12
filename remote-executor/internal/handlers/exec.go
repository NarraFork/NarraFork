package handlers

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// ExecStart runs a command via the system shell, streaming stdout/stderr back
// through onStream, and returns the terminal exit status. ctx is cancelled when
// the server sends rpc_cancel; the process group is killed on cancel/timeout.
func (h *Handlers) ExecStart(ctx context.Context, params map[string]any, onStream StreamFunc) (any, error) {
	if h.disableShell {
		return nil, fmt.Errorf("shell execution is disabled on this executor (--disable-shell)")
	}
	command := stringParam(params, "command")
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	timeoutMs := intParam(params, "timeoutMs", 120000)
	maxBytes := intParam(params, "maxBytes", 10*1024*1024)

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	shell, shellArgs := loginShell(command)
	cmd := exec.CommandContext(runCtx, shell, shellArgs...)
	cmd.Dir = cwd
	cmd.Env = commandEnv(boolParam(params, "freshEnv"), params)
	configureProcAttr(cmd) // platform-specific: new process group

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	// Kill the whole process group when the context ends (cancel or timeout).
	go func() {
		<-runCtx.Done()
		killProcessGroup(cmd)
	}()

	var (
		mu        sync.Mutex
		total     int64
		truncated bool
	)
	stream := func(channel string, chunk []byte) {
		mu.Lock()
		defer mu.Unlock()
		if truncated {
			return
		}
		if total+int64(len(chunk)) > maxBytes {
			remaining := maxBytes - total
			if remaining > 0 {
				onStream(channel, chunk[:remaining])
				total += remaining
			}
			truncated = true
			killProcessGroup(cmd)
			return
		}
		total += int64(len(chunk))
		onStream(channel, chunk)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go pump(stdout, "stdout", stream, &wg)
	go pump(stderr, "stderr", stream, &wg)
	wg.Wait()

	waitErr := cmd.Wait()
	exitCode := exitCodeFromError(waitErr, cmd)
	timedOut := runCtx.Err() == context.DeadlineExceeded

	return map[string]any{
		"exitCode":  exitCode,
		"timedOut":  timedOut,
		"truncated": truncated,
	}, nil
}

func pump(r io.Reader, channel string, stream StreamFunc, wg *sync.WaitGroup) {
	defer wg.Done()
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			stream(channel, chunk)
		}
		if err != nil {
			return
		}
	}
}

// runCapped runs a command to completion, capturing stdout up to maxBytes and
// all stderr. Used by grep/git (non-streaming). Returns (stdout, stderr, exit,
// truncated).
func runCapped(cmd *exec.Cmd, maxBytes int64) ([]byte, []byte, int, bool) {
	var stdoutBuf cappedBuffer
	stdoutBuf.limit = maxBytes
	var stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	exitCode := exitCodeFromError(err, cmd)
	return stdoutBuf.Bytes(), stderrBuf.Bytes(), exitCode, stdoutBuf.truncated
}

// cappedBuffer is an io.Writer that stops accumulating after limit bytes.
type cappedBuffer struct {
	buf       bytes.Buffer
	limit     int64
	written   int64
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.truncated {
		return len(p), nil // discard but report success so the process keeps running
	}
	if c.written+int64(len(p)) > c.limit {
		remaining := c.limit - c.written
		if remaining > 0 {
			c.buf.Write(p[:remaining])
			c.written += remaining
		}
		c.truncated = true
		return len(p), nil
	}
	c.written += int64(len(p))
	return c.buf.Write(p)
}

func (c *cappedBuffer) Bytes() []byte { return c.buf.Bytes() }

func exitCodeFromError(err error, cmd *exec.Cmd) int {
	if err == nil {
		if cmd.ProcessState != nil {
			return cmd.ProcessState.ExitCode()
		}
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return 1
}
