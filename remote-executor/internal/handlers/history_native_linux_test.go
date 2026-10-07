//go:build linux

package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/narrafork/remote-executor/internal/history"
	"golang.org/x/sys/unix"
)

func historyHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func TestNativeLockedRestoreRejectsSameBytesDifferentIncarnation(t *testing.T) {
	parent := t.TempDir()
	path := filepath.Join(parent, "file")
	os.WriteFile(path, []byte("same bytes"), 0600)
	original, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := captureHistoryMetadata(context.Background(), original)
	original.Close()
	if err != nil {
		t.Fatal(err)
	}
	witness, err := history.FileIncarnation(path)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(parent, "replacement")
	os.WriteFile(replacement, []byte("same bytes"), 0600)
	os.Rename(replacement, path)
	actual, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer actual.Close()
	if err := verifyHistoryBefore(context.Background(), actual, history.NativeApplyRequest{Path: path, Before: history.State{Kind: "regular", Incarnation: witness}, BeforeBytes: []byte("same bytes"), BeforeMetadata: metadata}); err == nil {
		t.Fatal("lock-local verification substituted the raced inode as original")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "same bytes" {
		t.Fatal("rejected raced file was touched")
	}
}

func TestHistoryNativeReplacementPreservesMetadataAcrossConnection(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	os.Mkdir(root, 0700)
	guard := NewPathGuard([]string{root})
	manager, err := history.New(filepath.Join(parent, "private"), func(path string, create bool) (string, error) {
		if create {
			return guard.CheckCreate(path)
		}
		return guard.CheckExisting(path)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	h := New(guard, 10<<20)
	h.SetHistory(manager)
	b, err := manager.Open(context.Background(), root, "native-scope", 1)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "file.txt")
	os.WriteFile(path, []byte("before"), 0600)
	if err := unix.Setxattr(path, "user.nf_history_test", []byte("keep metadata"), 0); err != nil {
		t.Skipf("xattrs unavailable: %v", err)
	}
	inspected, err := manager.Inspect(context.Background(), b, []string{"file.txt"}, "")
	if err != nil {
		t.Fatal(err)
	}
	before := *inspected.Observations[0].State
	digest := historyHash("after")
	content := base64.StdEncoding.EncodeToString([]byte("after"))
	desired := history.State{Kind: "regular", Mode: before.Mode, Object: &history.Object{
		SourceInstanceID: b.SourceInstanceID, WorkspaceInstanceID: b.WorkspaceInstanceID, ScopeID: b.ScopeID,
		ObjectID: historyHash(b.ScopeID + "\x00blob\x00file.txt\x00" + digest), Algorithm: "sha256", Digest: digest, SizeBytes: 5, Kind: "blob", Path: "file.txt",
	}}
	r, err := manager.Mutate(context.Background(), history.Request{Binding: b, OperationID: "native-edit", RequestDigest: historyHash("intent"), Changes: []history.Change{{Path: "file.txt", Expected: before, Desired: desired, ContentBase64: &content}}}, "mutate")
	if err != nil || r.State != "settled" {
		t.Fatal("native replacement failed", err, r)
	}
	attrs := make([]byte, 100)
	n, err := unix.Getxattr(path, "user.nf_history_test", attrs)
	if err != nil || string(attrs[:n]) != "keep metadata" {
		t.Fatal("history replacement dropped xattrs", err)
	}
	connection := h.ConnectionScoped()
	if connection.history != h.history {
		t.Fatal("journal not shared across connection")
	}
	status, err := connection.History(context.Background(), "history.status", map[string]any{"binding": b, "operationId": "native-edit"})
	if err != nil || status.(*history.Receipt).State != "settled" {
		t.Fatal("connection receipt lost", err)
	}
	compensated, err := manager.Compensate(context.Background(), history.Request{Binding: b, OperationID: "native-undo", RequestDigest: historyHash("undo"), OriginalOperationID: "native-edit"})
	if err != nil || compensated.State != "compensated" {
		t.Fatal("native compensation failed", err)
	}
	prior, _ := os.ReadFile(path)
	if string(prior) != "before" {
		t.Fatal("native compensation did not restore bytes")
	}
	n, err = unix.Getxattr(path, "user.nf_history_test", attrs)
	if err != nil || string(attrs[:n]) != "keep metadata" {
		t.Fatal("compensation dropped xattrs", err)
	}
	if before.Metadata == nil {
		t.Fatal("complete native backup was not captured")
	}
	currentBefore, err := manager.Inspect(context.Background(), b, []string{"file.txt"}, "")
	if err != nil {
		t.Fatal(err)
	}
	before = *currentBefore.Observations[0].State
	deleted, err := manager.Mutate(context.Background(), history.Request{Binding: b, OperationID: "delete", RequestDigest: historyHash("delete"), Changes: []history.Change{{Path: "file.txt", Expected: before, Desired: history.State{Kind: "absent"}}}}, "restore")
	if err != nil || deleted.State != "settled" {
		t.Fatal("metadata-aware deletion failed", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("delete did not reach target")
	}
	undo, err := manager.Compensate(context.Background(), history.Request{Binding: b, OperationID: "undo-delete", RequestDigest: historyHash("undo-delete"), OriginalOperationID: "delete"})
	if err != nil || undo.State != "compensated" {
		t.Fatal("private complete backup did not restore", err)
	}
	actual, _ := os.ReadFile(path)
	if string(actual) != "before" {
		t.Fatal("deleted bytes not restored")
	}
	n, err = unix.Getxattr(path, "user.nf_history_test", attrs)
	if err != nil || string(attrs[:n]) != "keep metadata" {
		t.Fatal("delete compensation lost xattrs", err)
	}
	modeBefore, err := manager.Inspect(context.Background(), b, []string{"file.txt"}, "")
	if err != nil {
		t.Fatal(err)
	}
	oldModeState := *modeBefore.Observations[0].State
	desiredMode := oldModeState
	desiredMode.Mode = 0640
	independentMetadata := *oldModeState.Metadata
	desiredMode.Metadata = &independentMetadata
	modeReceipt, err := manager.Mutate(context.Background(), history.Request{Binding: b, OperationID: "mode", RequestDigest: historyHash("mode"), Changes: []history.Change{{Path: "file.txt", Expected: oldModeState, Desired: desiredMode}}}, "restore")
	if err != nil || modeReceipt.State != "settled" {
		t.Fatal("metadata-aware mode restore failed", err)
	}
	modeInfo, _ := os.Stat(path)
	if modeInfo.Mode().Perm() != 0640 {
		t.Fatal("mode was not applied")
	}
	undoMode, err := manager.Compensate(context.Background(), history.Request{Binding: b, OperationID: "undo-mode", RequestDigest: historyHash("undo-mode"), OriginalOperationID: "mode"})
	if err != nil || undoMode.State != "compensated" {
		t.Fatal("mode conditional compensation failed", err)
	}
	modeInfo, _ = os.Stat(path)
	if modeInfo.Mode().Perm() != 0600 {
		t.Fatal("original mode not restored")
	}
}
