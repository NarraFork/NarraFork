package history

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCrashBoundaryJournalNeverInfersUnacknowledgedIO(t *testing.T) {
	for _, phase := range []string{"intent", "dispatching", "io", "ack"} {
		t.Run(phase, func(t *testing.T) {
			m, b, root, store := fixture(t)
			ctx := context.Background()
			m.testFault = func(at string) error {
				if at == phase {
					return errors.New("simulated process loss")
				}
				return nil
			}
			req := request(b, "boundary", "new bytes", State{Kind: "absent"})
			if _, err := m.Mutate(ctx, req, "mutate"); err == nil {
				t.Fatal("fault did not fire")
			}
			m.Close()
			recovered, err := New(store, func(path string, create bool) (string, error) { return path, nil })
			if err != nil {
				t.Fatal(err)
			}
			defer recovered.Close()
			r, err := recovered.Status(ctx, b, req.OperationID)
			if err != nil {
				t.Fatal(err)
			}
			if phase == "io" || phase == "ack" {
				data, _ := os.ReadFile(filepath.Join(root, "file.txt"))
				if string(data) != "new bytes" {
					t.Fatal("target IO missing")
				}
			} else if _, err := os.Stat(filepath.Join(root, "file.txt")); !os.IsNotExist(err) {
				t.Fatal("premature target IO")
			}
			if phase == "ack" {
				if r.Effects[0].Outcome != "applied" || r.Effects[0].After == nil {
					t.Fatal("durable acknowledgment lost")
				}
				if _, err := recovered.Finalize(ctx, b, req.OperationID, req.RequestDigest, "commit-proof"); err != nil {
					t.Fatal("cannot recover acknowledged write", err)
				}
			} else {
				if _, err := recovered.Finalize(ctx, b, req.OperationID, req.RequestDigest, "commit"); err == nil {
					t.Fatal("unacknowledged mutation finalized")
				}
				if _, err := recovered.Compensate(ctx, Request{Binding: b, OperationID: "undo", RequestDigest: key("undo"), OriginalOperationID: req.OperationID}); err == nil {
					t.Fatal("unacknowledged IO guessed")
				}
				if _, err := recovered.Open(ctx, root, b.ScopeID, b.Fence+1); err == nil {
					t.Fatal("unknown barrier cleared")
				}
			}
		})
	}
}

func TestLostFinalizeResponseRetainsImmutableCommitReceipt(t *testing.T) {
	m, b, _, _ := fixture(t)
	ctx := context.Background()
	req := request(b, "write", "bytes", State{Kind: "absent"})
	if _, err := m.Mutate(ctx, req, "mutate"); err != nil {
		t.Fatal(err)
	}
	m.testFault = func(phase string) error {
		if phase == "finalize" {
			return errors.New("response lost")
		}
		return nil
	}
	if _, err := m.Finalize(ctx, b, req.OperationID, req.RequestDigest, "history-commit"); err == nil {
		t.Fatal("fault did not fire")
	}
	receipt, err := m.Status(ctx, b, req.OperationID)
	if err != nil || receipt.State != "finalized" || receipt.ServerCommitID != "history-commit" {
		t.Fatal("finalized receipt lost", err)
	}
	if _, err := m.Finalize(ctx, b, req.OperationID, req.RequestDigest, "other-commit"); err == nil {
		t.Fatal("commit id reused")
	}
}

func TestHistoricalObjectReadReauthorizesOriginalPath(t *testing.T) {
	m, b, root, _ := fixture(t)
	ctx := context.Background()
	os.WriteFile(filepath.Join(root, "secret.txt"), []byte("private"), 0600)
	receipt, err := m.Capture(ctx, Request{Binding: b, OperationID: "capture", RequestDigest: key("capture"), Paths: []string{"secret.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.ReadObject(ctx, b, *receipt.Tree, 0, ChunkBytes)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := base64.StdEncoding.DecodeString(page.ContentBase64)
	var manifest []Observation
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	object := *manifest[0].State.Object
	// Fabricating another origin with the same bytes cannot access the original placement.
	forged := object
	forged.Path = "allowed.txt"
	forged.ObjectID = objectID(b.ScopeID, "blob", forged.Path, forged.Digest)
	if _, err := m.ReadObject(ctx, b, forged, 0, ChunkBytes); err == nil {
		t.Fatal("forged placement read secret")
	}
	m.guard = func(path string, create bool) (string, error) {
		if path == filepath.Join(root, "secret.txt") {
			return "", errors.New("denied")
		}
		return path, nil
	}
	if _, err := m.ReadObject(ctx, b, object, 0, ChunkBytes); err == nil {
		t.Fatal("historical bytes bypassed current deny")
	}
	if _, err := m.ReadObject(ctx, b, *receipt.Tree, 0, ChunkBytes); err == nil {
		t.Fatal("historical manifest bypassed current deny")
	}
}

func TestPendingPaginationIsStableAndNoFaultEvidenceDeleted(t *testing.T) {
	m, b, _, _ := fixture(t)
	ctx := context.Background()
	for i := 0; i < 107; i++ {
		id := key(string(rune(i)))
		receipt := &Receipt{Binding: b, OperationID: id, RequestDigest: key(id), PayloadDigest: key(id), Kind: "mutate", State: "intent", Effects: []Effect{}, StartedAt: now()}
		if err := m.saveReceipt(receipt); err != nil {
			t.Fatal(err)
		}
	}
	first, err := m.Inspect(ctx, b, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Pending) != 100 || first.NextCursor == "" {
		t.Fatal("first page not bounded")
	}
	second, err := m.Inspect(ctx, b, nil, first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Pending) != 7 || second.NextCursor != "" {
		t.Fatal("second page incomplete")
	}
	ids := map[string]bool{}
	for _, r := range append(first.Pending, second.Pending...) {
		if ids[r.OperationID] {
			t.Fatal("duplicate page")
		}
		ids[r.OperationID] = true
	}
	for id := range ids {
		if _, err := m.Status(ctx, b, id); err != nil {
			t.Fatal("pending evidence removed", err)
		}
	}
}

func TestCancellationWhileQueuedAndExclusivePrivateStore(t *testing.T) {
	m, b, _, store := fixture(t)
	ctx := context.Background()
	if _, err := New(store, func(path string, create bool) (string, error) { return path, nil }); err == nil {
		t.Fatal("second private store writer admitted")
	}
	if err := m.acquire(ctx); err != nil {
		t.Fatal(err)
	}
	wait, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := m.Status(wait, b, "missing"); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("queue ignored cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("queue cancellation blocked")
	}
	m.release()
}

func TestClonedStoreCannotImpersonateOriginalSource(t *testing.T) {
	m, _, _, original := fixture(t)
	marker, err := os.ReadFile(filepath.Join(original, "source.json"))
	if err != nil {
		t.Fatal(err)
	}
	clone := filepath.Join(filepath.Dir(original), "cloned-private")
	if err := os.Mkdir(clone, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(clone, "source.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	m.Close()
	if copied, err := New(clone, func(path string, create bool) (string, error) { return path, nil }); err == nil {
		copied.Close()
		t.Fatal("cloned store reused persistent source identity")
	}
}

func TestQuotaDoesNotErasePendingReceipts(t *testing.T) {
	m, b, _, _ := fixture(t)
	ctx := context.Background()
	req := request(b, "pending", "bytes", State{Kind: "absent"})
	m.testFault = func(phase string) error {
		if phase == "intent" {
			return errors.New("stop")
		}
		return nil
	}
	if _, err := m.Mutate(ctx, req, "mutate"); err == nil {
		t.Fatal("fault missing")
	}
	m.bytes = QuotaBytes
	if _, err := m.putObject(b, []byte("more"), "blob", "another.txt"); err == nil {
		t.Fatal("quota not enforced")
	}
	receipt, err := m.Status(ctx, b, "pending")
	if err != nil || receipt.State != "intent" {
		t.Fatal("pending receipt GCed", err)
	}
}
