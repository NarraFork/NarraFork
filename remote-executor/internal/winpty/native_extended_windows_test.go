//go:build windows

package winpty

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Extended fixtures use only the caller-provided private TEMP root. In
// particular interactive PowerShell may not save history in SYSTEM's profile.
func extendedSession(t *testing.T, command []string) (*Session, context.CancelFunc) {
	t.Helper()
	opts := nativeOptions(t, command)
	profile := filepath.Join(opts.Cwd, "profile")
	roaming := filepath.Join(profile, "AppData", "Roaming")
	local := filepath.Join(profile, "AppData", "Local")
	for _, dir := range []string{profile, roaming, local} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	opts.Env = append(opts.Env, "USERPROFILE="+profile, "APPDATA="+roaming, "LOCALAPPDATA="+local, "HOME="+profile, "TEMP="+opts.Cwd, "TMP="+opts.Cwd)
	ctx, cancel := context.WithCancel(context.Background())
	s, err := Start(ctx, opts)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err = s.Prepare(ctx); err != nil {
		s.Close("cancelled")
		cancel()
		t.Fatal(err)
	}
	if err = s.Resume(ctx); err != nil {
		s.Close("cancelled")
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.Close("cancelled")
		cancel()
		deadline := time.NewTimer(7 * time.Second)
		defer deadline.Stop()
		for {
			select {
			case <-s.Output():
			case <-s.Done():
				return
			case <-deadline.C:
				t.Error("fixture Job cleanup exceeded budget")
				return
			}
		}
	})
	return s, cancel
}
func waitNativeText(t *testing.T, s *Session, marker string) string {
	t.Helper()
	var data strings.Builder
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for !strings.Contains(data.String(), marker) {
		select {
		case part := <-s.Output():
			data.Write(part)
		case <-s.Done():
			result := s.Wait()
			code := "unknown"
			if result.ExitCode != nil {
				code = fmt.Sprintf("%d (0x%x)", *result.ExitCode, *result.ExitCode)
			}
			preview := data.String()
			if len(preview) > 256 {
				preview = preview[:256]
			}
			t.Fatalf("native process stopped before marker %q: exit=%s result=%+v debug=%+v fixtureOutput=%q", marker, code, result, s.DebugState(), preview)
		case <-deadline.C:
			preview := data.String()
			if len(preview) > 256 {
				preview = preview[:256]
			}
			t.Fatalf("native marker %q not observed: %+v fixtureOutput=%q", marker, s.DebugState(), preview)
		}
	}
	return data.String()
}
func actualExit(t *testing.T, s *Session, expected uint32) {
	t.Helper()
	result := waitResult(t, s)
	if result.ExitCode == nil || *result.ExitCode != expected || !result.TreeStopped || !result.CleanupComplete {
		t.Fatalf("unproven actual exit: %+v", result)
	}
}
func TestNativeCtrlCInterruptsForegroundAndShellContinues(t *testing.T) {
	for _, kind := range []string{"cmd", "powershell"} {
		t.Run(kind, func(t *testing.T) {
			command := []string{"cmd.exe", "/D", "/Q", "/K"}
			if kind == "powershell" {
				// Set history SaveNothing BEFORE any test input. This is a fixture only;
				// product default remains powershell.exe -NoLogo -NoProfile, interactive.
				command = []string{"powershell.exe", "-NoLogo", "-NoProfile", "-NoExit", "-Command", "function prompt {'NATIVE_PS_PROMPT> '}; Import-Module PSReadLine -ErrorAction SilentlyContinue; if(Get-Module PSReadLine){Set-PSReadLineOption -HistorySaveStyle SaveNothing}"}
			}
			s, _ := extendedSession(t, command)
			if kind == "powershell" {
				waitNativeText(t, s, "NATIVE_PS_PROMPT> ")
			}
			if err := s.Write([]byte("ping.exe -t 127.0.0.1\r")); err != nil {
				t.Fatal(err)
			}
			waitNativeText(t, s, "TTL=") // Actual foreground output, not command echo.
			if err := s.Write([]byte{3}); err != nil {
				t.Fatal(err)
			}
			// PSReadLine can flush queued input while restoring after Ctrl-C.
			// Prove a real prompt returned before supplying the next command.
			if kind == "powershell" {
				waitNativeText(t, s, "NATIVE_PS_PROMPT> ")
			}
			text := "set \"NF_C=NARRAFORK_\"\recho %NF_C%AFTER_INTERRUPT\r"
			if kind == "powershell" {
				text = "Write-Output ('NARRAFORK_'+'AFTER_INTERRUPT')\r"
			}
			if err := s.Write([]byte(text)); err != nil {
				t.Fatal(err)
			}
			waitNativeText(t, s, "NARRAFORK_AFTER_INTERRUPT")
			if err := s.Write([]byte("exit 23\r")); err != nil {
				t.Fatal(err)
			}
			actualExit(t, s, 23)
		})
	}
}
func TestNativeUnicodeCommandResultAndInputChunkLimit(t *testing.T) {
	s, _ := extendedSession(t, []string{"cmd.exe", "/D", "/Q", "/K"})
	if err := s.Write(make([]byte, MaxInputChunk+1)); err == nil {
		t.Fatal("oversize input accepted")
	}
	// The complete marker never occurs in input: it requires real variable
	// expansion by the shell, and validates Unicode input AND output.
	if err := s.Write([]byte("chcp 65001\rset \"NF_UNICODE=你好\"\recho %NF_UNICODE%世界\r")); err != nil {
		t.Fatal(err)
	}
	waitNativeText(t, s, "你好世界")
	if err := s.Write([]byte("exit 19\r")); err != nil {
		t.Fatal(err)
	}
	actualExit(t, s, 19)
}
func duplicateWait(t *testing.T, handle windows.Handle) windows.Handle {
	t.Helper()
	var result windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), handle, windows.CurrentProcess(), &result, windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { windows.CloseHandle(result) })
	return result
}
func assertStopped(t *testing.T, handle windows.Handle) {
	t.Helper()
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("owned process still running: status=%d err=%v", status, err)
	}
}
func TestNativeKillStopsWorkerShellAndChildTree(t *testing.T) {
	script := "$child=Start-Process ($env:SystemRoot+'\\System32\\ping.exe') -ArgumentList '-t','127.0.0.1' -PassThru -NoNewWindow; [Console]::WriteLine(('NATIVE_CHILD_'+$child.Id)); Start-Sleep -Seconds 120"
	s, _ := extendedSession(t, []string{"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script})
	worker := duplicateWait(t, s.worker.Process)
	shell := duplicateWait(t, s.shell)
	output := waitNativeText(t, s, "NATIVE_CHILD_")
	// Continue until the dynamically produced PID is complete.
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	var pid uint64
	for pid == 0 {
		index := strings.Index(output, "NATIVE_CHILD_")
		if index >= 0 {
			rest := output[index+len("NATIVE_CHILD_"):]
			end := 0
			for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
				end++
			}
			if end > 0 && end < len(rest) {
				pid, _ = strconv.ParseUint(rest[:end], 10, 32)
			}
		}
		if pid != 0 {
			break
		}
		select {
		case data := <-s.Output():
			output += string(data)
		case <-deadline.C:
			t.Fatal("child PID output did not complete")
		case <-s.Done():
			t.Fatal("shell stopped before child proof")
		}
	}
	child, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(child)
	belongs, err := isProcessInJob(child, s.job)
	if err != nil || !belongs {
		t.Fatalf("actual child handle is outside original Job: %v", err)
	}
	s.Close("killed")
	result := waitResult(t, s)
	if !result.TreeStopped || !result.CleanupComplete || result.ExitCode == nil {
		t.Fatalf("kill ACK was mistaken for tree proof: %+v", result)
	}
	assertStopped(t, worker)
	assertStopped(t, shell)
	assertStopped(t, child)
}
func TestNativePeerDisconnectReclaimsOriginalJob(t *testing.T) {
	s, cancel := extendedSession(t, []string{"cmd.exe", "/D", "/Q", "/K"})
	worker := duplicateWait(t, s.worker.Process)
	shell := duplicateWait(t, s.shell)
	cancel() // Represents the original transport epoch closing, not a new peer.
	result := waitResult(t, s)
	if result.Reason != "cancelled" || !result.TreeStopped || !result.CleanupComplete {
		t.Fatalf("disconnect cleanup unconfirmed: %+v", result)
	}
	assertStopped(t, worker)
	assertStopped(t, shell)
}
func processHandleCount(t *testing.T) uint32 {
	t.Helper()
	var count uint32
	ok, _, err := kernel32.NewProc("GetProcessHandleCount").Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&count)))
	if ok == 0 {
		t.Fatal(err)
	}
	return count
}
func ownedWorkerCount(t *testing.T) int {
	t.Helper()
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	err = windows.Process32First(snapshot, &entry)
	count := 0
	for steps := 0; err == nil && steps < 4096; steps++ {
		if entry.ParentProcessID == uint32(os.Getpid()) {
			count++
		}
		err = windows.Process32Next(snapshot, &entry)
	}
	return count
}
func nativeWorkingSet(t *testing.T) uintptr {
	t.Helper()
	var counters struct {
		Size                                                                                                         uint32
		Faults                                                                                                       uint32
		PeakWorkingSet, WorkingSet, PeakPaged, Paged, PeakNonPaged, NonPaged, PageUsage, PeakPageUsage, PrivateUsage uintptr
	}
	counters.Size = uint32(unsafe.Sizeof(counters))
	ok, _, err := kernel32.NewProc("K32GetProcessMemoryInfo").Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&counters)), uintptr(counters.Size))
	if ok == 0 {
		t.Fatal(err)
	}
	return counters.WorkingSet
}

// This fault injection freezes ONLY this fixture's real worker threads. It
// proves the parent watchdog can force an unresponsive native-call worker; it
// is NOT evidence that pre-24H2 ClosePseudoConsole was tested on an old kernel.
func TestNativeUnresponsiveWorkerWatchdogFaultInjection(t *testing.T) {
	s, _ := extendedSession(t, []string{"cmd.exe", "/D", "/Q", "/K"})
	worker := duplicateWait(t, s.worker.Process)
	shell := duplicateWait(t, s.shell)
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	err = windows.Thread32First(snapshot, &entry)
	frozen := 0
	for steps := 0; err == nil && steps < 4096; steps++ {
		if entry.OwnerProcessID == s.worker.ProcessId {
			thread, openErr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
			if openErr != nil {
				t.Fatal(openErr)
			}
			result, _, suspendErr := kernel32.NewProc("SuspendThread").Call(uintptr(thread))
			windows.CloseHandle(thread)
			if uint32(result) == 0xffffffff {
				t.Fatal(suspendErr)
			}
			frozen++
		}
		err = windows.Thread32Next(snapshot, &entry)
	}
	if frozen == 0 {
		t.Fatal("fault injection did not freeze the actual worker")
	}
	started := time.Now()
	s.Close("killed")
	result := waitResult(t, s)
	if time.Since(started) > 5*time.Second || !result.TreeStopped || !result.CleanupComplete {
		t.Fatalf("parent watchdog did not prove bounded tree cleanup: elapsed=%v result=%+v", time.Since(started), result)
	}
	assertStopped(t, worker)
	assertStopped(t, shell)
}

func TestNativeRepeatedLifecycleDoesNotLeakHandlesOrWorkers(t *testing.T) {
	if !Supported() {
		t.Skip("ConPTY unavailable")
	}
	baselineWorkers := ownedWorkerCount(t)
	runtime.GC()
	baseline := processHandleCount(t)
	baselineMemory := nativeWorkingSet(t)
	for i := 0; i < 12; i++ {
		s, _ := extendedSession(t, []string{"cmd.exe", "/D", "/Q", "/K"})
		if err := s.Write([]byte("exit 0\r")); err != nil {
			t.Fatal(err)
		}
		actualExit(t, s, 0)
		if activeSessions.Load() != 0 {
			t.Fatal("completed native Job retained capacity")
		}
	}
	runtime.GC()
	handles := processHandleCount(t)
	workers := ownedWorkerCount(t)
	memory := nativeWorkingSet(t)
	if memory > baselineMemory+64*1024*1024 {
		t.Fatalf("native lifecycle working set grew beyond bounded stress allowance: baseline=%d final=%d", baselineMemory, memory)
	}
	if handles > baseline+8 || workers != baselineWorkers {
		t.Fatalf("native lifecycle resources grew: handles=%d baseline=%d children=%d baselineChildren=%d", handles, baseline, workers, baselineWorkers)
	}
	t.Logf("native resource stress: %s", fmt.Sprintf("handles baseline=%d final=%d workers=%d workingSet baseline=%d final=%d", baseline, handles, workers, baselineMemory, memory))
}
