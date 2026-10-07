//go:build linux

package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/narrafork/remote-executor/internal/history"
	"golang.org/x/sys/unix"
)

func TestHistoryRealCrossFilesystemRefusalDoesNotPoisonScope(t *testing.T) {
	local := t.TempDir()
	other, err := os.MkdirTemp("/dev/shm", "nf-history-cross-volume-")
	if err != nil {
		t.Skipf("no writable second filesystem: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(other) })
	localVolume, err := historyFilesystemIdentity(local)
	if err != nil {
		t.Fatal(err)
	}
	otherVolume, err := historyFilesystemIdentity(other)
	if err != nil {
		t.Skipf("second filesystem lacks mount identity: %v", err)
	}
	var localStat, otherStat unix.Stat_t
	if err := unix.Stat(local, &localStat); err != nil {
		t.Fatal(err)
	}
	if err := unix.Stat(other, &otherStat); err != nil {
		t.Fatal(err)
	}
	if localVolume == otherVolume || localStat.Dev == otherStat.Dev {
		t.Skip("test tmp and /dev/shm do not provide two distinct filesystems")
	}
	t.Logf("real cross-filesystem test: local=%s second=%s", localVolume, otherVolume)
	guard := NewPathGuard([]string{"/"})
	manager, err := history.New(filepath.Join(local, "private"), func(path string, create bool) (string, error) {
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
	ctx := context.Background()
	// The broad test-only root admits two owned temporary files on real mounts.
	// No repository scanning or mutation outside those temporary paths occurs.
	b, err := manager.Open(ctx, "/", "real-cross-volume", 1)
	if err != nil {
		t.Fatal(err)
	}
	localPath := filepath.Join(local, "same-volume.txt")
	otherPath := filepath.Join(other, "cross-volume.txt")
	for _, path := range []string{localPath, otherPath} {
		if err := os.WriteFile(path, []byte("old secret"), 0640); err != nil {
			t.Fatal(err)
		}
		if err := unix.Setxattr(path, "user.nf_history_cross_volume", []byte("keep native metadata"), 0); err != nil {
			t.Skipf("second filesystem lacks native metadata support: %v", err)
		}
	}
	localRelative := strings.TrimPrefix(localPath, "/")
	otherRelative := strings.TrimPrefix(otherPath, "/")
	capture, err := manager.Capture(ctx, history.Request{Binding: b, OperationID: "capture", RequestDigest: historyHash("capture"), Paths: []string{localRelative, otherRelative}})
	if err != nil || capture.State != "settled" {
		t.Fatal("read/capture unnecessarily rejected", capture, err)
	}
	inspect, err := manager.Inspect(ctx, b, []string{localRelative, otherRelative}, "")
	if err != nil {
		t.Fatal(err)
	}
	localBefore := *inspect.Observations[0].State
	otherBefore := *inspect.Observations[1].State
	if localBefore.Metadata == nil || otherBefore.Metadata == nil {
		t.Fatal("missing native backups")
	}
	changes := func(path string, before history.State) history.Change {
		content := base64.StdEncoding.EncodeToString([]byte("edited secret"))
		digest := historyHash("edited secret")
		return history.Change{Path: path, Expected: before, Desired: history.State{Kind: "regular", Mode: before.Mode, Object: &history.Object{
			SourceInstanceID: b.SourceInstanceID, WorkspaceInstanceID: b.WorkspaceInstanceID, ScopeID: b.ScopeID,
			ObjectID: historyHash(b.ScopeID + "\x00blob\x00" + path + "\x00" + digest), Algorithm: "sha256", Digest: digest, SizeBytes: 13, Kind: "blob", Path: path,
		}}, ContentBase64: &content}
	}
	for _, kind := range []string{"mutate", "restore"} {
		for i := 0; i < 2; i++ {
			id := fmt.Sprintf("%s-%d", kind, i)
			req := history.Request{Binding: b, OperationID: id, RequestDigest: historyHash(id), Changes: []history.Change{changes(otherRelative, otherBefore)}}
			r, err := manager.Mutate(ctx, req, kind)
			if err != nil || r.State != "rejected" || r.Reason != "unsupported_cross_filesystem" || r.Effects[0].Outcome != "pending" || r.Effects[0].After != nil {
				t.Fatal("refusal was not proven undispatched", r, err)
			}
			retry, err := manager.Mutate(ctx, req, kind)
			if err != nil || retry.State != "rejected" || retry.PayloadDigest != r.PayloadDigest {
				t.Fatal("refusal retry changed evidence", retry, err)
			}
		}
	}
	mixed, err := manager.Mutate(ctx, history.Request{Binding: b, OperationID: "mixed", RequestDigest: historyHash("mixed"), Changes: []history.Change{changes(localRelative, localBefore), changes(otherRelative, otherBefore)}}, "restore")
	if err != nil || mixed.State != "rejected" {
		t.Fatal("mixed batch not refused", mixed, err)
	}
	for _, effect := range mixed.Effects {
		if effect.Outcome != "pending" || effect.After != nil {
			t.Fatal("mixed batch partially dispatched", effect)
		}
	}
	for i, path := range []string{localPath, otherPath} {
		data, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(data, []byte("old secret")) {
			t.Fatal("refusal changed bytes", path, err)
		}
		state := []history.State{localBefore, otherBefore}[i]
		incarnation, err := history.FileIncarnation(path)
		if err != nil || incarnation != state.Incarnation {
			t.Fatal("refusal replaced original inode", err)
		}
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		metadata, err := captureHistoryMetadata(ctx, file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		backup, err := manager.ReadObject(ctx, b, *state.Metadata, 0, history.ChunkBytes)
		if err != nil {
			t.Fatal(err)
		}
		beforeMetadata, _ := base64.StdEncoding.DecodeString(backup.ContentBase64)
		if !bytes.Equal(metadata, beforeMetadata) {
			t.Fatal("refusal changed native metadata")
		}
		entries, _ := os.ReadDir(filepath.Dir(path))
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".nf-history-native-") {
				t.Fatal("temporary target artifact leaked")
			}
		}
	}
	recovery, err := os.ReadDir(filepath.Join(local, "private", "recovery"))
	if err != nil || len(recovery) != 0 {
		t.Fatal("cross-volume refusal created quarantine intents", recovery, err)
	}
	pending, err := manager.Inspect(ctx, b, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range pending.Pending {
		if r.Kind != "capture" {
			t.Fatal("refusal polluted pending journal", r)
		}
	}
	// Same-scope same-volume writes must remain possible after all refusals.
	good, err := manager.Mutate(ctx, history.Request{Binding: b, OperationID: "good", RequestDigest: historyHash("good"), Changes: []history.Change{changes(localRelative, localBefore)}}, "mutate")
	if err != nil || good.State != "settled" || good.Effects[0].Outcome != "applied" {
		t.Fatal("refusal poisoned same-volume write", good, err)
	}
	if _, err := manager.Finalize(ctx, b, "good", historyHash("good"), "commit-proof"); err != nil {
		t.Fatal(err)
	}
	// A new-file publication uses target-local staging and needs no cross-volume
	// original quarantine, so it is safely supported on the second mount.
	newPath := strings.TrimPrefix(filepath.Join(other, "new-file.txt"), "/")
	newFile := changes(newPath, history.State{Kind: "absent"})
	newFile.Desired.Mode = 0600
	created, err := manager.Mutate(ctx, history.Request{Binding: b, OperationID: "new-file", RequestDigest: historyHash("new-file"), Changes: []history.Change{newFile}}, "mutate")
	if err != nil || created.State != "settled" {
		t.Fatal("safe target-local new-file publication refused", created, err)
	}
	if _, err := manager.Finalize(ctx, b, "new-file", historyHash("new-file"), "new-commit-proof"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Open(ctx, "/", b.ScopeID, b.Fence+1); err != nil {
		t.Fatal("refusals poisoned next fence", err)
	}
}
