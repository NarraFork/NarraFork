package handlers

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// RuleAction selects whether a matching PathRule permits or refuses a path.
type RuleAction string

const (
	RuleAllow RuleAction = "allow"
	RuleDeny  RuleAction = "deny"
)

// PathRule is one entry in an ordered allow/deny list.
type PathRule struct {
	Action RuleAction
	Path   string
}

type resolvedRule struct {
	action RuleAction
	root   string
	// unresolved marks a rule whose path could not be canonicalized (typically it
	// does not exist yet). Kept only for deny rules: dropping a deny would silently
	// widen access, while dropping an allow only ever narrows it.
	unresolved bool
}

// PathGuard restricts structured filesystem, transfer, and search paths plus
// Git/command working directories using an ordered allow/deny rule list. Rules and
// requested paths are resolved through symlinks and Windows junctions before
// containment checks.
//
// Evaluation is last-match-wins: rules are scanned from the end, and the first
// rule that contains the path decides. This lets a deny carve a hole out of an
// allow, and a later allow re-open an exception inside that deny, to any depth.
// A path matching no rule at all is refused.
//
// PathGuard is a request-path guard, not an OS sandbox: shell/PTY command text is
// intentionally opaque, and a hostile local process can still race filesystem
// names after validation. Use --disable-shell plus OS-level isolation when the
// executor must run across a hard trust boundary.
type PathGuard struct {
	rules        []resolvedRule
	restricted   bool
	privateMu    sync.RWMutex
	privateRoots []string
}

var errExecutorPrivatePath = errors.New("executor private state is not accessible through structured filesystem operations")

// These roots are executor-owned state, not operator-configurable allow/deny
// rules. They stay denied even after a later broad allow or an unrestricted guard.
// The engine supplies already canonical roots; raw requests are checked before
// and after resolution so lexical paths and symlink/junction aliases are covered.
func (g *PathGuard) protectPrivateRoot(root string) {
	g.privateMu.Lock()
	defer g.privateMu.Unlock()
	for _, existing := range g.privateRoots {
		if samePath(root, existing) {
			return
		}
	}
	g.privateRoots = append(g.privateRoots, filepath.Clean(root))
}
func (g *PathGuard) privatePath(path string) bool {
	g.privateMu.RLock()
	defer g.privateMu.RUnlock()
	for _, root := range g.privateRoots {
		if pathWithin(root, path) || runtime.GOOS == "windows" && strings.HasPrefix(strings.ToLower(filepath.Clean(path)), strings.ToLower(root)+":") {
			return true
		}
	}
	return false
}
func (g *PathGuard) privateRootsWithin(path string) []string {
	g.privateMu.RLock()
	defer g.privateMu.RUnlock()
	var roots []string
	for _, root := range g.privateRoots {
		if pathWithin(path, root) {
			roots = append(roots, root)
		}
	}
	return roots
}
func (g *PathGuard) hasPrivateRoots() bool {
	g.privateMu.RLock()
	defer g.privateMu.RUnlock()
	return len(g.privateRoots) > 0
}

// Legacy git.diff accepts file operands (including --no-index and --output).
// Protect internal paths there too without treating revision names as FS grants.
func (g *PathGuard) checkPrivateArgument(cwd, arg string) error {
	if !g.hasPrivateRoots() {
		return nil
	}
	values := []string{arg}
	if _, value, ok := strings.Cut(arg, "="); ok {
		values = append(values, value)
	}
	if strings.HasPrefix(arg, "-O") && len(arg) > 2 {
		values = append(values, arg[2:])
	}
	for _, value := range values {
		if value == "" {
			continue
		}
		candidate := value
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(cwd, candidate)
		}
		if g.privatePath(candidate) || len(g.privateRootsWithin(candidate)) > 0 {
			return errExecutorPrivatePath
		}
		resolved, err := g.CheckCreate(candidate)
		if errors.Is(err, errExecutorPrivatePath) {
			return err
		}
		if err == nil && len(g.privateRootsWithin(resolved)) > 0 {
			return errExecutorPrivatePath
		}
		if err != nil && filepath.IsAbs(value) {
			return err
		}
	}
	return nil
}

// NewPathGuard builds a guard from allow-only roots. Retained for callers (and
// configs) that predate ordered rules; equivalent to one allow rule per root.
func NewPathGuard(roots []string) *PathGuard {
	rules := make([]PathRule, 0, len(roots))
	for _, root := range roots {
		rules = append(rules, PathRule{Action: RuleAllow, Path: root})
	}
	return NewPathGuardWithRules(rules)
}

// NewPathGuardWithRules builds a guard from an ordered allow/deny list. An empty
// list means unrestricted. Rules whose paths cannot be canonicalized are dropped
// when they allow (fail closed) and kept literally when they deny (fail closed).
func NewPathGuardWithRules(rules []PathRule) *PathGuard {
	guard := &PathGuard{
		rules:      make([]resolvedRule, 0, len(rules)),
		restricted: len(rules) > 0,
	}
	for _, rule := range rules {
		abs, err := absolutePath(rule.Path)
		if err != nil {
			// An unusable deny must not vanish: keep the raw text so it still
			// blocks its own literal subtree.
			if rule.Action == RuleDeny {
				guard.rules = append(guard.rules, resolvedRule{
					action:     RuleDeny,
					root:       filepath.Clean(rule.Path),
					unresolved: true,
				})
			}
			continue
		}
		resolved, err := canonicalGuardPath(abs)

		if err != nil {
			if rule.Action == RuleDeny {
				guard.rules = append(guard.rules, resolvedRule{
					action:     RuleDeny,
					root:       abs,
					unresolved: true,
				})
			}
			continue
		}
		guard.rules = append(guard.rules, resolvedRule{
			action: rule.Action,
			root:   filepath.Clean(resolved),
		})
	}
	return guard
}

// UnresolvedDenyRules lists deny rules whose paths could not be canonicalized.
// They still block their literal subtree, but a symlinked or later-created path
// may bypass them, so startup should surface them to the operator.
func (g *PathGuard) UnresolvedDenyRules() []string {
	var out []string
	for _, rule := range g.rules {
		if rule.unresolved {
			out = append(out, rule.root)
		}
	}
	return out
}

// CheckExisting resolves all symlinks and supported Windows reparse points
// (including junctions) in an existing path, then verifies that the resulting
// path remains within an allowed root.
func (g *PathGuard) CheckExisting(path string) (string, error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", err
	}
	if g.privatePath(abs) {
		return "", errExecutorPrivatePath
	}
	resolved, err := canonicalGuardPath(abs)
	if err != nil {
		if g.hasPrivateRoots() && errors.Is(err, fs.ErrNotExist) {
			if _, createErr := g.CheckCreate(abs); errors.Is(createErr, errExecutorPrivatePath) {
				return "", errExecutorPrivatePath
			}
		}
		return "", fmt.Errorf("resolve path %q: %w", abs, err)
	}
	return g.checkResolved(filepath.Clean(resolved))
}

// CheckCreate validates a path that may not exist yet. It resolves the nearest
// existing ancestor through symlinks/junctions, verifies that ancestor is still
// inside an allowed root, then rebuilds the missing suffix below the ancestor's
// canonical path.
func (g *PathGuard) CheckCreate(path string) (string, error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", err
	}
	if g.privatePath(abs) {
		return "", errExecutorPrivatePath
	}
	resolved, ancestor, err := canonicalGuardCreatePath(abs)
	if err != nil {
		return "", err
	}
	// Keep the existing ancestor grant ceiling, then check the rebuilt target.
	if _, err = g.checkResolved(ancestor); err != nil {
		return "", err
	}
	return g.checkResolved(resolved)
}

// Shared by create validation AND private-root reservation. In particular a
// missing Darwin suffix must inherit the native spelling of its nearest live
// ancestor, not the caller's differently-cased spelling on an APFS CI volume.
func canonicalGuardCreatePath(path string) (resolved, existingAncestor string, err error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", "", err
	}
	if canonical, err := canonicalGuardPath(abs); err == nil {
		return filepath.Clean(canonical), filepath.Clean(canonical), nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", "", fmt.Errorf("resolve path %q: %w", abs, err)
	}
	ancestor := abs
	missing := make([]string, 0, 4)
	for {
		if _, statErr := os.Lstat(ancestor); statErr == nil {
			canonical, err := canonicalGuardPath(ancestor)
			if err != nil {
				return "", "", fmt.Errorf("resolve path ancestor %q: %w", ancestor, err)
			}
			parent := filepath.Clean(canonical)
			resolved = parent
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return filepath.Clean(resolved), parent, nil
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return "", "", fmt.Errorf("inspect path ancestor %q: %w", ancestor, statErr)
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", "", fmt.Errorf("path %q has no existing ancestor", abs)
		}
		missing = append(missing, filepath.Base(ancestor))
		ancestor = parent
	}
}

// CheckRemove returns the directory entry to unlink, not a symlink's referent.
// Native final spelling is consulted only for the non-overridable private policy;
// ordinary links still unlink their own entry rather than deleting their target.
func (g *PathGuard) CheckRemove(path string) (string, error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", err
	}
	if g.privatePath(abs) {
		return "", errExecutorPrivatePath
	}
	parent, err := g.CheckExisting(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	entry := filepath.Clean(filepath.Join(parent, filepath.Base(abs)))
	// Keep unlink-by-entry semantics, but consult native spelling for private
	// final directories too (not just their parents on a Darwin CI volume).
	if g.hasPrivateRoots() {
		if canonical, err := canonicalGuardPath(entry); err == nil && g.privatePath(canonical) {
			return "", errExecutorPrivatePath
		}
	}
	return g.checkResolved(entry)
}

// Check retains the original API and applies the stricter existing-path check.
func (g *PathGuard) Check(path string) (string, error) {
	return g.CheckExisting(path)
}

func (g *PathGuard) checkResolved(path string) (string, error) {
	if g.privatePath(path) {
		return "", errExecutorPrivatePath
	}
	if !g.restricted {
		return path, nil
	}
	// Last match wins, so scan backwards and stop at the first containing rule.
	for i := len(g.rules) - 1; i >= 0; i-- {
		if !pathWithin(g.rules[i].root, path) {
			continue
		}
		if g.rules[i].action == RuleDeny {
			return "", fmt.Errorf("path %q is blocked by a deny rule (%s)", path, g.rules[i].root)
		}
		return path, nil
	}
	return "", fmt.Errorf("path %q matches no allow rule", path)
}

func absolutePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}
	return filepath.Clean(abs), nil
}

func pathWithin(root, path string) bool {
	comparisonRoot := filepath.Clean(root)
	comparisonPath := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		comparisonRoot = strings.ToLower(comparisonRoot)
		comparisonPath = strings.ToLower(comparisonPath)
	}
	rel, err := filepath.Rel(comparisonRoot, comparisonPath)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

// Unrestricted reports whether the operator supplied no allow roots.
func (g *PathGuard) Unrestricted() bool {
	return !g.restricted
}
