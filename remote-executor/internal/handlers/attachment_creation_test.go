//go:build linux

package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"

	"github.com/narrafork/remote-executor/internal/history"
)

func attachmentFixture(t *testing.T) (*Handlers, history.Binding, string) {
	t.Helper()
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	os.Mkdir(root, 0700)
	guard := NewPathGuard([]string{root})
	m, err := history.New(filepath.Join(parent, "history"), func(path string, create bool) (string, error) {
		if create {
			return guard.CheckCreate(path)
		}
		return guard.CheckExisting(path)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	h := New(guard, 10<<20)
	h.SetHistory(m)
	if err := h.ConfigureAttachmentStateDirectory(filepath.Join(parent, "attachments")); err != nil {
		t.Fatal(err)
	}
	b, err := m.Open(context.Background(), root, "attachment-scope", 1)
	if err != nil {
		t.Fatal(err)
	}
	return h, b, root
}
func attachmentParams(value any) map[string]any {
	data, _ := json.Marshal(value)
	var result map[string]any
	json.Unmarshal(data, &result)
	return result
}
func createAttachment(t *testing.T, h *Handlers, b history.Binding, size int64) (attachmentStatus, attachmentIntent) {
	t.Helper()
	chunk := make([]byte, attachmentChunk)
	for i := range chunk {
		chunk[i] = byte(i % 251)
	}
	// Deterministic payload, hashed incrementally; never allocate the full 100MiB.
	file, err := os.CreateTemp(t.TempDir(), "digest-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for offset := int64(0); offset < size; offset += int64(len(chunk)) {
		end := int64(len(chunk))
		if size-offset < end {
			end = size - offset
		}
		file.Write(chunk[:end])
	}
	digest, actual, err := boundedAttachmentHash(context.Background(), file, attachmentBytes)
	if err != nil || actual != size {
		t.Fatal(err)
	}
	intent := attachmentIntent{Binding: b, OperationID: "create", RequestDigest: attachmentHash([]byte("create-intent")), Path: filepath.Join(".narrafork", "attached", "large.txt"), SizeBytes: size, Digest: digest, Expected: "absent", NoOverwrite: true}
	if _, err := h.WorkspaceAttachment(context.Background(), "attachment.begin", attachmentParams(intent)); err != nil {
		t.Fatal(err)
	}
	for offset := int64(0); offset < size; offset += int64(len(chunk)) {
		end := int64(len(chunk))
		if size-offset < end {
			end = size - offset
		}
		params := map[string]any{"binding": b, "operationId": intent.OperationID, "requestDigest": intent.RequestDigest, "offset": offset, "contentBase64": base64.StdEncoding.EncodeToString(chunk[:end]), "chunkDigest": attachmentHash(chunk[:end])}
		if _, err := h.WorkspaceAttachment(context.Background(), "attachment.append", params); err != nil {
			t.Fatal("append", err)
		}
	}
	result, err := h.WorkspaceAttachment(context.Background(), "attachment.commit", map[string]any{"binding": b, "operationId": intent.OperationID, "requestDigest": intent.RequestDigest})
	if err != nil {
		t.Fatal("commit", err)
	}
	status := result.(attachmentStatus)
	if status.State != "committed" || status.Proof == nil {
		t.Fatal("no creator proof", status)
	}
	return status, intent
}
func TestAttachment100MiBStreamingExclusiveReceiptAndOwnCleanupID(t *testing.T) {
	if testing.Short() {
		t.Skip("100MiB fixture")
	}
	h, b, root := attachmentFixture(t)
	status, _ := createAttachment(t, h, b, attachmentBytes)
	info, err := os.Stat(filepath.Join(root, status.Path))
	if err != nil || info.Size() != attachmentBytes {
		t.Fatal("real 100MiB target missing", err)
	}
	params := map[string]any{"binding": b, "operationId": "cleanup", "requestDigest": attachmentHash([]byte("cleanup-intent")), "proof": status.Proof}
	result, err := h.ConnectionScoped().WorkspaceAttachment(context.Background(), "attachment.cleanup", params)
	if err != nil {
		t.Fatal(err)
	}
	response := result.(map[string]any)
	if response["outcome"] != "deleted" || response["operationId"] != "cleanup" {
		t.Fatal("cleanup own receipt not honored", response)
	}
	if _, err := os.Stat(filepath.Join(root, status.Path)); !os.IsNotExist(err) {
		t.Fatal("cleanup did not delete exact created object")
	}
	result, err = h.WorkspaceAttachment(context.Background(), "attachment.cleanup", params)
	if err != nil || result.(map[string]any)["outcome"] != "already_deleted" {
		t.Fatal("cleanup retry", err)
	}
}
func TestAttachmentCleanupLateSameInodeChangesRemainUnknown(t *testing.T) {
	for _, kind := range []string{"bytes", "xattr"} {
		t.Run(kind, func(t *testing.T) {
			h, b, root := attachmentFixture(t)
			status, _ := createAttachment(t, h, b, 64<<10)
			target := filepath.Join(root, status.Path)
			h.attachments.beforeCleanupMove = func() {
				if kind == "bytes" {
					file, err := os.OpenFile(target, os.O_WRONLY, 0)
					if err != nil {
						t.Fatal(err)
					}
					file.WriteAt([]byte("late foreign bytes"), 0)
					file.Sync()
					file.Close()
				} else {
					if err := unix.Setxattr(target, "user.late_cleanup_test", []byte("foreign metadata"), 0); err != nil {
						t.Fatal(err)
					}
				}
			}
			result, err := h.WorkspaceAttachment(context.Background(), "attachment.cleanup", map[string]any{"binding": b, "operationId": "cleanup-late", "requestDigest": attachmentHash([]byte("cleanup-late")), "proof": status.Proof})
			if err != nil {
				t.Fatal(err)
			}
			if result.(map[string]any)["outcome"] != "unknown" {
				t.Fatal("late same inode mutation falsely deleted", result)
			}
			key := attachmentHash([]byte(b.ScopeID + "\x00" + status.OperationID))
			quarantine := filepath.Join(h.attachments.directory, key+".deleted")
			if _, err := os.Stat(quarantine); err != nil {
				t.Fatal("unknown quarantine evidence missing", err)
			}
			stored, err := readAttachment(filepath.Join(h.attachments.directory, key+".json"))
			if err != nil || stored.Status.State != "unknown" || stored.Status.Proof == nil || *stored.Status.Proof != *status.Proof {
				t.Fatal("original proof lost or falsely cleaned", err)
			}
		})
	}
}

func TestAttachmentCleanupFenceAdvanceAfterMoveIsNotDeleted(t *testing.T) {
	h, b, _ := attachmentFixture(t)
	status, _ := createAttachment(t, h, b, 64<<10)
	h.attachments.beforeCleanupMove = func() {
		if _, err := h.history.Open(context.Background(), b.Root, b.ScopeID, b.Fence+1); err != nil {
			t.Fatal(err)
		}
	}
	result, err := h.WorkspaceAttachment(context.Background(), "attachment.cleanup", map[string]any{"binding": b, "operationId": "cleanup-fence", "requestDigest": attachmentHash([]byte("cleanup-fence")), "proof": status.Proof})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["outcome"] != "unknown" {
		t.Fatal("changed binding fence falsely acknowledged deletion", result)
	}
	key := attachmentHash([]byte(b.ScopeID + "\x00" + status.OperationID))
	stored, err := readAttachment(filepath.Join(h.attachments.directory, key+".json"))
	if err != nil || stored.Status.State != "unknown" {
		t.Fatal("unknown quarantine proof not persisted", err)
	}
}

func TestAttachmentCleanupRejectsSameBytesNewIncarnation(t *testing.T) {
	h, b, root := attachmentFixture(t)
	status, _ := createAttachment(t, h, b, 64<<10)
	target := filepath.Join(root, status.Path)
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	replacement := target + ".replacement"
	os.WriteFile(replacement, data, 0600)
	os.Rename(replacement, target)
	result, err := h.WorkspaceAttachment(context.Background(), "attachment.cleanup", map[string]any{"binding": b, "operationId": "cleanup", "requestDigest": attachmentHash([]byte("cleanup")), "proof": status.Proof})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["outcome"] != "conflict" {
		t.Fatal("foreign same bytes inode deleted", result)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("foreign file touched", err)
	}
}
