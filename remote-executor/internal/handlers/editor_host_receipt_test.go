package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newHostReceiptFixture(t *testing.T) (*editorFixture, *editorHostReceipts) {
	t.Helper()
	f := newEditorFixture(t, nil)
	if err := f.e.ConfigureHostReceipts(filepath.Join(t.TempDir(), "host")); err != nil {
		t.Fatal(err)
	}
	return f, f.e.hostReceipts
}
func hostReceiptFixture(f *editorFixture, id string) EditorHostReceiptRecord {
	r := EditorHostReceiptRecord{Version: 1, CreatedAt: time.Now().UnixMilli(), UserID: "user", NarratorID: "narrator", DeviceID: f.identity.DeviceID, OperationID: id, HostOperationID: "host-" + id, LeaseID: "lease", EffectID: "effect", RequestDigest: editorDigest([]byte(id)), Namespace: "owner", ResourceKey: "resource", Root: f.root, Identity: f.identity, RawDigest: editorDigest([]byte("saved")), Bytes: 5}
	r.Saved.Hash = r.RawDigest
	r.Saved.Bytes = r.Bytes
	r.Saved.HashKind = "raw-sha256"
	r.Saved.SnapshotRevision = 1
	return r
}
func hostReceiptCall(t *testing.T, f *editorFixture, method string, params any) map[string]any {
	t.Helper()
	result, err := f.h.EditorHostReceiptDispatch(context.Background(), method, editorParams(t, params))
	if err != nil {
		t.Fatal(method, err)
	}
	return result.(map[string]any)
}
func TestEditorHostReceiptRetentionAndUnknownExpiry(t *testing.T) {
	f, store := newHostReceiptFixture(t)
	record := hostReceiptFixture(f, "terminal")
	hostReceiptCall(t, f, "editor.hostReceipt.put", map[string]any{"value": record})
	receipt := EditorApplyResult{OperationID: record.OperationID, Outcome: "committed", RawDigest: &record.RawDigest, TotalBytes: &record.Bytes}
	hostReceiptCall(t, f, "editor.hostReceipt.settle", map[string]any{"operationId": record.OperationID, "receipt": receipt})
	path, _ := store.path(record.OperationID)
	old := time.Now().Add(-editorHostTerminalRetention - time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	unknown := hostReceiptFixture(f, "unknown")
	hostReceiptCall(t, f, "editor.hostReceipt.put", map[string]any{"value": unknown})
	if r := hostReceiptCall(t, f, "editor.hostReceipt.get", map[string]any{"operationId": record.OperationID}); r["value"] != nil {
		t.Fatal("terminal window did not expire")
	}
	// Expiry of an unknown receipt is explicit unavailable, not deletion or
	// not-found. It remains counted and protects its only association evidence.
	unknown.CreatedAt = time.Now().Add(-editorHostRecordTTL - time.Hour).UnixMilli()
	path, _ = store.path(unknown.OperationID)
	if err := store.io.save(path, unknown); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.EditorHostReceiptDispatch(context.Background(), "editor.hostReceipt.get", map[string]any{"operationId": "unknown"}); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatal("unknown expiry became not-found", err)
	}
	next := hostReceiptFixture(f, "next")
	hostReceiptCall(t, f, "editor.hostReceipt.put", map[string]any{"value": next})
	if _, err := os.Stat(path); err != nil {
		t.Fatal("unknown sole proof was TTL-deleted", err)
	}
}
func TestEditorHostReceiptRejectsUnsafeAssociationAndOversizeIntent(t *testing.T) {
	f, store := newHostReceiptFixture(t)
	for _, kind := range []string{"owner", "device", "saved", "v1-invalid-hash", "initial-proof", "future", "oversize", "no-proof-room"} {
		t.Run(kind, func(t *testing.T) {
			record := hostReceiptFixture(f, kind)
			switch kind {
			case "owner":
				record.UserID = ""
			case "device":
				record.Identity.DeviceID = "other"
			case "saved":
				record.Saved.Hash = editorDigest([]byte("other"))
			case "v1-invalid-hash":
				record.Saved.HashKind = ""
				record.Saved.Hash = "not-a-sha256"
			case "initial-proof":
				record.Receipt = editorFailure(record.OperationID, "rejected", "EDITOR_APPLY_REJECTED", "proof")
			case "future":
				record.CreatedAt = time.Now().Add(time.Hour).UnixMilli()
			case "oversize":
				record.Namespace = strings.Repeat("n", 8192)
				record.ResourceKey = strings.Repeat("r", 8192)
			case "no-proof-room":
				record.Namespace = strings.Repeat("n", 8192)
				record.ResourceKey = ""
				b, err := json.Marshal(record)
				if err != nil {
					t.Fatal(err)
				}
				record.ResourceKey = strings.Repeat("r", editorHostRecordBytes-4-len(b))
			}
			if _, err := f.h.EditorHostReceiptDispatch(context.Background(), "editor.hostReceipt.put", editorParams(t, map[string]any{"value": record})); err == nil {
				t.Fatal("unsafe Host intent was persisted")
			}
			path, _ := store.path(record.OperationID)
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("rejected intent had filesystem effect", err)
			}
		})
	}
}
func TestEditorHostReceiptV1SavedTextAndRawHashDomains(t *testing.T) {
	for name, raw := range map[string][]byte{"utf8-bom": {0xef, 0xbb, 0xbf, 'o', 'k', '\n'}, "utf16le": {0xff, 0xfe, 'o', 0, 'k', 0, '\n', 0}} {
		t.Run(name, func(t *testing.T) {
			f, store := newHostReceiptFixture(t)
			record := hostReceiptFixture(f, name)
			record.Saved.HashKind = ""
			record.Saved.Hash = editorDigest([]byte("ok\n"))
			record.RawDigest = editorDigest(raw)
			record.Bytes = int64(len(raw))
			record.Saved.Bytes = record.Bytes
			if record.Saved.Hash == record.RawDigest {
				t.Fatal("fixture did not separate hash domains")
			}
			hostReceiptCall(t, f, "editor.hostReceipt.put", map[string]any{"value": record})
			got := hostReceiptCall(t, f, "editor.hostReceipt.get", map[string]any{"operationId": name})["value"].(*EditorHostReceiptRecord)
			if got.Saved.Hash != record.Saved.Hash || got.RawDigest != record.RawDigest {
				t.Fatal("v1 hash domains were rewritten")
			}
			wrong := EditorApplyResult{OperationID: name, Outcome: "committed", RawDigest: &record.Saved.Hash, TotalBytes: &record.Bytes}
			if _, err := f.h.EditorHostReceiptDispatch(context.Background(), "editor.hostReceipt.settle", editorParams(t, map[string]any{"operationId": name, "receipt": wrong})); err == nil {
				t.Fatal("text hash was accepted as raw installation proof")
			}
			proof := EditorApplyResult{OperationID: name, Outcome: "committed", RawDigest: &record.RawDigest, TotalBytes: &record.Bytes}
			hostReceiptCall(t, f, "editor.hostReceipt.settle", map[string]any{"operationId": name, "receipt": proof})
			root := store.io.root
			f.restart(t)
			if err := f.e.ConfigureHostReceipts(root); err != nil {
				t.Fatal(err)
			}
			got = hostReceiptCall(t, f, "editor.hostReceipt.get", map[string]any{"operationId": name})["value"].(*EditorHostReceiptRecord)
			if got.Saved.HashKind != "" || got.Saved.Hash != record.Saved.Hash || got.Receipt == nil || *got.Receipt.RawDigest != record.RawDigest {
				t.Fatal("cold recovery lost v1/text versus raw distinction")
			}
		})
	}
}

func TestEditorHostReceiptRejectsLinkedRecord(t *testing.T) {
	f, store := newHostReceiptFixture(t)
	record := hostReceiptFixture(f, "linked")
	hostReceiptCall(t, f, "editor.hostReceipt.put", map[string]any{"value": record})
	path, _ := store.path(record.OperationID)
	if err := os.Link(path, filepath.Join(t.TempDir(), "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.EditorHostReceiptDispatch(context.Background(), "editor.hostReceipt.get", map[string]any{"operationId": record.OperationID}); err == nil {
		t.Fatal("hardlinked Host proof was exposed")
	}
}
