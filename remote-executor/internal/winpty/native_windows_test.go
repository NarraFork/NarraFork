//go:build windows

package winpty

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The test executable implements the SAME hidden worker entry point as the
// production executor. Tests exercise actual ConPTY, never a mock/WSL backend.
func TestMain(m *testing.M) {
	if handled, code := RunWorker(os.Args[1:]); handled {
		os.Exit(code)
	}
	os.Exit(m.Run())
}
func nativeOptions(t *testing.T, cmd []string) Options {
	t.Helper()
	if !Supported() {
		t.Skip("native ConPTY APIs/build unavailable")
	}
	return Options{Command: cmd, Cwd: t.TempDir(), Env: os.Environ(), Cols: 80, Rows: 24}
}
func waitResult(t *testing.T, s *Session) Result {
	t.Helper()
	deadline := time.NewTimer(7 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-s.Output(): // A real host must keep native output drained until exit.
		case <-s.Done():
			return s.Wait()
		case <-deadline.C:
			t.Fatal("native session exceeded 5s cleanup budget")
			return Result{}
		}
	}
}
func TestNativeEchoResizeAndExit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := Start(ctx, nativeOptions(t, []string{"cmd.exe", "/D", "/Q", "/K"}))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close("cancelled")
	if err = s.Prepare(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.Resume(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	if err = s.Write([]byte("set \"NF_MARK=NARRAFORK_NATIVE_\"\recho %NF_MARK%READY\r")); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for !strings.Contains(output.String(), "NARRAFORK_NATIVE_READY") {
		select {
		case data := <-s.Output():
			output.Write(data)
		case <-deadline.C:
			t.Fatalf("native echo was not observed: %+v", s.DebugState())
		case <-s.Done():
			preview := output.String()
			if len(preview) > 256 {
				preview = preview[:256]
			}
			t.Fatalf("shell exited before echo: debug=%+v result=%+v fixtureOutput=%q", s.DebugState(), s.Wait(), preview)
		}
	}
	if err = s.Write([]byte("exit 7\r")); err != nil {
		t.Fatal(err)
	}
	result := waitResult(t, s)
	if result.ExitCode == nil || *result.ExitCode != 7 || !result.TreeStopped || !result.CleanupComplete {
		t.Fatalf("unproven native exit: %+v", result)
	}
}
func TestNativeCancelledBeforeResume(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s, err := Start(ctx, nativeOptions(t, []string{"cmd.exe", "/D", "/Q", "/K"}))
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err = s.Prepare(ctx); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	result := waitResult(t, s)
	if !result.TreeStopped {
		t.Fatalf("cancel failed to prove tree termination: %+v", result)
	}
}
func TestNativeFloodIsBoundedAndReported(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := Start(ctx, nativeOptions(t, []string{"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "while($true){[Console]::Write(('x'*32768))}"}))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close("cancelled")
	if err = s.Prepare(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.Resume(ctx); err != nil {
		t.Fatal(err)
	}
	// Deliberately DO NOT consume Output: its 1MiB budget must terminate, not grow.
	select {
	case <-s.Done():
	case <-time.After(12 * time.Second):
		t.Fatalf("output overrun did not terminate session: %+v", s.DebugState())
	}
	result := s.Wait()
	debug := s.DebugState()
	if result.Reason != "io_failed" || !result.TreeStopped || !result.CleanupComplete || s.receivedBytes.Load() == 0 || !strings.Contains(fmt.Sprint(debug["lastWorkerDiagnostic"]), "output_overrun") {
		t.Fatalf("overflow was silently lost or another IO error masqueraded as flood: result=%+v debug=%+v", result, debug)
	}
}
func TestNativeEnvironmentOverrides(t *testing.T) {
	block, err := environmentBlock([]string{"Path=old", "PATH=new", "UNICODE=你好", "=C:=C:\\scratch"})
	if err != nil {
		t.Fatal(err)
	}
	var entries []string
	for len(block) > 1 {
		i := 0
		for i < len(block) && block[i] != 0 {
			i++
		}
		if i == 0 {
			break
		}
		entries = append(entries, windows.UTF16ToString(block[:i]))
		block = block[i+1:]
	}
	joined := strings.Join(entries, "|")
	if strings.Contains(joined, "old") || !strings.Contains(joined, "PATH=new") || !strings.Contains(joined, "UNICODE=你好") {
		t.Fatal(joined)
	}
	if _, err = environmentBlock([]string{"MALFORMED"}); err == nil {
		t.Fatal("malformed environment accepted")
	}
}
