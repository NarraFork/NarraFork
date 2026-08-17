package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// loadWithArgs runs Load with a synthetic argv, restoring the real one after.
func loadWithArgs(t *testing.T, args ...string) (*Config, error) {
	t.Helper()
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = append([]string{"narrafork-executor"}, args...)
	return Load()
}

// baseArgs are the minimum flags that satisfy Validate in direct mode.
func baseArgs(t *testing.T) []string {
	t.Helper()
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_path_rules_test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return []string{"--listen", "127.0.0.1:0", "--device", "d", "--token-file", tokenPath}
}

// Repeated --path-rule flags must keep their order: order is the priority model.
func TestPathRuleFlagsPreserveOrder(t *testing.T) {
	args := append(baseArgs(t),
		"--path-rule", "allow:/srv/work",
		"--path-rule", "deny:/srv/work/secrets",
		"--path-rule", "allow:/srv/work/secrets/public",
	)
	cfg, err := loadWithArgs(t, args...)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	want := []PathRule{
		{Action: "allow", Path: "/srv/work"},
		{Action: "deny", Path: "/srv/work/secrets"},
		{Action: "allow", Path: "/srv/work/secrets/public"},
	}
	if len(cfg.PathRules) != len(want) {
		t.Fatalf("got %d rules, want %d: %#v", len(cfg.PathRules), len(want), cfg.PathRules)
	}
	for i := range want {
		if cfg.PathRules[i] != want[i] {
			t.Fatalf("rule[%d] = %#v, want %#v", i, cfg.PathRules[i], want[i])
		}
	}
}

// Windows paths contain a colon, which must not be mistaken for the action
// separator: only the first colon splits.
func TestPathRuleAcceptsWindowsDriveLetters(t *testing.T) {
	rule, err := parsePathRule(`deny:C:\ProgramData\secrets`)
	if err != nil {
		t.Fatalf("windows path rule rejected: %v", err)
	}
	if rule.Action != "deny" || rule.Path != `C:\ProgramData\secrets` {
		t.Fatalf("parsed = %#v", rule)
	}
}

func TestPathRuleRejectsBadInput(t *testing.T) {
	cases := map[string]string{
		"no action prefix":  "/srv/work",
		"unknown action":    "maybe:/srv/work",
		"relative path":     "allow:work/projects",
		"empty path":        "allow:",
		"nul byte":          "allow:/srv/wo\x00rk",
		"bare windows path": `allow:C:relative`,
	}
	for name, input := range cases {
		if _, err := parsePathRule(input); err == nil {
			t.Errorf("%s: expected %q to be rejected", name, input)
		}
	}
}

// Supplying both sources is ambiguous about which one guards the executor, so it
// must fail loudly rather than silently picking one.
func TestAllowRootsAndPathRulesAreMutuallyExclusive(t *testing.T) {
	args := append(baseArgs(t),
		"--allow-root", "/srv/work",
		"--path-rule", "allow:/srv/other",
	)
	_, err := loadWithArgs(t, args...)
	if err == nil {
		t.Fatal("expected mutually-exclusive sources to be rejected")
	}
	if !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("error should explain the conflict, got: %v", err)
	}
}

// An executor installed before ordered rules must keep its exact behavior, so
// AllowRoots has to translate into an equivalent allow-only rule list.
func TestAllowRootsDowngradeToEquivalentAllowRules(t *testing.T) {
	cfg := &Config{AllowRoots: []string{"/srv/a", "/srv/b"}}
	got := cfg.EffectivePathRules()
	want := []PathRule{
		{Action: "allow", Path: "/srv/a"},
		{Action: "allow", Path: "/srv/b"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("rule[%d] = %#v, want %#v", i, got[i], want[i])
		}
	}
}

// PathRules must win when both are somehow present in a struct built in code
// (Validate rejects that combination, but EffectivePathRules must not be the
// thing that decides access by accident).
func TestPathRulesTakePrecedenceOverAllowRoots(t *testing.T) {
	cfg := &Config{
		AllowRoots: []string{"/srv/legacy"},
		PathRules:  []PathRule{{Action: "allow", Path: "/srv/modern"}},
	}
	got := cfg.EffectivePathRules()
	if len(got) != 1 || got[0].Path != "/srv/modern" {
		t.Fatalf("pathRules should win, got %#v", got)
	}
}

func TestEmptyConfigMeansUnrestricted(t *testing.T) {
	cfg := &Config{}
	if rules := cfg.EffectivePathRules(); len(rules) != 0 {
		t.Fatalf("expected no rules, got %#v", rules)
	}
}

// The config file is the channel the post-install UI writes through, so JSON
// round-tripping (including order) is part of the contract.
func TestPathRulesLoadFromConfigFileInOrder(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_cfg_file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.json")
	body, err := json.Marshal(map[string]any{
		"listenAddr": "127.0.0.1:0",
		"deviceRef":  "d",
		"pathRules": []map[string]string{
			{"action": "allow", "path": "/srv/work"},
			{"action": "deny", "path": "/srv/work/.ssh"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, body, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadWithArgs(t, "--config", configPath, "--token-file", tokenPath)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(cfg.PathRules) != 2 {
		t.Fatalf("got %#v", cfg.PathRules)
	}
	if cfg.PathRules[0].Action != "allow" || cfg.PathRules[1].Action != "deny" {
		t.Fatalf("order or actions wrong: %#v", cfg.PathRules)
	}
	if cfg.PathRules[1].Path != "/srv/work/.ssh" {
		t.Fatalf("path wrong: %#v", cfg.PathRules)
	}
}

// A malformed rule in the config file must stop startup rather than being
// dropped, which would leave the operator believing a deny is in force.
func TestMalformedConfigFileRuleFailsStartup(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_bad_rule\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.json")
	body := `{"listenAddr":"127.0.0.1:0","deviceRef":"d",` +
		`"pathRules":[{"action":"nope","path":"/srv/work"}]}`
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := loadWithArgs(t, "--config", configPath, "--token-file", tokenPath); err == nil {
		t.Fatal("expected a malformed rule to fail startup")
	}
}

// Flags override the config file for rules as they do for every other field.
func TestPathRuleFlagsOverrideConfigFile(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token.txt")
	if err := os.WriteFile(tokenPath, []byte("rdev_override\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.json")
	body := `{"listenAddr":"127.0.0.1:0","deviceRef":"d",` +
		`"pathRules":[{"action":"allow","path":"/srv/from-file"}]}`
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadWithArgs(t,
		"--config", configPath,
		"--token-file", tokenPath,
		"--path-rule", "deny:/srv/from-flag",
	)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(cfg.PathRules) != 1 || cfg.PathRules[0].Path != "/srv/from-flag" {
		t.Fatalf("flags should replace file rules, got %#v", cfg.PathRules)
	}
}

func TestPathRulesFromEnvironment(t *testing.T) {
	t.Setenv("NARRAFORK_EXECUTOR_PATH_RULES", "allow:/srv/work, deny:/srv/work/secrets")
	cfg, err := loadWithArgs(t, baseArgs(t)...)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(cfg.PathRules) != 2 {
		t.Fatalf("got %#v", cfg.PathRules)
	}
	if cfg.PathRules[0].Action != "allow" || cfg.PathRules[1].Action != "deny" {
		t.Fatalf("env order or actions wrong: %#v", cfg.PathRules)
	}
}

func TestTooManyPathRulesRejected(t *testing.T) {
	rules := make([]PathRule, 0, maxPathRules+1)
	for i := 0; i <= maxPathRules; i++ {
		rules = append(rules, PathRule{Action: "allow", Path: "/srv/work"})
	}
	cfg := &Config{ListenAddr: "127.0.0.1:0", DeviceRef: "d", Token: "t", PathRules: rules}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected an over-long rule list to be rejected")
	}
}

// Validate is also the guard for programmatically built configs, so a relative
// legacy allow-root must not slip through it either.
func TestValidateRejectsRelativeAllowRoot(t *testing.T) {
	cfg := &Config{
		ListenAddr: "127.0.0.1:0",
		DeviceRef:  "d",
		Token:      "t",
		AllowRoots: []string{"relative/dir"},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected a relative allow-root to be rejected")
	}
}
