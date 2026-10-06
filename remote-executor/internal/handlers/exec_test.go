//go:build !windows

package handlers

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// This test binary is also a finite-lived command fixture. The holder inherits
// both output descriptors and can escape the command's process group, just like
// a daemonized grandchild. Tests always release it, even when an assertion fails.
func TestExecStartHelperProcess(t *testing.T) {
	if os.Getenv("NF_EXEC_TEST_HELPER") != "1" {
		return
	}
	root := os.Getenv("NF_EXEC_TEST_ROOT")
	mode := os.Getenv("NF_EXEC_TEST_MODE")
	if mode == "holder" {
		if err := os.WriteFile(filepath.Join(root, "holder.pid"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			os.Exit(2)
		}
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(root, "release")); err == nil {
				_ = os.WriteFile(filepath.Join(root, "holder.done"), nil, 0600)
				os.Exit(0)
			}
			time.Sleep(5 * time.Millisecond)
		}
		os.Exit(0)
	}
	if err := os.WriteFile(filepath.Join(root, "parent.pid"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		os.Exit(2)
	}
	if mode == "clean23" {
		_, _ = os.Stdout.Write([]byte("expected-error\n"))
		os.Exit(23)
	}
	if mode == "slow-stream" {
		_, _ = os.Stdout.Write([]byte("head\n"))
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(root, "stream-blocked")); err == nil {
				_, _ = os.Stdout.Write([]byte("tail\n"))
				os.Exit(0)
			}
			time.Sleep(time.Millisecond)
		}
		os.Exit(2)
	}
	if mode == "large" {
		var wg sync.WaitGroup
		for _, out := range []*os.File{os.Stdout, os.Stderr} {
			wg.Add(1)
			go func(out *os.File) {
				defer wg.Done()
				for i := 0; i < 128; i++ {
					// Different bytes per block also detect retained/reused buffers.
					if _, err := out.Write(bytes.Repeat([]byte{byte(i)}, 32*1024)); err != nil {
						os.Exit(2)
					}
				}
			}(out)
		}
		wg.Wait()
		os.Exit(0)
	}
	executable, err := os.Executable()
	if err != nil {
		os.Exit(2)
	}
	holder := exec.Command(executable, "-test.run=^TestExecStartHelperProcess$")
	holder.Env = append(os.Environ(), "NF_EXEC_TEST_MODE=holder")
	holder.Stdout, holder.Stderr = os.Stdout, os.Stderr
	if mode == "cancel" || mode == "timeout" || mode == "quota" {
		holder.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
	if err := holder.Start(); err != nil {
		os.Exit(2)
	}
	// Ensure the holder started before announcing readiness to the test.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(root, "holder.pid")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = holder.Process.Kill()
			_ = holder.Wait()
			os.Exit(2)
		}
		time.Sleep(5 * time.Millisecond)
	}
	fmt.Fprint(os.Stdout, "ready-out\n")
	fmt.Fprint(os.Stderr, "ready-err\n")
	switch mode {
	case "exit0":
		os.Exit(0)
	case "exit23":
		os.Exit(23)
	case "quota":
		_, _ = os.Stdout.Write(bytes.Repeat([]byte("q"), 8192))
	}
	// Safety fuse independent of ExecStart's own cancellation/timeout behavior.
	time.Sleep(8 * time.Second)
	_ = holder.Process.Kill()
	_ = holder.Wait()
	os.Exit(0)
}

type execTestResult struct {
	value any
	err   error
}

func startExecFixture(t *testing.T, mode string, timeoutMs, maxBytes int, stream StreamFunc) (string, context.CancelFunc, <-chan execTestResult) {
	t.Helper()
	return startExecFixtureWithCap(t, mode, timeoutMs, maxBytes, 10*1024*1024, stream)
}

func startExecFixtureWithCap(t *testing.T, mode string, timeoutMs, maxBytes int, executorCap int64, stream StreamFunc) (string, context.CancelFunc, <-chan execTestResult) {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh")
	root := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan execTestResult, 1)
	h := New(NewPathGuard([]string{root}), executorCap)
	go func() {
		result, err := h.ExecStart(ctx, map[string]any{
			"command": "exec '" + strings.ReplaceAll(executable, "'", "'\\''") + "' -test.run=^TestExecStartHelperProcess$",
			"cwd":     root, "timeoutMs": timeoutMs, "maxBytes": maxBytes,
			"env": map[string]any{
				"NF_EXEC_TEST_HELPER": "1", "NF_EXEC_TEST_MODE": mode,
				"NF_EXEC_TEST_ROOT": root, "GORACE": "atexit_sleep_ms=0",
			},
		}, stream)
		done <- execTestResult{result, err}
		close(done)
	}()
	t.Cleanup(func() {
		// Release inherited descriptors before waiting, including on the buggy
		// implementation. Only our fixture's command group is ever signalled.
		_ = os.WriteFile(filepath.Join(root, "release"), nil, 0600)
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("fixture handler did not stop during cleanup")
		}
		// Do not remove the release file until an escaped holder has observed it.
		if data, err := os.ReadFile(filepath.Join(root, "holder.pid")); err == nil {
			pid, _ := strconv.Atoi(string(data))
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				if _, err := os.Stat(filepath.Join(root, "holder.done")); err == nil {
					return
				}
				if runtime.GOOS == "linux" {
					stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
					// A killed holder may have exited before seeing the release file.
					end := bytes.LastIndexByte(stat, ')')
					if os.IsNotExist(err) || (end >= 0 && len(stat) > end+2 && stat[end+2] == 'Z') {
						return
					}
				} else if syscall.Kill(pid, 0) == syscall.ESRCH {
					return
				}
				time.Sleep(5 * time.Millisecond)
			}
			t.Error("fixture holder did not stop during cleanup")
		}
	})
	return root, cancel, done
}

func awaitExecFixturePID(t *testing.T, root, name string) int {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(filepath.Join(root, name+".pid"))
		if err == nil {
			if pid, err := strconv.Atoi(string(data)); err == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("fixture %s did not start", name)
	return 0
}

func awaitExecResult(t *testing.T, done <-chan execTestResult) map[string]any {
	t.Helper()
	select {
	case result := <-done:
		if result.err != nil {
			t.Fatal(result.err)
		}
		return result.value.(map[string]any)
	case <-time.After(3 * time.Second):
		t.Fatal("ExecStart hung waiting for descriptors held by a descendant")
		return nil
	}
}

func assertExecParentReaped(t *testing.T, pid int) {
	t.Helper()
	if runtime.GOOS != "linux" {
		return // /proc distinguishes a reaped parent from a zombie on Linux.
	}
	if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); !os.IsNotExist(err) {
		t.Errorf("command parent not reaped: pid=%d stat=%s err=%v", pid, data, err)
	}
}

func TestExecStartReapsParentWithInheritedPipes(t *testing.T) {
	for _, code := range []int{0, 23} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			output := map[string]string{}
			root, _, done := startExecFixture(t, fmt.Sprintf("exit%d", code), 7000, 1024, func(channel string, chunk []byte) {
				output[channel] += string(chunk)
			})
			pid := awaitExecFixturePID(t, root, "parent")
			awaitExecFixturePID(t, root, "holder")
			if runtime.GOOS == "linux" {
				// Reap before the drain deadline, not just at handler completion.
				deadline := time.Now().Add(500 * time.Millisecond)
				for time.Now().Before(deadline) {
					if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); os.IsNotExist(err) {
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
				assertExecParentReaped(t, pid)
			}
			result := awaitExecResult(t, done)
			assertExecParentReaped(t, pid)
			if result["exitCode"] != code || result["timedOut"] != false || result["truncated"] != true {
				t.Fatalf("lost parent exit status or hid forced pipe closure: %+v", result)
			}
			if output["stdout"] != "ready-out\n" || output["stderr"] != "ready-err\n" {
				t.Fatalf("lost output before the parent's exit: %+v", output)
			}
		})
	}
}

func TestExecStartCancelWhileDrainingKillsGroup(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("uses /proc to cancel after the parent has been reaped")
	}
	root, cancel, done := startExecFixture(t, "exit0", 7000, 1024, func(string, []byte) {})
	parent := awaitExecFixturePID(t, root, "parent")
	holder := awaitExecFixturePID(t, root, "holder")
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(fmt.Sprintf("/proc/%d", parent)); os.IsNotExist(err) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	assertExecParentReaped(t, parent)
	cancel()
	deadline = time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", holder))
		end := bytes.LastIndexByte(stat, ')')
		if os.IsNotExist(err) || (end >= 0 && len(stat) > end+2 && stat[end+2] == 'Z') {
			awaitExecResult(t, done)
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("cancelling during output drain left the command's process group alive")
}

func TestExecStartStopsCancelWatchAfterCompletion(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("uses /proc to inspect the test holder after completion")
	}
	root, cancel, done := startExecFixture(t, "exit0", 7000, 1024, func(string, []byte) {})
	holder := awaitExecFixturePID(t, root, "holder")
	awaitExecResult(t, done)
	cancel()
	// Cancellation after completion (including ExecStart's deferred timeout
	// cleanup) must not schedule a late process-group kill.
	time.Sleep(50 * time.Millisecond)
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", holder))
	end := bytes.LastIndexByte(stat, ')')
	if err != nil || end < 0 || len(stat) <= end+2 || stat[end+2] == 'Z' {
		t.Fatalf("late cancellation killed the completed command's group: stat=%s err=%v", stat, err)
	}
}

func TestExecStartCancelClosesInheritedPipes(t *testing.T) {
	for _, mode := range []string{"cancel", "timeout", "quota"} {
		t.Run(mode, func(t *testing.T) {
			timeoutMs, maxBytes := 7000, 1024
			if mode == "timeout" {
				timeoutMs = 750
			}
			var streamed int
			root, cancel, done := startExecFixture(t, mode, timeoutMs, maxBytes, func(_ string, chunk []byte) {
				streamed += len(chunk)
			})
			pid := awaitExecFixturePID(t, root, "parent")
			awaitExecFixturePID(t, root, "holder")
			if mode == "cancel" {
				cancel()
			}
			result := awaitExecResult(t, done)
			assertExecParentReaped(t, pid)
			if result["timedOut"] != (mode == "timeout") || result["truncated"] != true {
				t.Fatalf("incorrect completion flags: %+v", result)
			}
			if mode == "quota" && streamed != maxBytes {
				t.Fatalf("byte cap: streamed %d bytes, want exactly %d", streamed, maxBytes)
			}
		})
	}
}

func TestExecStartClampsRequestedMaxBytesToExecutorCap(t *testing.T) {
	const executorCap = 512
	var streamed int
	root, cancel, done := startExecFixtureWithCap(t, "quota", 7000, 1<<20, executorCap, func(_ string, chunk []byte) {
		streamed += len(chunk)
	})
	defer cancel()
	awaitExecFixturePID(t, root, "parent")
	result := awaitExecResult(t, done)
	if result["truncated"] != true {
		t.Fatalf("expected truncation at the executor cap: %+v", result)
	}
	if streamed != executorCap {
		t.Fatalf("streamed %d bytes, want the executor cap %d", streamed, executorCap)
	}
}

func TestExecStartSlowStreamPreservesExitedCommandTail(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("uses /proc to hold delivery past the post-exit drain deadline")
	}
	started := make(chan struct{})
	blocked := make(chan struct{})
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	var root string
	var output strings.Builder
	var first sync.Once
	root, _, done := startExecFixture(t, "slow-stream", 7000, 1024, func(_ string, chunk []byte) {
		<-started
		first.Do(func() {
			// The child writes its tail only after the first delivery is blocked,
			// so the first read cannot accidentally contain the entire output.
			_ = os.WriteFile(filepath.Join(root, "stream-blocked"), nil, 0600)
			close(blocked)
			<-release
		})
		output.Write(chunk)
	})
	t.Cleanup(releaseOnce)
	close(started)
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("first stream callback did not start")
	}
	pid := awaitExecFixturePID(t, root, "parent")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); os.IsNotExist(err) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	assertExecParentReaped(t, pid)
	// The direct process is reaped. Keep the sink blocked past WaitDelay while
	// its final bytes are still waiting in the pipe on the old implementation.
	time.Sleep(execDrainDelay + 250*time.Millisecond)
	releaseOnce()
	result := awaitExecResult(t, done)
	if output.String() != "head\ntail\n" || result["exitCode"] != 0 || result["truncated"] != false {
		t.Fatalf("slow delivery silently lost normal output: output=%q result=%+v", output.String(), result)
	}
}

func TestExecStartCancelDuringSlowStreamReturnsPromptly(t *testing.T) {
	started := make(chan struct{})
	blocked := make(chan struct{})
	release := make(chan struct{})
	callbackReturned := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	var root string
	var first sync.Once
	root, cancel, done := startExecFixture(t, "slow-stream", 7000, 1024, func(_ string, _ []byte) {
		<-started
		first.Do(func() {
			defer close(callbackReturned)
			_ = os.WriteFile(filepath.Join(root, "stream-blocked"), nil, 0600)
			close(blocked)
			<-release
		})
	})
	t.Cleanup(func() {
		releaseOnce()
		select {
		case <-callbackReturned:
		case <-time.After(time.Second):
			t.Error("test stream callback did not return during cleanup")
		}
	})
	close(started)
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("first stream callback did not start")
	}
	pid := awaitExecFixturePID(t, root, "parent")
	cancel()
	select {
	case result := <-done:
		if result.err != nil || result.value.(map[string]any)["truncated"] != true {
			t.Fatalf("abandoned delivery was not reported: %+v", result)
		}
		assertExecParentReaped(t, pid)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("cancelled handler remained blocked on a non-cooperative stream callback")
	}
}

func TestExecStartNonzeroExitWithoutTruncation(t *testing.T) {
	var output strings.Builder
	_, _, done := startExecFixture(t, "clean23", 7000, 1024, func(_ string, chunk []byte) {
		output.Write(chunk)
	})
	result := awaitExecResult(t, done)
	if result["exitCode"] != 23 || result["truncated"] != false || output.String() != "expected-error\n" {
		t.Fatalf("ordinary nonzero exit misreported as truncated: output=%q result=%+v", output.String(), result)
	}
}

func TestExecStreamBufferBoundsTinyWrites(t *testing.T) {
	const limit = 2*execStreamBlockBytes + 123
	buffer := newExecStreamBuffer(limit)
	for i := 0; i < limit+1000; i++ {
		buffer.enqueue(i%2, []byte{byte(i % 2)})
	}
	var queued, allocated, pages int
	for _, queue := range buffer.pending {
		pages += len(queue)
		for _, page := range queue {
			queued += len(page)
			allocated += cap(page)
		}
	}
	if buffer.total != limit || queued != limit || allocated > limit+2*execStreamBlockBytes || pages > 4 {
		t.Fatalf("queue exceeded byte/page budget: total=%d queued=%d allocated=%d pages=%d", buffer.total, queued, allocated, pages)
	}
	if !buffer.wasTruncated() {
		t.Fatal("excess output was not marked truncated")
	}
	buffer.finish()
	var delivered int
	buffer.send(context.Background(), func(_ string, chunk []byte) { delivered += len(chunk) })
	if delivered != limit {
		t.Fatalf("accepted bytes were lost: delivered=%d want=%d", delivered, limit)
	}
}

func TestExecStartDrainsLargeOutput(t *testing.T) {
	chunks := map[string][][]byte{}
	// Keep the callback buffers instead of copying them: the streaming contract
	// must not expose os/exec's scratch buffer, which is reused on the next read.
	root, _, done := startExecFixture(t, "large", 7000, 10*1024*1024, func(channel string, chunk []byte) {
		chunks[channel] = append(chunks[channel], chunk)
		time.Sleep(time.Millisecond) // exercise backpressure as well as pipe capacity
	})
	pid := awaitExecFixturePID(t, root, "parent")
	result := awaitExecResult(t, done)
	assertExecParentReaped(t, pid)
	if result["exitCode"] != 0 || result["timedOut"] != false || result["truncated"] != false {
		t.Fatalf("normal large output was not drained: %+v", result)
	}
	var want []byte
	for i := 0; i < 128; i++ {
		want = append(want, bytes.Repeat([]byte{byte(i)}, 32*1024)...)
	}
	for _, channel := range []string{"stdout", "stderr"} {
		got := bytes.Join(chunks[channel], nil)
		if !bytes.Equal(got, want) {
			t.Errorf("%s output corrupted or cut short: got %d bytes, want %d", channel, len(got), len(want))
		}
	}
}
