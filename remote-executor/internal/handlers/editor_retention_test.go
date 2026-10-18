package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func acknowledgeEditorFixture(t *testing.T, f *editorFixture, req EditorApplyRequest) {
	t.Helper()
	q := EditorQueryRequest{Namespace: req.Namespace, ResourceKey: req.ResourceKey, OperationID: req.OperationID, RequestDigest: req.RequestDigest, AcknowledgeTerminal: true}
	if result := f.call(t, "editor.query", q).(EditorQueryResult); result.Outcome != "committed" && result.Outcome != "rejected" {
		t.Fatalf("ack did not preserve terminal receipt: %+v", result)
	}
}
func writeEditorReceiptFixture(t *testing.T, f *editorFixture, r editorReceipt) {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(f.e.receiptPath(r.Request.Namespace, r.Request.OperationID), b, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestEditorAcknowledgedReceiptRetentionAndPressure(t *testing.T) {
	for _, policy := range []string{"seven-day-window", "full-inventory-pressure"} {
		t.Run(policy, func(t *testing.T) {
			// A no-content-change save deliberately leaves the old baseline hash
			// equal to disk. Reclamation still cannot turn it into a second install.
			f := newEditorFixture(t, []byte("same"))
			req := f.request(t, "retired", []byte("same"), []byte("same"))
			if got := f.call(t, "editor.apply", req).(EditorApplyResult); got.Outcome != "committed" {
				t.Fatal(got)
			}
			acknowledgeEditorFixture(t, f, req)
			var old editorReceipt
			if err := editorReadJSON(f.e.receiptPath(req.Namespace, req.OperationID), &old); err != nil {
				t.Fatal(err)
			}
			if old.AcknowledgedAt == 0 {
				t.Fatal("proof transfer acknowledgment was not persisted")
			}
			// Repeated ACK is idempotent; it cannot indefinitely refresh retention.
			acknowledgeEditorFixture(t, f, req)
			var duplicate editorReceipt
			if err := editorReadJSON(f.e.receiptPath(req.Namespace, req.OperationID), &duplicate); err != nil {
				t.Fatal(err)
			}
			if duplicate.AcknowledgedAt != old.AcknowledgedAt {
				t.Fatal("ACK refreshed retention")
			}
			if policy == "seven-day-window" {
				old.AcknowledgedAt = time.Now().Add(-editorReceiptRetention - time.Hour).UnixMilli()
				writeEditorReceiptFixture(t, f, old)
			}
			for i := 1; i < editorMaxReceipts; i++ {
				r := old
				r.Request.OperationID = fmt.Sprintf("history-%d", i)
				r.Request.RequestDigest = editorDigest([]byte(r.Request.OperationID))
				r.Request.StageID = fmt.Sprintf("%048x", i)
				r.Result = &EditorApplyResult{OperationID: r.Request.OperationID, Outcome: "committed", RawDigest: old.Result.RawDigest, TotalBytes: old.Result.TotalBytes}
				if policy == "full-inventory-pressure" {
					r.AcknowledgedAt = old.AcknowledgedAt + 1
				}
				writeEditorReceiptFixture(t, f, r)
			}
			// An orphan ceiling is reclaimable. Live receipt/pending stage ceilings
			// are separately checked below, so namespace/root turnover is bounded.
			orphan := filepath.Join(f.state, editorKey("retired-owner", "old-root")+".fence.json")
			if err := f.e.save(orphan, editorFence{Version: 1, Token: 99, Namespace: "retired-owner"}); err != nil {
				t.Fatal(err)
			}
			f.restart(t)
			next := f.request(t, "next-save", []byte("same"), []byte("next"))
			if q := f.query(t, req); q.Outcome != "not_found" {
				t.Fatalf("acknowledged history not retired: %+v", q)
			}
			if _, err := os.Stat(orphan); !os.IsNotExist(err) {
				t.Fatal("unreferenced fence inventory leaked", err)
			}
			if _, err := os.Stat(f.e.stagePath(req.StageID)); !os.IsNotExist(err) {
				t.Fatal("retired stage capability survived receipt removal")
			}
			if _, err := os.Stat(f.e.bodyPath(req.StageID)); !os.IsNotExist(err) {
				t.Fatal("retired body survived receipt removal")
			}
			renamed := 0
			f.e.fault = func(point string) error {
				if point == "renamed" {
					renamed++
				}
				return nil
			}
			if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, req)); err == nil {
				t.Fatal("expired immutable attempt was installed again")
			}
			if renamed != 0 {
				t.Fatal("old digest coincidence caused replay")
			}
			if got := f.call(t, "editor.apply", next).(EditorApplyResult); got.Outcome != "committed" {
				t.Fatal("normal save remained quota blocked", got)
			}
			if renamed != 1 {
				t.Fatal("next save did not perform exactly one install", renamed)
			}
			f.restart(t)
			if q := f.query(t, req); q.Outcome != "not_found" {
				t.Fatal("cold restart recreated retired proof")
			}
			if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, req)); err == nil {
				t.Fatal("cold restart resurrected retired capability")
			}
			if q := f.query(t, next); q.Outcome != "committed" {
				t.Fatal("new save receipt was lost", q)
			}
		})
	}
}

func TestEditorRetentionNeverDeletesSoleProofOrUncertain(t *testing.T) {
	f := newEditorFixture(t, []byte("before"))
	req := f.request(t, "sole-proof", []byte("before"), []byte("after"))
	if got := f.call(t, "editor.apply", req).(EditorApplyResult); got.Outcome != "committed" {
		t.Fatal(got)
	}
	f.restart(t)
	f.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 0, IdleTimeoutMs: 30000})
	if q := f.query(t, req); q.Outcome != "committed" {
		t.Fatal("unacknowledged sole proof was removed", q)
	}
	g := newEditorFixture(t, []byte("before"))
	unknown := g.request(t, "unknown", []byte("before"), []byte("after"))
	g.e.fault = func(point string) error {
		if point == "applying" {
			return errors.New("crashed")
		}
		return nil
	}
	if _, err := g.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, unknown)); err == nil {
		t.Fatal("fault not exercised")
	}
	g.restart(t)
	q := EditorQueryRequest{Namespace: unknown.Namespace, ResourceKey: unknown.ResourceKey, OperationID: unknown.OperationID, RequestDigest: unknown.RequestDigest, AcknowledgeTerminal: true}
	if _, err := g.h.EditorDispatch(context.Background(), "editor.query", editorParams(t, q)); err == nil {
		t.Fatal("uncertain evidence accepted terminal ACK")
	}
	var receipt editorReceipt
	if err := editorReadJSON(g.e.receiptPath(unknown.Namespace, unknown.OperationID), &receipt); err != nil {
		t.Fatal(err)
	}
	// Even a spurious old ACK marker is not permission to evict unknown state.
	receipt.AcknowledgedAt = time.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	writeEditorReceiptFixture(t, g, receipt)
	g.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 0, IdleTimeoutMs: 30000})
	if got := g.query(t, unknown); got.Outcome != "uncertain" {
		t.Fatal("unknown proof expired", got)
	}
	if _, err := os.Stat(g.e.bodyPath(unknown.StageID)); err != nil {
		t.Fatal("unknown body evidence expired", err)
	}
}

func TestEditorFenceBudgetDoesNotPermanentlyBlockCleanup(t *testing.T) {
	f := newEditorFixture(t, []byte("before"))
	req := f.request(t, "fence-cap", []byte("before"), []byte("after"))
	b, _ := json.Marshal(editorFence{Version: 1, Token: 1, Namespace: "owner"})
	for i := 0; i < editorMaxFences; i++ {
		path := filepath.Join(f.state, editorKey("owner", fmt.Sprint(i))+".fence.json")
		if err := os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result := f.call(t, "editor.apply", req).(EditorApplyResult)
	if result.Outcome != "rejected" || result.Error.Code != "EDITOR_FENCING_REJECTED" {
		t.Fatalf("fence ceiling did not bound admission: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(f.state, editorKey(req.Namespace, req.Identity.WorkspaceIdentity)+".fence.json")); !os.IsNotExist(err) {
		t.Fatal("fence limit was exceeded")
	}
	// The rejected stage no longer pins ceilings. Inventory can run and free
	// orphan fences; it never overflows its scan cap and locks itself out.
	next := f.request(t, "after-cleanup", []byte("before"), []byte("after"))
	if result := f.call(t, "editor.apply", next).(EditorApplyResult); result.Outcome != "committed" {
		t.Fatal("bounded cleanup failed to reopen admission", result)
	}
}

func TestEditorFenceCleanupKeepsOutstandingStageCeiling(t *testing.T) {
	f := newEditorFixture(t, nil)
	s := f.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 0, IdleTimeoutMs: 30000}).(EditorStageHandle)
	ceiling := filepath.Join(f.state, editorKey("owner", "retired-root")+".fence.json")
	if err := f.e.save(ceiling, editorFence{Version: 1, Token: 4, Namespace: "owner"}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := f.e.inventory(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ceiling); err != nil {
		t.Fatal("outstanding stage lost its fence ceiling", err)
	}
	var stage editorStage
	if err := editorReadJSON(f.e.stagePath(s.StageID), &stage); err != nil {
		t.Fatal(err)
	}
	stage.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
	if err := f.e.save(f.e.stagePath(s.StageID), stage); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := f.e.inventory(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ceiling); !os.IsNotExist(err) {
		t.Fatal("expired stage permanently pinned orphan fence", err)
	}
}
