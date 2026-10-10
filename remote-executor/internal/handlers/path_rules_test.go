package handlers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mustDir creates a directory tree under base and returns its path.
func mustDir(t *testing.T, base string, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{base}, parts...)...)
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %q: %v", path, err)
	}
	return path
}

func mustFile(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %q: %v", path, err)
	}
	return path
}

func assertAllowed(t *testing.T, guard *PathGuard, path string) {
	t.Helper()
	if _, err := guard.CheckExisting(path); err != nil {
		t.Fatalf("expected %q to be allowed, got error: %v", path, err)
	}
}

func assertDenied(t *testing.T, guard *PathGuard, path string) {
	t.Helper()
	if _, err := guard.CheckExisting(path); err == nil {
		t.Fatalf("expected %q to be refused, but it was allowed", path)
	}
}

// An empty rule list is the documented "unrestricted" state: it must not
// accidentally become deny-all, which would break every default install.
func TestNoRulesIsUnrestricted(t *testing.T) {
	base := t.TempDir()
	file := mustFile(t, base, "anywhere.txt")

	guard := NewPathGuardWithRules(nil)
	if !guard.Unrestricted() {
		t.Fatal("empty rule list should report unrestricted")
	}
	assertAllowed(t, guard, file)
}

// The ordered model must reproduce the old allow-root behavior exactly, or
// upgrading an installed executor would silently change its access.
func TestSingleAllowMatchesLegacyAllowRoot(t *testing.T) {
	base := t.TempDir()
	inside := mustDir(t, base, "work")
	insideFile := mustFile(t, inside, "a.txt")
	outside := mustDir(t, base, "other")
	outsideFile := mustFile(t, outside, "b.txt")

	rules := NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: inside}})
	legacy := NewPathGuard([]string{inside})

	for _, guard := range []*PathGuard{rules, legacy} {
		assertAllowed(t, guard, insideFile)
		assertDenied(t, guard, outsideFile)
	}
}

// The core of the requested feature: deny carves a hole out of allow, and a
// later allow re-opens an exception inside that hole, to arbitrary depth.
func TestLastMatchWinsThroughNestedExceptions(t *testing.T) {
	base := t.TempDir()
	projects := mustDir(t, base, "projects")
	secrets := mustDir(t, base, "projects", "secrets")
	public := mustDir(t, base, "projects", "secrets", "public")
	deeperDeny := mustDir(t, base, "projects", "secrets", "public", "private")

	openFile := mustFile(t, projects, "readme.md")
	secretFile := mustFile(t, secrets, "key.pem")
	publicFile := mustFile(t, public, "notice.txt")
	deepFile := mustFile(t, deeperDeny, "inner.key")

	guard := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: projects},
		{Action: RuleDeny, Path: secrets},
		{Action: RuleAllow, Path: public},
		{Action: RuleDeny, Path: deeperDeny},
	})

	assertAllowed(t, guard, openFile)
	assertDenied(t, guard, secretFile)
	assertAllowed(t, guard, publicFile)
	assertDenied(t, guard, deepFile)
}

// Order is the priority mechanism, so the same rule set in the opposite order
// must produce the opposite outcome. If this passes with both orders equal, the
// implementation silently degraded to deny-wins or longest-match.
func TestRuleOrderChangesTheOutcome(t *testing.T) {
	base := t.TempDir()
	projects := mustDir(t, base, "projects")
	secrets := mustDir(t, base, "projects", "secrets")
	secretFile := mustFile(t, secrets, "key.pem")

	denyLast := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: projects},
		{Action: RuleDeny, Path: secrets},
	})
	allowLast := NewPathGuardWithRules([]PathRule{
		{Action: RuleDeny, Path: secrets},
		{Action: RuleAllow, Path: projects},
	})

	assertDenied(t, denyLast, secretFile)
	assertAllowed(t, allowLast, secretFile)
}

// A restricted guard must default to refusing anything no rule mentions.
func TestUnmatchedPathIsRefusedWhenRestricted(t *testing.T) {
	base := t.TempDir()
	allowed := mustDir(t, base, "allowed")
	elsewhere := mustDir(t, base, "elsewhere")
	elsewhereFile := mustFile(t, elsewhere, "c.txt")

	guard := NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: allowed}})
	assertDenied(t, guard, elsewhereFile)
}

// A deny-only list must not become an implicit allow-everything-else.
func TestDenyOnlyListStillRefusesUnlistedPaths(t *testing.T) {
	base := t.TempDir()
	blocked := mustDir(t, base, "blocked")
	blockedFile := mustFile(t, blocked, "x.txt")
	other := mustDir(t, base, "other")
	otherFile := mustFile(t, other, "y.txt")

	guard := NewPathGuardWithRules([]PathRule{{Action: RuleDeny, Path: blocked}})
	assertDenied(t, guard, blockedFile)
	assertDenied(t, guard, otherFile)
}

// Dropping an unresolvable deny would widen access, so it must be retained and
// reported. An unresolvable allow may be dropped: that only narrows access.
func TestUnresolvableDenyIsKeptAndReported(t *testing.T) {
	// Keep the existing ancestor's identity canonical: the intended negative
	// case is a missing deny leaf, not an unrelated alias in the temp root.
	base := canonicalFixturePath(t, t.TempDir())
	root := mustDir(t, base, "root")
	missing := filepath.Join(root, "not-created-yet")

	guard := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: root},
		{Action: RuleDeny, Path: missing},
	})

	reported := guard.UnresolvedDenyRules()
	if len(reported) != 1 {
		t.Fatalf("expected the unresolved deny to be reported, got %#v", reported)
	}

	// Once the directory exists, the retained deny must actually block it rather
	// than having been silently discarded at construction time.
	if err := os.MkdirAll(missing, 0o755); err != nil {
		t.Fatal(err)
	}
	assertDenied(t, guard, mustFile(t, missing, "late.txt"))
	assertAllowed(t, guard, mustFile(t, root, "ok.txt"))
}

func TestUnresolvableAllowIsDroppedNotReported(t *testing.T) {
	base := t.TempDir()
	missing := filepath.Join(base, "never")

	guard := NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: missing}})
	if reported := guard.UnresolvedDenyRules(); len(reported) != 0 {
		t.Fatalf("allow rules must not be reported as unresolved denies: %#v", reported)
	}
	// Still restricted (a rule was supplied), and nothing resolves, so everything
	// is refused rather than falling open.
	if guard.Unrestricted() {
		t.Fatal("a supplied rule must keep the guard restricted even if it cannot resolve")
	}
	assertDenied(t, guard, mustFile(t, base, "elsewhere.txt"))
}

// A symlink pointing out of an allowed root must not escape, and a symlink into
// a denied subtree must not launder access to it.
func TestSymlinkCannotEscapeOrLaunderRules(t *testing.T) {
	base := t.TempDir()
	projects := mustDir(t, base, "projects")
	secrets := mustDir(t, base, "projects", "secrets")
	secretFile := mustFile(t, secrets, "key.pem")
	outside := mustDir(t, base, "outside")
	outsideFile := mustFile(t, outside, "loot.txt")

	escape := filepath.Join(projects, "escape")
	requireSymlink(t, outside, escape)
	launder := filepath.Join(projects, "launder")
	requireSymlink(t, secrets, launder)

	guard := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: projects},
		{Action: RuleDeny, Path: secrets},
	})

	assertDenied(t, guard, filepath.Join(escape, filepath.Base(outsideFile)))
	assertDenied(t, guard, filepath.Join(launder, filepath.Base(secretFile)))
}

// CheckCreate resolves the nearest existing ancestor, so a deny must still apply
// to a file that does not exist yet inside a denied subtree.
func TestCheckCreateRespectsDenyRules(t *testing.T) {
	base := t.TempDir()
	projects := mustDir(t, base, "projects")
	secrets := mustDir(t, base, "projects", "secrets")

	guard := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: projects},
		{Action: RuleDeny, Path: secrets},
	})

	if _, err := guard.CheckCreate(filepath.Join(projects, "new.txt")); err != nil {
		t.Fatalf("creating inside an allowed root should succeed: %v", err)
	}
	if _, err := guard.CheckCreate(filepath.Join(secrets, "new.pem")); err == nil {
		t.Fatal("creating inside a denied subtree must be refused")
	}
	if _, err := guard.CheckCreate(filepath.Join(secrets, "deep", "nested", "new.pem")); err == nil {
		t.Fatal("creating below a denied subtree must be refused")
	}
}

// CheckRemove must not let a swapped final symlink delete a denied target.
func TestCheckRemoveRespectsDenyRules(t *testing.T) {
	base := t.TempDir()
	projects := mustDir(t, base, "projects")
	secrets := mustDir(t, base, "projects", "secrets")
	mustFile(t, secrets, "key.pem")

	guard := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: projects},
		{Action: RuleDeny, Path: secrets},
	})

	if _, err := guard.CheckRemove(filepath.Join(secrets, "key.pem")); err == nil {
		t.Fatal("removing inside a denied subtree must be refused")
	}
}

// The deny error should name the rule that blocked the path; an operator staring
// at a long ordered list needs to know which entry fired.
func TestDenyErrorIdentifiesTheBlockingRule(t *testing.T) {
	base := t.TempDir()
	projects := mustDir(t, base, "projects")
	secrets := mustDir(t, base, "projects", "secrets")
	secretFile := mustFile(t, secrets, "key.pem")

	guard := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: projects},
		{Action: RuleDeny, Path: secrets},
	})

	_, err := guard.CheckExisting(secretFile)
	if err == nil {
		t.Fatal("expected a deny error")
	}
	resolvedSecrets, evalErr := filepath.EvalSymlinks(secrets)
	if evalErr != nil {
		t.Fatal(evalErr)
	}
	if !strings.Contains(err.Error(), resolvedSecrets) {
		t.Fatalf("deny error should name the blocking rule %q, got: %v", resolvedSecrets, err)
	}
}

// Duplicate rules are legal (an operator may re-add a path); the later one wins.
func TestDuplicatePathsResolveByOrder(t *testing.T) {
	base := t.TempDir()
	dir := mustDir(t, base, "dir")
	file := mustFile(t, dir, "f.txt")

	allowThenDeny := NewPathGuardWithRules([]PathRule{
		{Action: RuleAllow, Path: dir},
		{Action: RuleDeny, Path: dir},
	})
	denyThenAllow := NewPathGuardWithRules([]PathRule{
		{Action: RuleDeny, Path: dir},
		{Action: RuleAllow, Path: dir},
	})

	assertDenied(t, allowThenDeny, file)
	assertAllowed(t, denyThenAllow, file)
}
