package history

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestNativePreflightRefusesEntireBatchBeforeDispatch(t *testing.T) {
	m, b, root, _ := fixture(t)
	ctx := context.Background()
	var checked, applied int
	m.SetNativeMutationIO(NativeMutationIO{
		Preflight: func(ctx context.Context, request NativeApplyRequest) error {
			checked++
			if filepath.Base(request.Path) == "other.txt" {
				return ErrUnsupportedCrossFilesystem
			}
			return nil
		},
		Apply: func(context.Context, NativeApplyRequest) error { applied++; return nil },
	})
	req := request(b, "mixed", "new", State{Kind: "absent"})
	other := req.Changes[0]
	other.Path = "other.txt"
	object := *other.Desired.Object
	object.Path = other.Path
	object.ObjectID = objectID(b.ScopeID, "blob", other.Path, object.Digest)
	other.Desired.Object = &object
	req.Changes = append(req.Changes, other)
	r, err := m.Mutate(ctx, req, "restore")
	if err != nil || r == nil || r.State != "rejected" || r.Reason != "unsupported_cross_filesystem" {
		t.Fatal("missing explicit pre-dispatch refusal", r, err)
	}
	if checked != 2 || applied != 0 {
		t.Fatal("batch partially dispatched", checked, applied)
	}
	for _, effect := range r.Effects {
		if effect.Outcome != "pending" || effect.After != nil {
			t.Fatal("refusal fabricated IO proof", effect)
		}
		if _, err := os.Stat(filepath.Join(root, effect.Path)); !os.IsNotExist(err) {
			t.Fatal("refusal touched target", err)
		}
	}
	retry, err := m.Mutate(ctx, req, "restore")
	if err != nil || retry.State != "rejected" || checked != 2 {
		t.Fatal("refusal retry was not immutable", retry, err)
	}
	conflict := req
	conflict.Changes = append([]Change(nil), req.Changes...)
	conflict.Changes[0].Desired = State{Kind: "absent"}
	conflict.Changes[0].ContentBase64 = nil
	if _, err := m.Mutate(ctx, conflict, "restore"); err == nil {
		t.Fatal("rejected operation ID accepted a different payload")
	}
	if checked != 2 || applied != 0 {
		t.Fatal("conflicting refusal replay reached adapter", checked, applied)
	}
	if _, err := m.Finalize(ctx, b, req.OperationID, req.RequestDigest, "fake-commit"); err == nil {
		t.Fatal("refusal finalized as completed mutation")
	}
	if pending, _, err := m.pending(ctx, b, "", 100); err != nil || len(pending) != 0 {
		t.Fatal("refusal polluted pending scope", pending, err)
	}
	if _, err := m.Open(ctx, root, b.ScopeID, b.Fence+1); err != nil {
		t.Fatal("refusal polluted next fence", err)
	}
}

func TestNativePreflightDoesNotTreatEXDEVOrStringsAsRefusal(t *testing.T) {
	for _, fail := range []error{syscall.EXDEV, errors.New("unsupported_cross_filesystem"), context.Canceled} {
		t.Run(fail.Error(), func(t *testing.T) {
			m, b, _, _ := fixture(t)
			m.SetNativeMutationIO(NativeMutationIO{
				Preflight: func(context.Context, NativeApplyRequest) error { return fail },
				Apply:     func(context.Context, NativeApplyRequest) error { t.Fatal("unexpected dispatch"); return nil },
			})
			r, err := m.Mutate(context.Background(), request(b, "refuse", "new", State{Kind: "absent"}), "mutate")
			if !errors.Is(err, fail) || r != nil {
				t.Fatal("error incorrectly promoted to refusal proof", r, err)
			}
		})
	}
}

func TestNativeRefusalAfterDispatchStillUnknown(t *testing.T) {
	m, b, _, _ := fixture(t)
	m.SetNativeMutationIO(NativeMutationIO{
		Preflight: func(context.Context, NativeApplyRequest) error { return nil },
		Apply:     func(context.Context, NativeApplyRequest) error { return ErrUnsupportedCrossFilesystem },
	})
	r, err := m.Mutate(context.Background(), request(b, "race", "new", State{Kind: "absent"}), "mutate")
	if err != nil || r.State != "recovery_required" || r.Effects[0].Outcome != "unknown" {
		t.Fatal("post-admission mount race falsely proven undispatched", r, err)
	}
}

func TestLegacyNativeAdapterCannotUpgradeErrorToNoDispatchProof(t *testing.T) {
	m, b, _, _ := fixture(t)
	m.SetNativeMutationIO(NativeMutationIO{
		Apply: func(context.Context, NativeApplyRequest) error { return ErrUnsupportedCrossFilesystem },
	})
	r, err := m.Mutate(context.Background(), request(b, "legacy", "new", State{Kind: "absent"}), "mutate")
	if err != nil || r.State != "recovery_required" || r.Effects[0].Outcome != "unknown" {
		t.Fatal("missing preflight capability upgraded legacy uncertainty", r, err)
	}
}

func TestNativePreflightCancellationAndRootReplacement(t *testing.T) {
	for _, replaceRoot := range []bool{false, true} {
		m, b, root, _ := fixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		m.SetNativeMutationIO(NativeMutationIO{
			Preflight: func(context.Context, NativeApplyRequest) error {
				if replaceRoot {
					if err := os.Rename(root, root+"-old"); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(root, 0700); err != nil {
						t.Fatal(err)
					}
				} else {
					cancel()
				}
				return ErrUnsupportedCrossFilesystem
			},
			Apply: func(context.Context, NativeApplyRequest) error { t.Fatal("unexpected dispatch"); return nil },
		})
		r, err := m.Mutate(ctx, request(b, "cancel", "new", State{Kind: "absent"}), "mutate")
		if err == nil || r != nil {
			t.Fatal("changed/cancelled binding gained refusal proof", r, err)
		}
	}
}
