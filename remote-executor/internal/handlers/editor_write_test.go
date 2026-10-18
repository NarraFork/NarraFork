package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type editorFixture struct {
	h                 *Handlers
	e                 *EditorEngine
	root, path, state string
	identity          EditorResourceIdentity
}

func newEditorFixture(t *testing.T, before []byte) *editorFixture {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "document")
	if before != nil {
		if err := os.WriteFile(path, before, 0o640); err != nil {
			t.Fatal(err)
		}
	}
	h := New(NewPathGuard([]string{root}), 128*1024)
	state := filepath.Join(t.TempDir(), "state")
	e, err := NewEditorEngine(h, state)
	if err != nil {
		t.Fatal(err)
	}
	h.SetEditorEngine(e)
	canonical, identity, err := h.EditorRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	return &editorFixture{h: h, e: e, root: root, path: filepath.Join(canonical, "document"), state: state, identity: EditorResourceIdentity{DeviceID: "fixture-device", PathFlavor: EditorPathFlavor(), CanonicalPath: filepath.Join(canonical, "document"), WorkspaceIdentity: identity, RuntimeEpoch: EditorRuntimeEpoch(), RuntimeGeneration: 1, FencingToken: 1}}
}
func editorParams(t *testing.T, value any) map[string]any {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err = json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
func (f *editorFixture) call(t *testing.T, method string, value any) any {
	t.Helper()
	r, err := f.h.EditorDispatch(context.Background(), method, editorParams(t, value))
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return r
}
func (f *editorFixture) stage(t *testing.T, body []byte) string {
	t.Helper()
	s := f.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: int64(len(body)), IdleTimeoutMs: 30000}).(EditorStageHandle)
	for offset, seq := 0, int64(0); offset < len(body); seq++ {
		end := min(offset+int(f.e.chunkBytes), len(body))
		b := body[offset:end]
		f.call(t, "editor.stage.append", EditorStageAppend{Namespace: "owner", ResourceKey: "resource", StageID: s.StageID, Seq: seq, Offset: int64(offset), Bytes: int64(len(b)), Digest: editorDigest(b), DataB64: base64.StdEncoding.EncodeToString(b)})
		offset = end
	}
	f.call(t, "editor.stage.seal", EditorStageSeal{Namespace: "owner", ResourceKey: "resource", StageID: s.StageID, TotalBytes: int64(len(body)), RawDigest: editorDigest(body)})
	return s.StageID
}
func (f *editorFixture) request(t *testing.T, id string, before, body []byte) EditorApplyRequest {
	t.Helper()
	var expected *string
	if before != nil {
		d := editorDigest(before)
		expected = &d
	}
	return EditorApplyRequest{Namespace: "owner", ResourceKey: "resource", OperationID: id, RequestDigest: editorDigest([]byte(id)), StageID: f.stage(t, body), ExpectedRawHash: expected, Identity: f.identity, MetadataPolicy: "preserve"}
}
func (f *editorFixture) query(t *testing.T, req EditorApplyRequest) EditorQueryResult {
	t.Helper()
	return f.call(t, "editor.query", EditorQueryRequest{Namespace: req.Namespace, ResourceKey: req.ResourceKey, OperationID: req.OperationID, RequestDigest: req.RequestDigest}).(EditorQueryResult)
}
func (f *editorFixture) restart(t *testing.T) {
	t.Helper()
	e, err := NewEditorEngine(f.h, f.state)
	if err != nil {
		t.Fatal(err)
	}
	f.e = e
	f.h.SetEditorEngine(e)
}
func TestEditorDurableWriteSizesReplayAndRestart(t *testing.T) {
	for _, size := range []int{0, 3 * 1024 * 1024, 20 * 1024 * 1024} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			before := bytes.Repeat([]byte("b"), size)
			body := bytes.Repeat([]byte("n"), size)
			f := newEditorFixture(t, before)
			req := f.request(t, "operation", before, body)
			renames := 0
			f.e.fault = func(point string) error {
				if point == "renamed" {
					renames++
				}
				return nil
			}
			result := f.call(t, "editor.apply", req).(EditorApplyResult)
			if result.Outcome != "committed" || *result.RawDigest != editorDigest(body) || *result.TotalBytes != int64(size) {
				t.Fatalf("bad commit: %+v", result)
			}
			// Lose the success result: only durable query is used to recover it.
			if q := f.query(t, req); q.Outcome != "committed" {
				t.Fatalf("lost result query: %+v", q)
			}
			if got := f.call(t, "editor.apply", req).(EditorApplyResult); got.Outcome != "committed" || renames != 1 {
				t.Fatal("replay renamed again", renames)
			}
			f.restart(t)
			if q := f.query(t, req); q.Outcome != "committed" {
				t.Fatalf("restart lost receipt: %+v", q)
			}
			if got := f.call(t, "editor.apply", req).(EditorApplyResult); got.Outcome != "committed" {
				t.Fatalf("restart replay: %+v", got)
			}
			different := req
			different.RequestDigest = editorDigest([]byte("different"))
			if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, different)); err == nil {
				t.Fatal("same op different digest accepted")
			}
			different = req
			different.ResourceKey = "other"
			if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, different)); err == nil {
				t.Fatal("other resource read receipt")
			}
			got, err := os.ReadFile(f.path)
			if err != nil || !bytes.Equal(got, body) {
				t.Fatal("body mismatch", err)
			}
			if err = os.RemoveAll(f.root); err != nil {
				t.Fatal(err)
			}
			if q := f.query(t, req); q.Outcome != "committed" {
				t.Fatal("historical receipt requires live root")
			}
		})
	}
}
func TestEditorFailureBoundariesNeverInferSuccess(t *testing.T) {
	for _, point := range []string{"intent", "prepared", "applying", "renamed", "receipt"} {
		t.Run(point, func(t *testing.T) {
			f := newEditorFixture(t, []byte("before"))
			req := f.request(t, "crash", []byte("before"), []byte("after"))
			f.e.fault = func(at string) error {
				if at == point {
					return errors.New("injected crash")
				}
				return nil
			}
			if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, req)); err == nil {
				t.Fatal("crash injection did not execute")
			}
			f.restart(t)
			q := f.query(t, req)
			expected := "uncertain"
			if point == "intent" || point == "prepared" {
				expected = "rejected"
			}
			if q.Outcome != expected {
				t.Fatalf("%s recovered %+v", point, q)
			}
			got, _ := os.ReadFile(f.path)
			written := point == "renamed" || point == "receipt"
			if (string(got) == "after") != written {
				t.Fatalf("wrong crash window %q", got)
			}
			if q.Result.RawDigest != nil {
				t.Fatal("uncertain promoted to saved by current hash")
			}
			if q2 := f.query(t, req); q2.Outcome != expected {
				t.Fatal("unstable recovery")
			}
			if point == "applying" || written {
				if _, err := os.Stat(f.e.bodyPath(req.StageID)); err != nil {
					t.Fatal("uncertain evidence deleted", err)
				}
			}
		})
	}
}
func TestEditorCancellationBeforeAndAfterDispatch(t *testing.T) {
	for _, point := range []string{"prepared", "applying", "renamed"} {
		t.Run(point, func(t *testing.T) {
			f := newEditorFixture(t, []byte("before"))
			req := f.request(t, "cancel", []byte("before"), []byte("after"))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.e.fault = func(at string) error {
				if at == point {
					cancel()
				}
				return nil
			}
			result, err := f.h.EditorDispatch(ctx, "editor.apply", editorParams(t, req))
			if err != nil {
				t.Fatal(err)
			}
			want := "committed"
			if point == "prepared" {
				want = "rejected"
			}
			if result.(EditorApplyResult).Outcome != want {
				t.Fatalf("cancel %s: %+v", point, result)
			}
			if f.query(t, req).Outcome != want {
				t.Fatal("cancel lost durable evidence")
			}
		})
	}
	f := newEditorFixture(t, nil)
	req := f.request(t, "early", nil, []byte("new"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.h.EditorDispatch(ctx, "editor.apply", editorParams(t, req)); !errors.Is(err, context.Canceled) {
		t.Fatal("predispatch cancel not honored", err)
	}
	if f.query(t, req).Outcome != "not_found" {
		t.Fatal("cancel before admission created operation")
	}
}
func TestEditorManagedSameBaselineAndAbsentNoReplace(t *testing.T) {
	f := newEditorFixture(t, []byte("base"))
	a := f.request(t, "a", []byte("base"), []byte("one"))
	b := f.request(t, "b", []byte("base"), []byte("two"))
	var wg sync.WaitGroup
	outcomes := make(chan string, 2)
	for _, req := range []EditorApplyRequest{a, b} {
		wg.Add(1)
		go func(req EditorApplyRequest) {
			defer wg.Done()
			v, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, req))
			if err != nil {
				t.Error(err)
				return
			}
			outcomes <- v.(EditorApplyResult).Outcome
		}(req)
	}
	wg.Wait()
	close(outcomes)
	committed := 0
	for o := range outcomes {
		if o == "committed" {
			committed++
		}
	}
	if committed != 1 {
		t.Fatal("managed baseline overwrite", committed)
	}
	absent := newEditorFixture(t, nil)
	req := absent.request(t, "absent", nil, []byte("next"))
	absent.e.fault = func(point string) error {
		if point == "applying" {
			return os.WriteFile(absent.path, []byte("external"), 0600)
		}
		return nil
	}
	r := absent.call(t, "editor.apply", req).(EditorApplyResult)
	if r.Outcome == "committed" {
		t.Fatal("no-replace overwrote external creator")
	}
	got, _ := os.ReadFile(absent.path)
	if string(got) != "external" {
		t.Fatal("absent install replaced existing target")
	}
}
func TestEditorBindingsAndFinalRechecks(t *testing.T) {
	for _, kind := range []string{"epoch", "fence", "root", "parent", "source", "metadata", "canonical", "outside", "missing-parent"} {
		t.Run(kind, func(t *testing.T) {
			f := newEditorFixture(t, []byte("before"))
			req := f.request(t, "bound", []byte("before"), []byte("after"))
			switch kind {
			case "epoch":
				req.Identity.RuntimeEpoch = "stale"
			case "fence":
				if err := f.e.save(filepath.Join(f.e.root, editorKey(req.Namespace, req.Identity.WorkspaceIdentity)+".fence.json"), editorFence{Version: 1, Token: 2, Namespace: req.Namespace}); err != nil {
					t.Fatal(err)
				}
			case "root":
				req.Identity.WorkspaceIdentity = strings.Replace(req.Identity.WorkspaceIdentity, "[", "[\"bad\",", 1)
			case "canonical":
				req.Identity.CanonicalPath = filepath.Join(f.root, "..", filepath.Base(f.root), "document") + string(os.PathSeparator) + ".." + string(os.PathSeparator) + "document"
			case "outside":
				req.Identity.CanonicalPath = filepath.Join(t.TempDir(), "outside")
			case "missing-parent":
				req.ExpectedRawHash = nil
				req.Identity.CanonicalPath = filepath.Join(f.root, "missing", "new")
			case "parent":
				f.e.fault = func(point string) error {
					if point == "prepared" {
						if err := os.Rename(f.root, f.root+"-moved"); err != nil {
							return err
						}
						if err := os.Mkdir(f.root, 0700); err != nil {
							return err
						}
						return os.WriteFile(f.path, []byte("before"), 0600)
					}
					return nil
				}
				t.Cleanup(func() { os.RemoveAll(f.root + "-moved") })
			case "source":
				f.e.fault = func(point string) error {
					if point == "prepared" {
						if err := os.Rename(f.path, f.path+".old"); err != nil {
							return err
						}
						return os.WriteFile(f.path, []byte("before"), 0600)
					}
					return nil
				}
			case "metadata":
				f.e.fault = func(point string) error {
					if point == "prepared" {
						return os.Chmod(f.path, 0o400)
					}
					return nil
				}
			}
			result := f.call(t, "editor.apply", req).(EditorApplyResult)
			if result.Outcome != "rejected" {
				t.Fatalf("%s not rejected: %+v", kind, result)
			}
			if kind == "missing-parent" {
				if _, err := os.Stat(filepath.Join(f.root, "missing")); !os.IsNotExist(err) {
					t.Fatal("created target parent")
				}
			}
		})
	}
}
func TestEditorStageProtocolAndQuotas(t *testing.T) {
	f := newEditorFixture(t, nil)
	open := EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 3, IdleTimeoutMs: 30000}
	s := f.call(t, "editor.stage.open", open).(EditorStageHandle)
	appendReq := EditorStageAppend{Namespace: "owner", ResourceKey: "resource", StageID: s.StageID, Seq: 0, Offset: 0, Bytes: 3, Digest: editorDigest([]byte("abc")), DataB64: base64.StdEncoding.EncodeToString([]byte("abc"))}
	f.call(t, "editor.stage.append", appendReq)
	f.call(t, "editor.stage.append", appendReq)
	bad := appendReq
	bad.Digest = editorDigest([]byte("xyz"))
	bad.DataB64 = base64.StdEncoding.EncodeToString([]byte("xyz"))
	if _, err := f.h.EditorDispatch(context.Background(), "editor.stage.append", editorParams(t, bad)); err == nil {
		t.Fatal("different duplicate accepted")
	}
	bad = appendReq
	bad.Namespace = "other"
	if _, err := f.h.EditorDispatch(context.Background(), "editor.stage.append", editorParams(t, bad)); err == nil {
		t.Fatal("namespace stage leak")
	}
	bad = appendReq
	bad.ResourceKey = "other"
	if _, err := f.h.EditorDispatch(context.Background(), "editor.stage.append", editorParams(t, bad)); err == nil {
		t.Fatal("resource stage leak")
	}
	bad = appendReq
	bad.StageID = "../../arbitrary"
	if _, err := f.h.EditorDispatch(context.Background(), "editor.stage.append", editorParams(t, bad)); err == nil {
		t.Fatal("arbitrary stage path accepted")
	}
	seal := EditorStageSeal{Namespace: "owner", ResourceKey: "resource", StageID: s.StageID, TotalBytes: 3, RawDigest: editorDigest([]byte("abc"))}
	f.call(t, "editor.stage.seal", seal)
	f.call(t, "editor.stage.seal", seal)
	seal.RawDigest = editorDigest([]byte("other"))
	if _, err := f.h.EditorDispatch(context.Background(), "editor.stage.seal", editorParams(t, seal)); err == nil {
		t.Fatal("seal mismatch accepted")
	}
	f.call(t, "editor.stage.abort", EditorStageAbort{Namespace: "owner", ResourceKey: "resource", StageID: s.StageID, Reason: "cancel"})
	for i := 0; i < editorMaxStages; i++ {
		f.call(t, "editor.stage.open", open)
	}
	if _, err := f.h.EditorDispatch(context.Background(), "editor.stage.open", editorParams(t, open)); err == nil {
		t.Fatal("stage count quota not enforced")
	}
	g := newEditorFixture(t, nil)
	for i := 0; i < 6; i++ {
		g.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: EditorMaxBytes, IdleTimeoutMs: 30000})
	}
	if _, err := g.h.EditorDispatch(context.Background(), "editor.stage.open", editorParams(t, EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: EditorMaxBytes, IdleTimeoutMs: 30000})); err == nil {
		t.Fatal("reserved staging byte quota not enforced")
	}
	if _, err := g.h.EditorDispatch(context.Background(), "editor.stage.open", editorParams(t, EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: EditorMaxBytes + 1, IdleTimeoutMs: 30000})); err == nil {
		t.Fatal("20MiB budget not enforced")
	}
}
func TestEditorRequiredNullAndNoGuessQuery(t *testing.T) {
	f := newEditorFixture(t, nil)
	req := f.request(t, "null", nil, []byte("new"))
	params := editorParams(t, req)
	delete(params, "expectedRawHash")
	if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", params); err == nil {
		t.Fatal("missing expected hash silently treated absent")
	}
	if f.query(t, req).Outcome != "not_found" {
		t.Fatal("missing nullable field dispatched")
	}
	params["expectedRawHash"] = nil
	if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", params); err != nil {
		t.Fatal(err)
	}
	if f.query(t, req).Outcome != "committed" {
		t.Fatal("explicit null did not create")
	}
	q := EditorQueryRequest{Namespace: "wrong-owner", ResourceKey: req.ResourceKey, OperationID: req.OperationID, RequestDigest: req.RequestDigest}
	if r := f.call(t, "editor.query", q).(EditorQueryResult); r.Outcome != "not_found" || r.Result != nil {
		t.Fatal("query disclosed other namespace")
	}
	q.Namespace = req.Namespace
	q.ResourceKey = "wrong-resource"
	if _, err := f.h.EditorDispatch(context.Background(), "editor.query", editorParams(t, q)); err == nil {
		t.Fatal("query disclosed other resource")
	}
}
func TestEditorExpiredUndispatchedCleanupPreservesUncertain(t *testing.T) {
	f := newEditorFixture(t, []byte("before"))
	req := f.request(t, "pending", []byte("before"), []byte("after"))
	f.e.fault = func(point string) error {
		if point == "applying" {
			return errors.New("interrupted")
		}
		return nil
	}
	if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, req)); err == nil {
		t.Fatal("fault not reached")
	}
	var stage editorStage
	if err := editorReadJSON(f.e.stagePath(req.StageID), &stage); err != nil {
		t.Fatal(err)
	}
	stage.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
	if err := f.e.save(f.e.stagePath(req.StageID), &stage); err != nil {
		t.Fatal(err)
	}
	f.restart(t)
	if f.query(t, req).Outcome != "uncertain" {
		t.Fatal("interrupted pending not uncertain")
	}
	f.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 1, IdleTimeoutMs: 30000})
	if _, err := os.Stat(f.e.bodyPath(req.StageID)); err != nil {
		t.Fatal("TTL destroyed uncertain evidence")
	}
	if _, err := f.h.EditorDispatch(context.Background(), "editor.stage.abort", editorParams(t, EditorStageAbort{Namespace: "owner", ResourceKey: "resource", StageID: req.StageID, Reason: "cancel"})); err == nil {
		t.Fatal("abort destroyed dispatched evidence")
	}
}

func TestEditorReceiptQuotaAndExpiredStageCleanup(t *testing.T) {
	f := newEditorFixture(t, []byte("before"))
	req := f.request(t, "at-quota", []byte("before"), []byte("after"))
	for i := 0; i < editorMaxReceipts; i++ {
		r := editorReceipt{Version: 1, State: "rejected", Request: EditorApplyRequest{Namespace: "inventory", ResourceKey: "other", OperationID: fmt.Sprint(i), RequestDigest: editorDigest([]byte(fmt.Sprint(i)))}, Result: editorFailure(fmt.Sprint(i), "rejected", "EDITOR_APPLY_REJECTED", "fixture")}
		b, _ := json.Marshal(r)
		if err := os.WriteFile(f.e.receiptPath("inventory", r.Request.OperationID), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.h.EditorDispatch(context.Background(), "editor.apply", editorParams(t, req)); err == nil {
		t.Fatal("durable receipt quota did not reject before dispatch")
	}
	if q := f.query(t, req); q.Outcome != "not_found" {
		t.Fatal("quota rejection created write evidence")
	}
	got, _ := os.ReadFile(f.path)
	if string(got) != "before" {
		t.Fatal("quota modified target")
	}
	g := newEditorFixture(t, nil)
	s := g.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 1, IdleTimeoutMs: 30000}).(EditorStageHandle)
	var expired editorStage
	if err := editorReadJSON(g.e.stagePath(s.StageID), &expired); err != nil {
		t.Fatal(err)
	}
	expired.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
	if err := g.e.save(g.e.stagePath(s.StageID), &expired); err != nil {
		t.Fatal(err)
	}
	g.call(t, "editor.stage.open", EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 1, IdleTimeoutMs: 30000})
	if _, err := os.Stat(g.e.bodyPath(s.StageID)); !os.IsNotExist(err) {
		t.Fatal("expired undispatched stage leaked")
	}
}

func TestEditorNoncooperatingWriterIsNotOSCAS(t *testing.T) {
	f := newEditorFixture(t, []byte("before"))
	req := f.request(t, "external-boundary", []byte("before"), []byte("ours"))
	f.e.fault = func(point string) error {
		if point == "applying" {
			return os.WriteFile(f.path, []byte("external"), 0640)
		}
		return nil
	}
	r := f.call(t, "editor.apply", req).(EditorApplyResult)
	if r.Outcome != "committed" {
		t.Fatalf("managed replacement result: %+v", r)
	}
	got, _ := os.ReadFile(f.path)
	if string(got) != "ours" {
		t.Fatal("fixture did not exercise post-check external write")
	}
	// This explicitly records the limit: managed writers serialize, but an
	// unrelated writer after the final check is not protected by an OS CAS.
}
