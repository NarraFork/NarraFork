package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// execDrainDelay bounds inherited output pipes after the command exits or is
// cancelled. It is not an execution/output deadline: while the command is alive,
// backpressure can drain arbitrarily large output up to the requested byte cap.
const execDrainDelay = time.Second

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
	// Output is buffered on the executor before delivery, so the caller's cap must
	// never exceed this executor's own RPC budget (same rule as fs/grep/glob/git).
	maxBytes := intParam(params, "maxBytes", h.maxRpcBytes)
	if maxBytes <= 0 || maxBytes > h.maxRpcBytes {
		maxBytes = h.maxRpcBytes
	}

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	shell, shellArgs := loginShell(command)
	cmd := exec.CommandContext(runCtx, shell, shellArgs...)
	cmd.Dir = cwd
	cmd.Env = commandEnv(boolParam(params, "freshEnv"), params)
	configureProcAttr(cmd) // platform-specific: new process group

	// Let os/exec own the copying goroutines and bounded pipe closure.
	// Wait reaps the direct child first, then drains output with a bounded grace
	// period. StdoutPipe + waiting for EOF before Wait deadlocks if a descendant
	// retains either pipe, including descendants that escaped the process group.
	cmd.WaitDelay = execDrainDelay
	killGroup := sync.OnceFunc(func() { killProcessGroup(cmd) })
	cmd.Cancel = func() error {
		killGroup()
		return nil
	}

	// Reading a pipe must never wait for a socket or the transport's send lock:
	// otherwise WaitDelay would mistake slow delivery for an inherited pipe and
	// discard normal tail output. Accepted bytes are capped across both streams;
	// a paged queue keeps even one-byte writes from allocating unbounded metadata.
	output := newExecStreamBuffer(maxBytes)
	cmd.Stdout = execStreamWriter{channel: 0, output: output, killGroup: killGroup}
	cmd.Stderr = execStreamWriter{channel: 1, output: output, killGroup: killGroup}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	// Cmd's own context watcher stops once the direct child has been reaped,
	// before it waits for inherited pipes. Keep group cancellation live through
	// that drain, but stop/join this callback before defer cancel runs so normal
	// completion cannot leave a late kill goroutine behind. Register only after
	// Start: an already-cancelled context must never consume killGroup's Once
	// before cmd.Process exists.
	cancelDone := make(chan struct{})
	stopCancel := context.AfterFunc(runCtx, func() {
		defer close(cancelDone)
		killGroup()
	})
	stopCancellation := sync.OnceFunc(func() {
		if !stopCancel() {
			<-cancelDone
		}
	})
	defer stopCancellation()
	streamDone := make(chan struct{})
	go func() {
		defer close(streamDone)
		output.send(runCtx, onStream)
	}()

	waitErr := cmd.Wait()
	// The process and pipe lifecycle is over. Stop group cancellation before
	// waiting for potentially slow delivery, rather than leaving a late PID kill.
	stopCancellation()
	// Preserve the process exit status, but never report forced pipe closure as
	// complete output. ReadFrom also observes closure when a nonzero process exit
	// takes precedence over ErrWaitDelay inside Cmd.Wait.
	if errors.Is(waitErr, exec.ErrWaitDelay) {
		output.markTruncated()
		waitErr = nil
	}
	output.finish()
	select {
	case <-streamDone:
	case <-runCtx.Done():
		// StreamFunc has no cancellation argument. Do not let a non-cooperative
		// callback retain the process handler indefinitely; abandon queued bytes
		// explicitly. At most the one current callback may finish afterward.
		output.abort()
	}
	exitCode := exitCodeFromError(waitErr, cmd)
	timedOut := runCtx.Err() == context.DeadlineExceeded

	return map[string]any{
		"exitCode":  exitCode,
		"timedOut":  timedOut,
		"truncated": output.wasTruncated(),
	}, nil
}

const execStreamBlockBytes = 32 * 1024

// execStreamBuffer accepts at most limit bytes for the entire command, not per
// channel or per flush. Queued payload is <= limit; page slack is < 64 KiB and
// metadata is O(limit/32KiB), including when the child writes one byte at a time.
// Delivery preserves order within each channel and alternates channels when
// both have pending output (pipes never guaranteed cross-channel ordering).
// No user callback runs while mu is held.
type execStreamBuffer struct {
	mu          sync.Mutex
	limit       int64
	total       int64
	pending     [2][][]byte
	nextChannel int
	inFlight    bool
	finished    bool
	aborted     bool
	truncated   bool
	wake        chan struct{}
}

func newExecStreamBuffer(limit int64) *execStreamBuffer {
	return &execStreamBuffer{limit: max(limit, 0), wake: make(chan struct{}, 1)}
}

func (b *execStreamBuffer) notify() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

// enqueue copies from os/exec's reusable read buffer and never waits for send.
// The return value tells the caller to stop a command exceeding the byte cap.
func (b *execStreamBuffer) enqueue(channel int, p []byte) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.aborted {
		if len(p) > 0 {
			b.truncated = true
		}
		return false
	}
	remaining := b.limit - b.total
	exceeded := int64(len(p)) > remaining
	if exceeded {
		p = p[:int(remaining)]
		b.truncated = true
	}
	queue := &b.pending[channel]
	for len(p) > 0 {
		if len(*queue) == 0 || len((*queue)[len(*queue)-1]) == cap((*queue)[len(*queue)-1]) {
			size := int(min(int64(execStreamBlockBytes), b.limit-b.total))
			*queue = append(*queue, make([]byte, 0, size))
		}
		last := &(*queue)[len(*queue)-1]
		n := min(len(p), cap(*last)-len(*last))
		*last = append(*last, p[:n]...)
		b.total += int64(n)
		p = p[n:]
	}
	b.notify()
	return exceeded
}

func (b *execStreamBuffer) next(ctx context.Context) (int, []byte, bool) {
	for {
		b.mu.Lock()
		if b.aborted {
			b.mu.Unlock()
			return 0, nil, false
		}
		for i := 0; i < 2; i++ {
			channel := (b.nextChannel + i) % 2
			if queue := b.pending[channel]; len(queue) > 0 {
				// Give callbacks an exact-size owned copy, rather than pinning a
				// 32 KiB page for every tiny streamed fragment they might retain.
				chunk := bytes.Clone(queue[0])
				queue[0] = nil
				b.pending[channel] = queue[1:]
				b.nextChannel = 1 - channel
				b.inFlight = true
				b.mu.Unlock()
				return channel, chunk, true
			}
		}
		finished := b.finished
		b.mu.Unlock()
		if finished {
			return 0, nil, false
		}
		select {
		case <-b.wake:
		case <-ctx.Done():
			b.abort()
			return 0, nil, false
		}
	}
}

func (b *execStreamBuffer) send(ctx context.Context, stream StreamFunc) {
	for {
		channel, chunk, ok := b.next(ctx)
		if !ok {
			return
		}
		if ctx.Err() != nil {
			b.abort()
			return
		}
		name := "stdout"
		if channel == 1 {
			name = "stderr"
		}
		stream(name, chunk)
		b.mu.Lock()
		b.inFlight = false
		b.mu.Unlock()
	}
}

func (b *execStreamBuffer) finish() {
	b.mu.Lock()
	b.finished = true
	b.mu.Unlock()
	b.notify()
}

func (b *execStreamBuffer) abort() {
	b.mu.Lock()
	if b.inFlight || len(b.pending[0])+len(b.pending[1]) > 0 {
		b.truncated = true
	}
	b.aborted = true
	b.pending = [2][][]byte{}
	b.mu.Unlock()
	b.notify()
}

func (b *execStreamBuffer) markTruncated() {
	b.mu.Lock()
	b.truncated = true
	b.mu.Unlock()
}

func (b *execStreamBuffer) wasTruncated() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
}

type execStreamWriter struct {
	channel   int
	output    *execStreamBuffer
	killGroup func()
}

func (w execStreamWriter) Write(p []byte) (int, error) {
	if w.output.enqueue(w.channel, p) {
		w.killGroup()
	}
	return len(p), nil
}

// os/exec copies its pipe into this ReaderFrom. Observing the read error here
// matters: Cmd.Wait hides ErrWaitDelay behind a nonzero process exit status.
func (w execStreamWriter) ReadFrom(r io.Reader) (int64, error) {
	buf := make([]byte, execStreamBlockBytes)
	var total int64
	for {
		n, err := r.Read(buf)
		if n > 0 {
			_, _ = w.Write(buf[:n])
			total += int64(n)
		}
		if err != nil {
			if err == io.EOF {
				return total, nil
			}
			w.output.markTruncated()
			return total, err
		}
	}
}

// stderrMaxBytes is the cap for stderr in runCapped. stderr is diagnostic-only
// so 1 MiB is more than enough context for error reporting.
const stderrMaxBytes int64 = 1 * 1024 * 1024

// runCapped runs a command to completion, capturing stdout up to maxBytes and
// stderr up to stderrMaxBytes. Used by grep/git (non-streaming). Returns
// (stdout, stderr, exitCode, stdoutTruncated). When stderr is truncated, a
// trailing "\n[stderr truncated]" sentinel is appended to the returned bytes so
// callers can detect this from the output itself.
func runCapped(cmd *exec.Cmd, maxBytes int64) ([]byte, []byte, int, bool) {
	var stdoutBuf cappedBuffer
	stdoutBuf.limit = maxBytes
	var stderrBuf cappedBuffer
	stderrBuf.limit = stderrMaxBytes
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	exitCode := exitCodeFromError(err, cmd)

	stderrOut := stderrBuf.Bytes()
	if stderrBuf.truncated {
		stderrOut = append(stderrOut, []byte("\n[stderr truncated]")...)
	}
	return stdoutBuf.Bytes(), stderrOut, exitCode, stdoutBuf.truncated
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
