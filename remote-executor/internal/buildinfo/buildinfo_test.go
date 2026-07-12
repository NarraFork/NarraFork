package buildinfo

import (
	"strings"
	"testing"
)

func TestStringIncludesInjectedFields(t *testing.T) {
	oldVersion, oldCommit, oldBuildTime := Version, Commit, BuildTime
	Version, Commit, BuildTime = "1.2.3", "abc123", "2026-01-02T03:04:05Z"
	t.Cleanup(func() {
		Version, Commit, BuildTime = oldVersion, oldCommit, oldBuildTime
	})

	got := String()
	for _, want := range []string{"1.2.3", "abc123", "2026-01-02T03:04:05Z"} {
		if !strings.Contains(got, want) {
			t.Fatalf("String() = %q, missing %q", got, want)
		}
	}
}
