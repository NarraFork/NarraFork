package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/narrafork/remote-executor/internal/config"
)

// Two registrations never share a session directory, even with the same device
// name in the same state directory; one registration always gets the same one.
func TestSessionStateDirIsPerRegistration(t *testing.T) {
	base := t.TempDir()
	dir := func(server, listen, device string) string {
		t.Helper()
		got, err := sessionStateDir(&config.Config{StateDir: base, ServerURL: server, ListenAddr: listen, DeviceRef: device})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	a := dir("wss://one.example/ws/device", "", "laptop")
	if a != dir("wss://one.example/ws/device", "", "laptop") {
		t.Fatal("the same registration must keep its directory")
	}
	for _, other := range []string{
		dir("wss://two.example/ws/device", "", "laptop"),
		dir("", "127.0.0.1:7900", "laptop"),
		dir("wss://one.example/ws/device", "", "desktop"),
	} {
		if other == a {
			t.Fatalf("registrations share %q", a)
		}
	}
	if !strings.HasPrefix(a, filepath.Join(base, "laptop-")) || filepath.Base(a) != "sessions" {
		t.Fatalf("unexpected layout %q", a)
	}
	if odd := dir("wss://one.example", "", "../x y"); !strings.HasPrefix(odd, filepath.Join(base, "___x_y-")) {
		t.Fatalf("device name not confined to one path element: %q", odd)
	}
}

// systemd's STATE_DIRECTORY is a default: it is used when nothing is configured
// and never replaces an explicit state directory.
func TestSessionStateDirUsesSystemdStateDirectoryOnlyAsDefault(t *testing.T) {
	managed := t.TempDir()
	t.Setenv("STATE_DIRECTORY", managed+":/ignored")
	got, err := sessionStateDir(&config.Config{DeviceRef: "laptop"})
	if err != nil || !strings.HasPrefix(got, filepath.Join(managed, "laptop-")) {
		t.Fatalf("systemd default not used: %q, %v", got, err)
	}
	explicit := t.TempDir()
	got, err = sessionStateDir(&config.Config{StateDir: explicit, DeviceRef: "laptop"})
	if err != nil || !strings.HasPrefix(got, filepath.Join(explicit, "laptop-")) {
		t.Fatalf("explicit stateDir replaced: %q, %v", got, err)
	}
}
