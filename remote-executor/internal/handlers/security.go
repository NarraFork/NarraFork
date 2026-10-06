package handlers

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
	rules      []resolvedRule
	restricted bool
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
		resolved, err := filepath.EvalSymlinks(abs)
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
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
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

	if resolved, evalErr := filepath.EvalSymlinks(abs); evalErr == nil {
		return g.checkResolved(filepath.Clean(resolved))
	} else if !errors.Is(evalErr, fs.ErrNotExist) {
		return "", fmt.Errorf("resolve path %q: %w", abs, evalErr)
	}

	ancestor := abs
	missing := make([]string, 0, 4)
	for {
		if _, statErr := os.Lstat(ancestor); statErr == nil {
			resolved, resolveErr := filepath.EvalSymlinks(ancestor)
			if resolveErr != nil {
				return "", fmt.Errorf("resolve path ancestor %q: %w", ancestor, resolveErr)
			}
			resolved, resolveErr = g.checkResolved(filepath.Clean(resolved))
			if resolveErr != nil {
				return "", resolveErr
			}
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return filepath.Clean(resolved), nil
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return "", fmt.Errorf("inspect path ancestor %q: %w", ancestor, statErr)
		}

		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", fmt.Errorf("path %q has no existing ancestor", abs)
		}
		missing = append(missing, filepath.Base(ancestor))
		ancestor = parent
	}
}

// CheckRemove validates the directory entry that will be removed without
// following a final symlink. The parent is canonicalized and checked first, so a
// swapped symlink is unlinked rather than deleting its target.
func (g *PathGuard) CheckRemove(path string) (string, error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", err
	}
	parent, err := g.CheckExisting(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	return g.checkResolved(filepath.Clean(filepath.Join(parent, filepath.Base(abs))))
}

// Check retains the original API and applies the stricter existing-path check.
func (g *PathGuard) Check(path string) (string, error) {
	return g.CheckExisting(path)
}

func (g *PathGuard) checkResolved(path string) (string, error) {
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
