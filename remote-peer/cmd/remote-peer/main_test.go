package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Keep subprocess diagnostics bounded even if a compiler or child misbehaves.
type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := 65536 - b.Len(); remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(n, remaining)])
	}
	return n, nil
}

func TestVersionCommandRejectsArgumentsWithoutEchoingSecrets(t *testing.T) {
	for _, args := range [][]string{
		{"--unknown=private-token"}, {"--version", "private-token"},
		{"--version", "--json", "--token=private-token"},
		{"--json"}, {"--version", "--version"}, {"--version", "--json", "--json"},
	} {
		var stdout, stderr bytes.Buffer
		if code := versionCommand(args, &stdout, &stderr); code == 0 {
			t.Errorf("arguments accepted: %q", args)
		}
		if stdout.Len() != 0 || stderr.Len() == 0 || strings.Contains(stderr.String(), "private-token") {
			t.Errorf("unsafe CLI diagnostics: stdout=%q stderr=%q", stdout.String(), stderr.String())
		}
	}
}

func TestVersionCommandReportsWriteFailure(t *testing.T) {
	var stderr bytes.Buffer
	if versionCommand([]string{"--version", "--json"}, failingWriter{}, &stderr) == 0 {
		t.Fatal("output failure must not succeed")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("private-error") }

func TestVersionBinaryDoesNotReadStdinOrCreateState(t *testing.T) {
	// Use a repository-local isolated directory rather than the real user's HOME.
	dir, err := os.MkdirTemp(".", ".version-test-")
	if err != nil {
		t.Fatal(err)
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	for _, injected := range []bool{false, true} {
		name := "peer"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		binary := filepath.Join(dir, name)
		buildArgs := []string{"build", "-trimpath", "-buildvcs=false", "-o", binary}
		want := versionInfo{"dev", "unknown", "unknown", 2, runtime.Version()}
		if injected {
			want.Version = "0.1.0-alpha.1"
			want.Commit = strings.Repeat("a", 40)
			want.BuildTime = "2026-10-28T00:00:00Z"
			buildArgs = append(buildArgs, "-ldflags", "-X narrafork/remote-peer/internal/buildinfo.Version="+want.Version+" -X narrafork/remote-peer/internal/buildinfo.Commit="+want.Commit+" -X narrafork/remote-peer/internal/buildinfo.BuildTime="+want.BuildTime)
		}
		buildArgs = append(buildArgs, ".")
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		build := exec.CommandContext(ctx, "go", buildArgs...)
		build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+runtime.GOOS, "GOARCH="+runtime.GOARCH)
		var buildOutput boundedOutput
		build.Stdout, build.Stderr = &buildOutput, &buildOutput
		err = build.Run()
		cancel()
		if err != nil {
			t.Fatalf("build: %v\n%s", err, buildOutput.String())
		}
		for _, args := range [][]string{{"--version", "--json"}, {"--json", "--version"}, {"--version"}, {"--invalid=private-token"}} {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			cmd := exec.CommandContext(ctx, binary, args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), "HOME="+filepath.Join(dir, "missing-home"), "USERPROFILE="+filepath.Join(dir, "missing-home"), "NARRAFORK_HOME="+filepath.Join(dir, "missing-state"))
			stdin, writer, err := os.Pipe()
			if err != nil {
				cancel()
				t.Fatal(err)
			}
			cmd.Stdin = stdin // The writer remains open: reading stdin would hang.
			var stdout, stderr boundedOutput
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err = cmd.Run()
			_ = stdin.Close()
			_ = writer.Close()
			timedOut := ctx.Err() != nil
			cancel()
			if timedOut {
				t.Fatal("CLI query read stdin or failed to terminate")
			}
			if args[0] == "--invalid=private-token" {
				if err == nil || stdout.Len() != 0 || stderr.Len() == 0 || strings.Contains(stderr.String(), "private-token") {
					t.Fatalf("invalid arguments: err=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
				}
				continue
			}
			if err != nil || stderr.Len() != 0 {
				t.Fatalf("version: %v, stderr=%q", err, stderr.String())
			}
			if len(args) == 1 {
				if !strings.Contains(stdout.String(), "narrafork-remote-peer "+want.Version) || !strings.Contains(stdout.String(), "protocol 2") {
					t.Fatalf("human-readable version: %q", stdout.String())
				}
				continue
			}
			var got versionInfo
			dec := json.NewDecoder(&stdout)
			dec.DisallowUnknownFields()
			if err := dec.Decode(&got); err != nil || got != want {
				t.Fatalf("version JSON: %+v, want %+v; err=%v", got, want, err)
			}
			if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
				t.Fatalf("unexpected trailing stdout: %v", err)
			}
		}
		files, err := os.ReadDir(dir)
		if err != nil || len(files) != 1 || files[0].Name() != name {
			t.Fatalf("version query created state: files=%v err=%v", files, err)
		}
	}
}
