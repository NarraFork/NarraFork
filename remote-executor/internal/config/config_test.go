package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ── token-file tests ──────────────────────────────────────────────────────────

func TestLoadTokenFromFile(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token.txt")
	want := "rdev_from_file_test"
	if err := os.WriteFile(tokenPath, []byte(want+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Restore OS args when done.
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-file", tokenPath,
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Token != want {
		t.Errorf("token = %q, want %q", cfg.Token, want)
	}
}

func TestLoadTokenFromStdin(t *testing.T) {
	want := "rdev_from_stdin_test"

	// Write to a temp file and make the test treat it as stdin.
	dir := t.TempDir()
	stdinFile := filepath.Join(dir, "fake_stdin")
	if err := os.WriteFile(stdinFile, []byte("  "+want+"  \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(stdinFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	origStdin := os.Stdin
	os.Stdin = f
	t.Cleanup(func() { os.Stdin = origStdin })

	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-file", "-",
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Token != want {
		t.Errorf("token = %q, want %q", cfg.Token, want)
	}
}

func TestLoadTokenFromExplicitStdinFlag(t *testing.T) {
	want := "rdev_explicit_stdin"
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "rdev_lower_environment")
	dir := t.TempDir()
	stdinPath := filepath.Join(dir, "stdin-token")
	if err := os.WriteFile(stdinPath, []byte(want+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdin, err := os.Open(stdinPath)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	origStdin := os.Stdin
	os.Stdin = stdin
	t.Cleanup(func() { os.Stdin = origStdin })
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-stdin",
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Token != want || !cfg.TokenStdin {
		t.Fatalf("token=%q tokenStdin=%v, want %q/true", cfg.Token, cfg.TokenStdin, want)
	}
}

func TestConflictingTokenFlagsRejected(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_from_file\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token", "rdev_flag",
		"--token-file", tokenPath,
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "multiple token sources") {
		t.Fatalf("expected conflicting token source error, got: %v", err)
	}
}

func TestTokenFileEnvVar(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token_env.txt")
	want := "rdev_env_file"
	if err := os.WriteFile(tokenPath, []byte(want), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_FILE", tokenPath)
	// Clear any token env so the file is consulted.
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "")

	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Token != want {
		t.Errorf("token = %q, want %q", cfg.Token, want)
	}
}

func TestTokenStdinEnvironmentVariable(t *testing.T) {
	want := "rdev_env_stdin"
	dir := t.TempDir()
	stdinPath := filepath.Join(dir, "env-stdin")
	if err := os.WriteFile(stdinPath, []byte(want), 0o600); err != nil {
		t.Fatal(err)
	}
	stdin, err := os.Open(stdinPath)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	origStdin := os.Stdin
	os.Stdin = stdin
	t.Cleanup(func() { os.Stdin = origStdin })
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_FILE", "")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_STDIN", "true")
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Token != want || !cfg.TokenStdin {
		t.Fatalf("token=%q tokenStdin=%v, want %q/true", cfg.Token, cfg.TokenStdin, want)
	}
}

func TestTokenFileFlagOverridesEnvironmentToken(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "flag-token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_flag_file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "rdev_lower_env")
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-file", tokenPath,
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Token != "rdev_flag_file" {
		t.Fatalf("token=%q, want flag token-file value", cfg.Token)
	}
}

func TestEnvironmentTokenFileOverridesConfigToken(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte(`{
		"listenAddr":"127.0.0.1:0",
		"deviceRef":"test-device",
		"token":"rdev_config_literal"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	tokenPath := filepath.Join(dir, "env-token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_env_file_wins"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_FILE", tokenPath)
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor", "--config", configPath}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.Token != "rdev_env_file_wins" {
		t.Fatalf("token=%q, want environment token-file value", cfg.Token)
	}
}

func TestConflictingEnvironmentTokenSourcesRejected(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "env-token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_env_file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "rdev_env_literal")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_FILE", tokenPath)
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "multiple token sources") {
		t.Fatalf("expected environment token source conflict, got: %v", err)
	}
}

func TestConflictingConfigTokenSourcesRejected(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte(`{
		"listenAddr":"127.0.0.1:0",
		"deviceRef":"test-device",
		"token":"rdev_config_literal",
		"tokenFile":"/unused/token-file"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_FILE", "")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_STDIN", "")
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor", "--config", configPath}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "config file specifies multiple token sources") {
		t.Fatalf("expected config-file token source conflict, got: %v", err)
	}
}

func TestTokenFileMissing(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-file", "/nonexistent/path/token.txt",
	}

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for missing token file, got nil")
	}
	if !strings.Contains(err.Error(), "token-file") {
		t.Errorf("error does not mention token-file: %v", err)
	}
}

func TestTokenFileEmpty(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "empty.txt")
	if err := os.WriteFile(tokenPath, []byte("   \n"), 0o600); err != nil {
		t.Fatal(err)
	}

	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-file", tokenPath,
	}

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for empty token file, got nil")
	}
}

func TestTokenFileRejectsOverlyOpenPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows permissions are ACL-based")
	}
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "open-token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_open"), 0o644); err != nil {
		t.Fatal(err)
	}
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-file", tokenPath,
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("expected restrictive permission error, got: %v", err)
	}
}

func TestTokenFileRejectsOversizedSecret(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "large-token.txt")
	if err := os.WriteFile(tokenPath, []byte(strings.Repeat("x", maxTokenBytes+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "test-device",
		"--token-file", tokenPath,
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected token size error, got: %v", err)
	}
}

// ── TLS parameter validation tests ───────────────────────────────────────────

func TestTLSCertAndKeyMustBeSuppliedTogether(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	// Only cert, no key.
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "d",
		"--token", "rdev_t",
		"--tls-cert", "/some/cert.pem",
	}
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "together") {
		t.Fatalf("expected 'together' error, got: %v", err)
	}

	// Only key, no cert.
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "d",
		"--token", "rdev_t",
		"--tls-key", "/some/key.pem",
	}
	_, err = Load()
	if err == nil || !strings.Contains(err.Error(), "together") {
		t.Fatalf("expected 'together' error, got: %v", err)
	}
}

// ── loopback / non-loopback TLS enforcement tests ────────────────────────────

func TestNonLoopbackListenRequiresTLS(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	// Binding to 0.0.0.0 without TLS must be rejected.
	os.Args = []string{"narrafork-executor",
		"--listen", "0.0.0.0:9000",
		"--device", "d",
		"--token", "rdev_t",
	}
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for non-loopback listener without TLS, got nil")
	}
	if !strings.Contains(err.Error(), "non-loopback") && !strings.Contains(err.Error(), "tls-cert") {
		t.Errorf("error does not mention non-loopback or tls-cert: %v", err)
	}
}

func TestNonLoopbackWildcardListenRequiresTLS(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	// ":port" binds on all interfaces and must require TLS.
	os.Args = []string{"narrafork-executor",
		"--listen", ":9001",
		"--device", "d",
		"--token", "rdev_t",
	}
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for wildcard listener without TLS, got nil")
	}
}

func TestHostnameListenRequiresTLSEvenWhenNamedLocalhost(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "localhost:9001",
		"--device", "d",
		"--token", "rdev_t",
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "loopback IP literal") {
		t.Fatalf("expected hostname listener to require TLS, got: %v", err)
	}
}

func TestInvalidListenAddressRejected(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1",
		"--device", "d",
		"--token", "rdev_t",
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "invalid direct listen address") {
		t.Fatalf("expected invalid listen address error, got: %v", err)
	}
}

func TestDirectModeRejectsInsecureClientFlag(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "d",
		"--token", "rdev_t",
		"--insecure",
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "reverse-dial") {
		t.Fatalf("expected direct-mode insecure flag error, got: %v", err)
	}
}

func TestLoopbackListenAllowedWithoutTLS(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	// 127.0.0.1 is loopback — no TLS required.
	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "d",
		"--token", "rdev_t",
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("loopback listen should not require TLS, got: %v", err)
	}
	if cfg.TLSCert != "" {
		t.Errorf("unexpected TLSCert: %q", cfg.TLSCert)
	}
}

func TestLoopbackIPv6ListenAllowedWithoutTLS(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	os.Args = []string{"narrafork-executor",
		"--listen", "[::1]:0",
		"--device", "d",
		"--token", "rdev_t",
	}
	if _, err := Load(); err != nil {
		t.Fatalf("[::1] loopback should not require TLS, got: %v", err)
	}
}

func TestNonLoopbackListenWithTLSAccepted(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	// Non-loopback with both cert+key should pass validation (file existence is
	// checked later when the listener starts, not during Load).
	os.Args = []string{"narrafork-executor",
		"--listen", "0.0.0.0:9002",
		"--device", "d",
		"--token", "rdev_t",
		"--tls-cert", "/some/cert.pem",
		"--tls-key", "/some/key.pem",
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("non-loopback with TLS should pass validation, got: %v", err)
	}
	if cfg.TLSCert == "" || cfg.TLSKey == "" {
		t.Error("TLSCert/TLSKey should be set")
	}
}

func TestTLSSettingsFromEnvironment(t *testing.T) {
	t.Setenv("NARRAFORK_EXECUTOR_LISTEN", "0.0.0.0:9003")
	t.Setenv("NARRAFORK_EXECUTOR_DEVICE", "d")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN", "rdev_t")
	t.Setenv("NARRAFORK_EXECUTOR_TOKEN_FILE", "")
	t.Setenv("NARRAFORK_EXECUTOR_TLS_CERT", "/env/cert.pem")
	t.Setenv("NARRAFORK_EXECUTOR_TLS_KEY", "/env/key.pem")
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"narrafork-executor"}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("environment TLS config rejected: %v", err)
	}
	if cfg.TLSCert != "/env/cert.pem" || cfg.TLSKey != "/env/key.pem" {
		t.Fatalf("unexpected TLS env values: cert=%q key=%q", cfg.TLSCert, cfg.TLSKey)
	}
}

// ── IsListenLoopback tests ────────────────────────────────────────────────────

func TestIsListenLoopback(t *testing.T) {
	cases := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:7900", true},
		{"127.0.0.2:7900", true},
		{"[::1]:7900", true},
		{"localhost:7900", false},
		{"0.0.0.0:7900", false},
		{":7900", false},
		{"192.168.1.1:7900", false},
		{"127.0.0.1", false},
	}
	for _, tc := range cases {
		c := &Config{ListenAddr: tc.addr}
		got := c.IsListenLoopback()
		if got != tc.want {
			t.Errorf("IsListenLoopback(%q) = %v, want %v", tc.addr, got, tc.want)
		}
	}
}

// ── disable-shell config test ─────────────────────────────────────────────────

func TestDisableShellFlag(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	os.Args = []string{"narrafork-executor",
		"--listen", "127.0.0.1:0",
		"--device", "d",
		"--token", "rdev_t",
		"--disable-shell",
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if !cfg.DisableShell {
		t.Error("DisableShell should be true")
	}
}
