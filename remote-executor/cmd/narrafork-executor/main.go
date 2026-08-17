// Command narrafork-executor is a lightweight remote executor for NarraFork.
//
// It connects back to a NarraFork server (reverse dial) using a device URL +
// registration token, then serves file / command / grep / git RPCs so a
// narrator's tools can run on this machine. Build statically with:
//
//	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o narrafork-executor ./cmd/narrafork-executor
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/narrafork/remote-executor/internal/buildinfo"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/transport"
)

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Printf("narrafork-executor %s\n", buildinfo.String())
		return
	}

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[narrafork-executor] ")

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	guard := handlers.NewPathGuardWithRules(toGuardRules(cfg.EffectivePathRules()))
	if guard.Unrestricted() {
		log.Printf("WARNING: no path rules set; structured path RPCs may access any path the OS user can access")
	}
	// An unresolved deny still blocks its literal subtree, but a symlink or a
	// later-created directory can sidestep it, so it must not stay silent.
	for _, path := range guard.UnresolvedDenyRules() {
		log.Printf("WARNING: deny rule %q could not be resolved (missing path?); it blocks that literal path only", path)
	}
	if !cfg.DisableShell {
		log.Printf("WARNING: shell/PTY execution is enabled; --allow-root validates command cwd only and does not sandbox command text (use --disable-shell and OS isolation for a hard boundary)")
	}

	h := handlers.NewWithOptions(guard, 10*1024*1024, cfg.DisableShell)
	dispatcher := rpc.NewDispatcher(h)

	platform := rpc.Platform{
		OS:   runtime.GOOS,
		Arch: runtime.GOARCH,
	}
	if !cfg.DisableShell {
		if runtime.GOOS == "windows" {
			platform.ShellType = "powershell"
			platform.ShellPath = "powershell.exe"
		} else {
			platform.ShellType = "bash"
			platform.ShellPath = shellPath()
		}
	}

	caps := rpc.Capabilities{
		Git:     hasBinary("git"),
		Ripgrep: hasBinary("rg"),
		Pty:     handlers.PtySupported() && !cfg.DisableShell,
		Shell:   !cfg.DisableShell,
		Features: []string{
			"transfer.upload-content-identity.v1",
			"pty.ready-stream.v1",
		},
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("starting executor: version=%s os=%s arch=%s git=%v rg=%v shell=%v cwd=%s",
		buildinfo.Version, platform.OS, platform.Arch, caps.Git, caps.Ripgrep, caps.Shell, cfg.DefaultCwd)

	if cfg.ListenAddr != "" {
		// Direct mode: listen for the NarraFork server to connect.
		server := transport.NewServer(cfg, dispatcher, platform, caps)
		if err := server.Run(ctx); err != nil && ctx.Err() == nil {
			log.Fatalf("fatal: %v", err)
		}
	} else {
		// Reverse-dial mode: connect out to the NarraFork server.
		client := transport.NewClient(cfg, dispatcher, platform, caps)
		if err := client.Run(ctx); err != nil && ctx.Err() == nil {
			log.Fatalf("fatal: %v", err)
		}
	}
	log.Printf("shutting down")
}

// toGuardRules converts validated config rules into guard rules. Config already
// rejected unknown actions, so anything not "deny" is an allow.
func toGuardRules(rules []config.PathRule) []handlers.PathRule {
	out := make([]handlers.PathRule, 0, len(rules))
	for _, rule := range rules {
		action := handlers.RuleAllow
		if rule.Action == "deny" {
			action = handlers.RuleDeny
		}
		out = append(out, handlers.PathRule{Action: action, Path: rule.Path})
	}
	return out
}

func hasBinary(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func shellPath() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/sh"
}
