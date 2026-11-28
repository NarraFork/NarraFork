package handlers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A native helper executable makes early process termination and nonzero exits
// observable on every OS without shell scripts or dependence on Git's timing.
func runGitStatusTestHelper() bool {
	mode := os.Getenv("NF_GIT_STATUS_TEST_HELPER")
	if mode == "" {
		return false
	}
	if mode == "probe-marker" || mode == "probe-block" {
		if err := os.WriteFile(os.Getenv("NF_GIT_STATUS_TEST_MARKER"), []byte(strings.Join(os.Args[1:], " ")), 0600); err != nil {
			os.Exit(11)
		}
		if mode == "probe-block" {
			time.Sleep(30 * time.Second)
		}
		os.Exit(9)
	}
	if strings.Join(os.Args[1:], " ") != "--no-pager --no-literal-pathspecs -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all -- . "+stagingExcludeSpec() {
		os.Exit(10)
	}
	if mode == "incomplete" {
		fmt.Fprint(os.Stdout, "R  new\x00")
		return true
	}
	if mode == "records" || mode == "bytes" {
		fmt.Fprint(os.Stdout, strings.Repeat("?? one\x00", gitStatusMaxRecords+1))
	} else {
		fmt.Fprint(os.Stdout, "?? one\x00")
	}
	if mode == "failure" {
		os.Exit(9)
	}
	// A drain-to-completion implementation hits its deadline instead of returning
	// a bounded success; no legitimate status reader should wait for this sleep.
	time.Sleep(30 * time.Second)
	return true
}

func installGitStatusTestHelper(t *testing.T) {
	t.Helper()
	bin := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	name := "git"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	destination, err := os.OpenFile(filepath.Join(bin, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(destination, source)
	closeErr := destination.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatalf("copy helper: %v %v", copyErr, closeErr)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestGitStatusStreamingStopsProcessAndPreservesErrors(t *testing.T) {
	root := t.TempDir()
	installGitStatusTestHelper(t)
	for _, mode := range []string{"records", "bytes", "timeout", "cancel", "failure", "incomplete"} {
		t.Run(mode, func(t *testing.T) {
			budget := gitWorkspaceMaxBytes
			if mode == "bytes" {
				budget = 8
			}
			duration := 3 * time.Second
			if mode == "timeout" {
				duration = 100 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), duration)
			defer cancel()
			if mode == "cancel" {
				timer := time.AfterFunc(100*time.Millisecond, cancel)
				defer timer.Stop()
			}
			g := &workspaceGit{ctx: ctx, root: root, remaining: budget, env: append(gitWorkspaceEnv(nil), "NF_GIT_STATUS_TEST_HELPER="+mode)}
			out, err := g.runStatus()
			if mode == "records" || mode == "bytes" {
				want := gitStatusMaxRecords
				if mode == "bytes" {
					want = 1
				}
				if err != nil || !g.truncated || strings.Count(out, "\x00") != want {
					t.Fatalf("stream did not stop at cap: records=%d truncated=%v err=%v", strings.Count(out, "\x00"), g.truncated, err)
				}
			} else if err == nil {
				t.Fatalf("%s became successful partial status %q", mode, out)
			}
			if (mode == "timeout" || mode == "cancel") && !errors.Is(err, ctx.Err()) {
				t.Fatalf("context error lost: %v", err)
			}
		})
	}
}

func TestGitStatusOutputBoundsAndRename(t *testing.T) {
	const first = " M tracked\x00"
	const rename = "R  new\tname\x00old\nname\x00"
	for _, tc := range []struct {
		name      string
		input     string
		bytes     int64
		records   int
		want      string
		truncated bool
	}{
		{"exact bytes", first, int64(len(first)), 10000, first, false},
		{"byte overflow", first + "?? other\x00", int64(len(first)), 10000, first, true},
		{"partial first", first, 2, 10000, "", true},
		{"partial rename", first + rename, int64(len(first) + len(rename) - 1), 10000, first, true},
		{"complete rename", first + rename, 1000, 2, first + rename, false},
		{"record overflow", first + rename + "?? other\x00", 1000, 2, first + rename, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, chunk := range []int{1, 5, len(tc.input)} {
				stopped := false
				out := &statusOutput{limit: tc.bytes, maxRecords: tc.records, stop: func() { stopped = true }}
				for start := 0; start < len(tc.input); start += chunk {
					end := min(start+chunk, len(tc.input))
					_, err := out.Write([]byte(tc.input[start:end]))
					if err != nil {
						if !errors.Is(err, errGitStatusLimit) {
							t.Fatal(err)
						}
						break
					}
				}
				if out.output.String() != tc.want || out.truncated != tc.truncated || stopped != tc.truncated {
					t.Fatalf("chunk %d: output=%q truncated=%v stopped=%v", chunk, out.output.String(), out.truncated, stopped)
				}
			}
		})
	}
}

func TestGitWorkspaceStatusLightweightAndRecordLimit(t *testing.T) {
	root, h := newGitFixture(t)
	// Contents do not affect status statistics: ordinary status must never return
	// numstat or enumerate/read each untracked file for line counts.
	if err := os.WriteFile(filepath.Join(root, "untracked"), []byte(strings.Repeat("line\n", 10000)), 0600); err != nil {
		t.Fatal(err)
	}
	result := gitCall(t, h, root, "status", nil)
	outputs := result["outputs"].(map[string]string)
	if len(outputs) != 3 || outputs["status"] != "?? untracked\x00" || result["totalFilesExact"] != true {
		t.Fatalf("lightweight output: %#v", result)
	}
	for i := 1; i < gitStatusMaxRecords; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("file-%05d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result = gitCall(t, h, root, "status", nil)
	if result["totalFilesExact"] != true || result["truncated"] == true {
		t.Fatal("exact record boundary incorrectly truncated")
	}
	if err := os.WriteFile(filepath.Join(root, "overflow"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	result = gitCall(t, h, root, "status", nil)
	outputs = result["outputs"].(map[string]string)
	if got := strings.Count(outputs["status"], "\x00"); got != gitStatusMaxRecords || result["totalFilesExact"] != false || result["truncated"] != true {
		t.Fatalf("record bound: count=%d exact=%v truncated=%v", got, result["totalFilesExact"], result["truncated"])
	}
	if _, err := h.GitWorkspace(context.Background(), map[string]any{"cwd": root, "expectedRoot": root, "operation": "status", "files": []any{"untracked"}}); err == nil {
		t.Fatal("status accepted per-file work")
	}
}

func TestGitWorkspaceStatusRenameByteLimit(t *testing.T) {
	root, h := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "old"), []byte("tracked\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", "old")
	gitTestRun(t, root, "commit", "-m", "initial")
	gitTestRun(t, root, "mv", "old", "new")
	const expected = "R  new\x00old\x00"
	for _, budget := range []int{1, len(expected) - 1, len(expected)} {
		result := gitCall(t, h, root, "status", map[string]any{"maxBytes": budget})
		out := result["outputs"].(map[string]string)["status"]
		if budget < len(expected) {
			if out != "" || result["truncated"] != true || result["totalFilesExact"] != false {
				t.Fatalf("partial rename: %#v", result)
			}
		} else if out != expected || result["totalFilesExact"] != true {
			t.Fatalf("complete rename: %#v", result)
		}
	}
}

func TestGitStatusCancellationAndDeadlineAreNotSuccessfulPrefixes(t *testing.T) {
	root, _ := newGitFixture(t)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	expired, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stop()
	for _, ctx := range []context.Context{cancelled, expired} {
		g := &workspaceGit{ctx: ctx, root: root, remaining: 1, env: gitWorkspaceEnv(nil)}
		if _, err := g.runStatus(); !errors.Is(err, ctx.Err()) {
			t.Fatalf("context error was swallowed: %v", err)
		}
	}
}
