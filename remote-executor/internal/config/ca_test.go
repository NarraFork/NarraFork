package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadCAFile(t *testing.T) {
	for _, name := range []string{
		"CONFIG", "SERVER", "DEVICE", "TOKEN", "TOKEN_FILE", "TOKEN_STDIN",
		"LISTEN", "TLS_CERT", "TLS_KEY", "ALLOW_ROOTS", "PATH_RULES", "DISABLE_SHELL",
	} {
		t.Setenv("NARRAFORK_EXECUTOR_"+name, "")
	}
	originalArgs := os.Args
	t.Cleanup(func() { os.Args = originalArgs })
	dir := t.TempDir()
	configPath := filepath.Join(dir, "executor.json")
	if err := os.WriteFile(filepath.Join(dir, "token.txt"), []byte("rdev_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		file Config
		args []string
		want string
		err  string
	}{
		{name: "installer relative path", file: Config{CAFile: "server-ca.pem"}, want: filepath.Join(dir, "server-ca.pem")},
		{name: "existing direct TLS paths stay relative to cwd", file: Config{ListenAddr: "127.0.0.1:0", TLSCert: "server.pem", TLSKey: "server.key"}},
		{name: "absolute path", file: Config{CAFile: filepath.Join(dir, "absolute.pem")}, want: filepath.Join(dir, "absolute.pem")},
		{name: "CLI overrides JSON relative to cwd", file: Config{CAFile: "server-ca.pem"}, args: []string{"--ca-file", "cli.pem"}, want: "cli.pem"},
		{name: "CLI absolute path", args: []string{"--ca-file", filepath.Join(dir, "cli.pem")}, want: filepath.Join(dir, "cli.pem")},
		{name: "empty CLI", args: []string{"--ca-file", ""}, err: "must not be empty"},
		{name: "insecure conflict", file: Config{CAFile: "server-ca.pem"}, args: []string{"--insecure"}, err: "mutually exclusive"},
		{name: "CLI CA conflicts with JSON insecure", file: Config{InsecureSkipVerify: true}, args: []string{"--ca-file", "cli.pem"}, err: "mutually exclusive"},
		{name: "CLI can disable JSON insecure", file: Config{InsecureSkipVerify: true}, args: []string{"--insecure=false", "--ca-file", "cli.pem"}, want: "cli.pem"},
		{name: "plaintext rejected", file: Config{CAFile: "server-ca.pem", ServerURL: "ws://localhost/ws/device"}, err: "requires a wss://"},
		{name: "direct rejected", file: Config{CAFile: "server-ca.pem", ListenAddr: "127.0.0.1:0"}, err: "not direct listeners"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := tc.file
			if cfg.ServerURL == "" {
				cfg.ServerURL = "wss://localhost/ws/device"
			}
			cfg.DeviceRef, cfg.TokenFile = "test-device", filepath.Join(dir, "token.txt")
			data, err := json.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(configPath, data, 0o600); err != nil {
				t.Fatal(err)
			}
			os.Args = append([]string{"narrafork-executor", "--config", configPath}, tc.args...)
			loaded, err := Load()
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("Load error = %v; want %q", err, tc.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if loaded.CAFile != tc.want || loaded.Token != "rdev_test" || loaded.TokenFile != filepath.Join(dir, "token.txt") {
				t.Fatalf("unexpected resolved config: %+v", loaded)
			}
			if loaded.TLSCert != tc.file.TLSCert || loaded.TLSKey != tc.file.TLSKey {
				t.Fatalf("existing direct TLS paths must not be reinterpreted: %+v", loaded)
			}
		})
	}
	t.Run("CLI without config", func(t *testing.T) {
		os.Args = []string{"narrafork-executor", "--server", "wss://localhost/ws/device", "--device", "d", "--token", "rdev_test", "--ca-file", "cli.pem"}
		cfg, err := Load()
		if err != nil || cfg.CAFile != "cli.pem" {
			t.Fatalf("standalone --ca-file failed: cfg=%+v err=%v", cfg, err)
		}
	})
	t.Run("relative config filename", func(t *testing.T) {
		if err := os.WriteFile(configPath, []byte(`{"serverUrl":"wss://localhost/ws/device","deviceRef":"d","token":"rdev_test","caFile":"server-ca.pem"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		cwd, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		relative, err := filepath.Rel(cwd, configPath)
		if err != nil {
			t.Skipf("config is on a different volume: %v", err)
		}
		os.Args = []string{"narrafork-executor", "--config", relative}
		cfg, err := Load()
		if err != nil || cfg.CAFile != filepath.Join(dir, "server-ca.pem") {
			t.Fatalf("relative config filename failed: cfg=%+v err=%v", cfg, err)
		}
	})
}

func TestResolveConfigPath(t *testing.T) {
	base := t.TempDir()
	for _, tc := range []struct{ path, want string }{
		{"", ""},
		{"  server-ca.pem  ", filepath.Join(base, "server-ca.pem")},
		{filepath.Join(base, "absolute.pem"), filepath.Join(base, "absolute.pem")},
	} {
		if got := resolveConfigPath(base, tc.path); got != tc.want {
			t.Errorf("resolveConfigPath(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}
