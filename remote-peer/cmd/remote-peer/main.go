package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"

	remotepeer "narrafork/remote-peer"
	"narrafork/remote-peer/internal/buildinfo"
)

type versionInfo struct {
	Version         string `json:"version"`
	Commit          string `json:"commit"`
	BuildTime       string `json:"buildTime"`
	ProtocolVersion int    `json:"protocolVersion"`
	GoVersion       string `json:"goVersion"`
}

// versionCommand accepts only version queries. Never echo untrusted arguments:
// they may contain a token accidentally supplied on the command line.
func versionCommand(args []string, stdout, stderr io.Writer) int {
	version, jsonOutput := false, false
	for _, arg := range args {
		switch {
		case arg == "--version" && !version:
			version = true
		case arg == "--json" && !jsonOutput:
			jsonOutput = true
		default:
			_, _ = fmt.Fprintln(stderr, "remote-peer: invalid arguments; use --version [--json]")
			return 2
		}
	}
	if !version {
		_, _ = fmt.Fprintln(stderr, "remote-peer: --json requires --version")
		return 2
	}
	info := versionInfo{buildinfo.Version, buildinfo.Commit, buildinfo.BuildTime, remotepeer.ProtocolVersion, runtime.Version()}
	var err error
	if jsonOutput {
		err = json.NewEncoder(stdout).Encode(info)
	} else {
		_, err = fmt.Fprintf(stdout, "narrafork-remote-peer %s (commit %s, built %s, protocol %d, %s)\n", info.Version, info.Commit, info.BuildTime, info.ProtocolVersion, info.GoVersion)
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "remote-peer: version output failed")
		return 1
	}
	return 0
}

func main() {
	// This must precede stdin/config parsing, identity state and network setup.
	if len(os.Args) > 1 {
		os.Exit(versionCommand(os.Args[1:], os.Stdout, os.Stderr))
	}
	var mu sync.Mutex
	emit := func(v any) {
		b, e := json.Marshal(v)
		if e != nil || len(b) > 8192 {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_, _ = os.Stdout.Write(append(b, '\n'))
	}
	fail := func(code string) { emit(map[string]any{"type": "error", "code": code}) }
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 8192), 16384)
	if !scan.Scan() {
		fail("config_missing")
		return
	}
	var cfg remotepeer.Config
	if json.Unmarshal(scan.Bytes(), &cfg) != nil {
		fail("config_invalid")
		return
	}
	r, e := remotepeer.New(cfg, emit)
	if e != nil {
		fail("config_rejected")
		return
	}
	if e = r.Ready(); e != nil {
		fail("state_failed")
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		for scan.Scan() {
			var cmd struct {
				Type    string `json:"type"`
				GrantID string `json:"grantId"`
				Token   string `json:"token"`
			}
			if json.Unmarshal(scan.Bytes(), &cmd) != nil {
				fail("command_invalid")
				cancel()
				return
			}
			switch cmd.Type {
			case "shutdown":
				cancel()
				return
			case "revoke-session":
				if r.InvalidateSession(cmd.Token) != nil {
					fail("command_invalid")
				} else {
					emit(map[string]any{"type": "status", "code": "session_invalidated"})
				}
			case "revoke":
				if cmd.GrantID == "" || len(cmd.GrantID) > 128 {
					fail("command_invalid")
					continue
				}
				if r.Revoke(cmd.GrantID) != nil {
					fail("revoke_failed")
				} else {
					emit(map[string]any{"type": "status", "code": "revoked"})
				}
			default:
				fail("command_invalid")
			}
		}
		cancel()
	}()
	r.Run(ctx)
}
