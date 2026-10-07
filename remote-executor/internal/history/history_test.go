package history

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Controlled simple-file IO for journal fault tests. Production handlers install
// the platform-native preserving adapter; these fixtures never have ACL/xattrs.
func installFixtureNativeIO(manager *Manager) {
	manager.SetNativeMutationIO(NativeMutationIO{
		Validate: func(ctx context.Context, path string, before, desired State) error { return ctx.Err() },
		Replace: func(ctx context.Context, path string, desired State, before, next []byte) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			current, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if !bytes.Equal(current, before) {
				return fmt.Errorf("fixture content_changed")
			}
			if desired.Kind == "absent" {
				return os.Remove(path)
			}
			return os.WriteFile(path, next, os.FileMode(desired.Mode))
		},
	})
}

func fixture(t *testing.T) (*Manager, Binding, string, string) {
	t.Helper()
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	store := filepath.Join(parent, "private")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	manager, err := New(store, func(path string, create bool) (string, error) { return filepath.Clean(path), nil })
	if err != nil {
		t.Fatal(err)
	}
	installFixtureNativeIO(manager)
	t.Cleanup(func() { manager.Close() })
	binding, err := manager.Open(context.Background(), root, "test-scope", 1)
	if err != nil {
		t.Fatal(err)
	}
	return manager, binding, root, store
}

func desired(b Binding, content string) State {
	digest := hash([]byte(content))
	return State{Kind: "regular", Mode: supportedMode(0600), Object: &Object{b.SourceInstanceID, b.WorkspaceInstanceID, b.ScopeID, objectID(b.ScopeID, "blob", "file.txt", digest), "sha256", digest, int64(len(content)), "blob", "file.txt"}}
}

func request(b Binding, id, content string, before State) Request {
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	return Request{Binding: b, OperationID: id, RequestDigest: key(id), Changes: []Change{{Path: "file.txt", Expected: before, Desired: desired(b, content), ContentBase64: &encoded}}}
}

func TestDurableMutationRetryAndCompensation(t *testing.T) {
	m, b, root, store := fixture(t)
	ctx := context.Background()
	req := request(b, "write", "hello", State{Kind: "absent"})
	r, err := m.Mutate(ctx, req, "mutate")
	if err != nil {
		t.Fatal(err)
	}
	if r.State != "settled" || r.Effects[0].Outcome != "applied" {
		t.Fatalf("bad receipt %+v", r)
	}
	data, _ := os.ReadFile(filepath.Join(root, "file.txt"))
	if string(data) != "hello" {
		t.Fatal("not written")
	}
	retry, err := m.Mutate(ctx, req, "mutate")
	if err != nil || retry.PayloadDigest != r.PayloadDigest {
		t.Fatal("not idempotent", err)
	}
	req.Changes[0].Desired.Mode = 0644
	if _, err := m.Mutate(ctx, req, "mutate"); err == nil {
		t.Fatal("digest reuse accepted")
	}
	m.Close()
	reopened, err := New(store, func(path string, create bool) (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	installFixtureNativeIO(reopened)
	recovered, err := reopened.Open(ctx, root, "test-scope", 1)
	if err != nil || recovered != b {
		t.Fatal("binding drift", err)
	}
	durable, err := reopened.Status(ctx, b, "write")
	if err != nil || durable.State != "settled" {
		t.Fatal("receipt lost", err)
	}
	if _, err := reopened.Open(ctx, root, "test-scope", 2); err == nil {
		t.Fatal("pending fence advanced")
	}
	comp, err := reopened.Compensate(ctx, Request{Binding: b, OperationID: "undo", RequestDigest: key("undo"), OriginalOperationID: "write"})
	if err != nil || comp.State != "compensated" {
		t.Fatal("compensate", err)
	}
	if _, err := os.Stat(filepath.Join(root, "file.txt")); !os.IsNotExist(err) {
		t.Fatal("not removed")
	}
	if _, err := reopened.Open(ctx, root, "test-scope", 2); err != nil {
		t.Fatal("fence not released", err)
	}
}

func TestExternalChangeNeverCompensated(t *testing.T) {
	m, b, root, _ := fixture(t)
	ctx := context.Background()
	if _, err := m.Mutate(ctx, request(b, "write", "owned", State{Kind: "absent"}), "mutate"); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("foreign"), 0600)
	if _, err := m.Compensate(ctx, Request{Binding: b, OperationID: "undo", RequestDigest: key("undo"), OriginalOperationID: "write"}); err == nil {
		t.Fatal("foreign edit overwritten")
	}
	data, _ := os.ReadFile(filepath.Join(root, "file.txt"))
	if string(data) != "foreign" {
		t.Fatal("foreign bytes changed")
	}
	status, _ := m.Status(ctx, b, "write")
	if status.State != "settled" {
		t.Fatal("journal discarded")
	}
}

func TestCaptureObjectsAndConditionalRestore(t *testing.T) {
	m, b, root, _ := fixture(t)
	ctx := context.Background()
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("before"), 0600)
	snapshot, err := m.Capture(ctx, Request{Binding: b, OperationID: "snapshot", RequestDigest: key("capture"), Paths: []string{"file.txt", "missing"}})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Coverage != "complete" || snapshot.Tree == nil || snapshot.TemporalConsistency != "concurrent_observation" {
		t.Fatal("bad sparse snapshot", snapshot)
	}
	raw, err := m.ReadObject(ctx, b, *snapshot.Tree, 0, ChunkBytes)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := base64.StdEncoding.DecodeString(raw.ContentBase64)
	var manifest []Observation
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	before := *manifest[0].State
	req := request(b, "write", "after", before)
	r, err := m.Mutate(ctx, req, "mutate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Finalize(ctx, b, "write", req.RequestDigest, "history-commit"); err != nil {
		t.Fatal(err)
	}
	restore := Request{Binding: b, OperationID: "restore", RequestDigest: key("restore"), Changes: []Change{{Path: "file.txt", Expected: *r.Effects[0].After, Desired: before}}}
	restored, err := m.Mutate(ctx, restore, "restore")
	if err != nil || restored.State != "settled" {
		t.Fatal("restore failed", err)
	}
	bytes, _ := os.ReadFile(filepath.Join(root, "file.txt"))
	if string(bytes) != "before" {
		t.Fatal("snapshot bytes not restored")
	}
	wrong := *snapshot.Tree
	wrong.SourceInstanceID = "other"
	if _, err := m.ReadObject(ctx, b, wrong, 0, 1); err == nil {
		t.Fatal("cross source read")
	}
}

func TestRootReplacementAndSymlinkDenied(t *testing.T) {
	m, b, root, _ := fixture(t)
	ctx := context.Background()
	outside := filepath.Join(filepath.Dir(root), "outside")
	os.Mkdir(outside, 0700)
	if err := os.Symlink(outside, filepath.Join(root, "link")); err == nil {
		if _, err := m.Mutate(ctx, Request{Binding: b, OperationID: "escape", RequestDigest: key("escape"), Changes: []Change{{Path: "link/file", Expected: State{Kind: "absent"}, Desired: State{Kind: "absent"}}}}, "mutate"); err == nil {
			t.Fatal("symlink escaped")
		}
	}
	os.Rename(root, root+"-old")
	os.Mkdir(root, 0700)
	if _, err := m.Inspect(ctx, b, []string{"file.txt"}, ""); err == nil {
		t.Fatal("root replacement accepted")
	}
	if _, err := m.Open(ctx, root, "test-scope", 1); err == nil {
		t.Fatal("old scope rebound")
	}
}

func TestUnknownIntentIsNotReplayedOrCleared(t *testing.T) {
	m, b, root, _ := fixture(t)
	ctx := context.Background()
	req := request(b, "lost", "new", State{Kind: "absent"})
	m.mu.Lock()
	receipt, _, err := m.prepareRequest(req, "mutate")
	if err != nil {
		t.Fatal(err)
	}
	receipt.Effects = []Effect{{Path: "file.txt", Before: State{Kind: "absent"}, Intended: desired(b, "new"), Outcome: "pending"}}
	err = m.saveReceipt(receipt)
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	retry, err := m.Mutate(ctx, req, "mutate")
	if err != nil || retry.State != "intent" {
		t.Fatal("unknown intent replay", err)
	}
	if _, err := os.Stat(filepath.Join(root, "file.txt")); !os.IsNotExist(err) {
		t.Fatal("unknown intent executed")
	}
	if _, err := m.Finalize(ctx, b, "lost", req.RequestDigest, "commit"); err == nil {
		t.Fatal("unknown finalized")
	}
	inspection, err := m.Inspect(ctx, b, nil, "")
	if err != nil || len(inspection.Pending) != 1 {
		t.Fatal("unknown discarded", err)
	}
}

func TestCancelledMutationAndPrivateStorePlacement(t *testing.T) {
	m, b, root, store := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Mutate(ctx, request(b, "cancel", "bytes", State{Kind: "absent"}), "mutate"); err == nil {
		t.Fatal("cancel ignored")
	}
	if _, err := m.Open(context.Background(), store, "inside-private", 1); err == nil {
		t.Fatal("workspace is private state")
	}
	ancestor, err := m.Open(context.Background(), filepath.Dir(root), "home-root", 1)
	if err != nil {
		t.Fatal("ordinary home root should be allowed", err)
	}
	if _, err := m.target(ancestor, "private/source.json"); err == nil {
		t.Fatal("history can target its private store")
	}
	if _, err := m.ReadObject(context.Background(), b, *desired(b, "bytes").Object, -1, 1); err == nil {
		t.Fatal("negative offset")
	}
}
