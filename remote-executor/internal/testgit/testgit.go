// Package testgit isolates Git only for test processes. Production code must not
// import it: repository-local config, hooks and attributes remain visible.
package testgit

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// Main installs one immutable PATH for the lifetime of a test binary. Setup and
// cleanup happen outside m.Run, so parallel tests never race with environment
// mutation. The actual CLI inherits the same PATH as fixture subprocesses.
func Main(m *testing.M) int {
	cleanup, err := install()
	if err != nil {
		fmt.Fprintln(os.Stderr, "install hermetic test Git:", err)
		return 1
	}
	defer cleanup()
	return m.Run()
}

func install() (func(), error) {
	// Freeze the real executable before replacing PATH; never recurse into our
	// wrapper and never fall back to a shell script on Windows.
	realGit, err := exec.LookPath("git")
	if err != nil {
		return nil, err
	}
	realGit, err = filepath.Abs(realGit)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(realGit), ".exe") {
		return nil, fmt.Errorf("test Git requires a native Windows executable")
	}
	dir, err := os.MkdirTemp("", "narrafork-testgit-")
	if err != nil {
		return nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	success := false
	defer func() {
		if !success {
			cleanup()
		}
	}()
	home := filepath.Join(dir, "home")
	if err := os.Mkdir(home, 0700); err != nil {
		return nil, err
	}
	global := filepath.Join(dir, "empty.gitconfig")
	if err := os.WriteFile(global, nil, 0600); err != nil {
		return nil, err
	}
	source := fmt.Sprintf(wrapperMain, realGit, home, global)
	for name, data := range map[string]string{"main.go": source, "run_unix.go": wrapperUnix, "run_windows.go": wrapperWindows} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			return nil, err
		}
	}
	goBinary := filepath.Join(runtime.GOROOT(), "bin", "go")
	gitBinary := filepath.Join(dir, "git")
	if runtime.GOOS == "windows" {
		goBinary += ".exe"
		gitBinary += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, goBinary, "build", "-buildvcs=false", "-o", gitBinary, ".")
	ownProcessTree(build)
	build.WaitDelay = 2 * time.Second
	build.Dir = dir
	build.Env = without(os.Environ(), "GOOS", "GOARCH", "GO111MODULE", "GOWORK", "GOTOOLCHAIN", "GOROOT")
	build.Env = append(build.Env, "GO111MODULE=off", "GOWORK=off", "GOTOOLCHAIN=local", "GOROOT="+runtime.GOROOT())
	output := &limitedOutput{remaining: 8192}
	build.Stdout, build.Stderr = output, output
	if err := build.Run(); err != nil {
		// Compiler diagnostics do not contain Git config or credentials.
		return nil, fmt.Errorf("compile forwarding executable: %w: %s", err, output.String())
	}
	oldPath, present := os.LookupEnv("PATH")
	if err := os.Setenv("PATH", dir+string(os.PathListSeparator)+oldPath); err != nil {
		return nil, err
	}
	success = true
	return func() {
		if present {
			_ = os.Setenv("PATH", oldPath)
		} else {
			_ = os.Unsetenv("PATH")
		}
		cleanup()
	}, nil
}

func without(env []string, keys ...string) []string {
	result := make([]string, 0, len(env))
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		remove := false
		for _, excluded := range keys {
			if strings.EqualFold(key, excluded) {
				remove = true
				break
			}
		}
		if !remove {
			result = append(result, item)
		}
	}
	return result
}

// CommandContext owns its process tree. On cancellation only that tree is
// stopped, including the native Windows forwarder's real-Git child.
func CommandContext(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	ownProcessTree(cmd)
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

type limitedOutput struct {
	mu        sync.Mutex
	remaining int
	data      strings.Builder
}

func (w *limitedOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	if len(p) > w.remaining {
		p = p[:w.remaining]
	}
	_, _ = w.data.Write(p)
	w.remaining -= len(p)
	return n, nil
}

func (w *limitedOutput) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.data.String()
}

var _ io.Writer = (*limitedOutput)(nil)

const wrapperMain = `package main
import (
 "os"
 "strings"
)
const realGit = %q
const home = %q
const global = %q
func main() {
 env := make([]string, 0, len(os.Environ())+8)
 for _, item := range os.Environ() {
  key, value, _ := strings.Cut(item, "=")
  key = strings.ToUpper(key)
  // Match the production GIT_* boundary, retaining only the four fixture
  // identity values explicitly supplied by test callers. No existing fixture
  // requires author/committer date overrides. Unknown path/helper overrides
  // must be refused by default, not chased with an incomplete denylist.
  if strings.HasPrefix(key, "GIT_") {
   switch key {
   case "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL":
    env = append(env, key+"="+value)
   }
   continue
  }
  switch key {
  case "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LC_ALL":
   continue
  }
  env = append(env, item)
 }
 env = append(env, "HOME="+home, "USERPROFILE="+home, "XDG_CONFIG_HOME="+home, "GIT_CONFIG_GLOBAL="+global, "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
 os.Exit(run(env))
}
`

// Exec replaces the forwarder, preserving pipes, exit codes and the parent's
// owned process group. No extra descendant can survive cancellation.
const wrapperUnix = `//go:build !windows
package main
import (
 "os"
 "syscall"
)
func run(env []string) int {
 if syscall.Exec(realGit, append([]string{realGit}, os.Args[1:]...), env) != nil { return 127 }
 return 0
}
`

// Windows needs a real executable, not a .cmd file passed to CreateProcess.
// The parent's owned-tree cancellation covers this child and its descendants.
const wrapperWindows = `//go:build windows
package main
import (
 "os"
 "os/exec"
)
func run(env []string) int {
 cmd := exec.Command(realGit, os.Args[1:]...)
 cmd.Env = env
 cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
 if err := cmd.Run(); err != nil {
  if exit, ok := err.(*exec.ExitError); ok { return exit.ExitCode() }
  return 127
 }
 return 0
}
`
