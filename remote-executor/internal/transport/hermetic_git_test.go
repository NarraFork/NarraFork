package transport

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/testgit"
)

func TestMain(m *testing.M) {
	os.Exit(testgit.Main(m))
}

func transportFixtureGit(t *testing.T, args ...string) {
	t.Helper()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if out, err := testgit.CommandContext(ctx, args...).CombinedOutput(); err != nil {
		t.Fatalf("fixture git %v: %v %s", args, err, out)
	}
}

func canonicalGitRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	resolved, err := handlers.NewPathGuard([]string{root}).CheckExisting(root)
	if err != nil {
		t.Fatalf("resolve positive Git fixture identity: %v", err)
	}
	return resolved
}
