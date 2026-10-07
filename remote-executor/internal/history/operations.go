package history

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func (m *Manager) fault(phase string) error {
	if m.testFault != nil {
		return m.testFault(phase)
	}
	return nil
}

func boundedContext(ctx context.Context, duration time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, duration)
}

func (m *Manager) observe(ctx context.Context, b Binding, relative string, historical ...bool) (State, error) {
	validate := m.validate
	if len(historical) > 0 && historical[0] {
		validate = m.validateHistorical
	}
	if err := validate(b); err != nil {
		return State{}, err
	}
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	path, err := m.target(b, relative)
	if err != nil {
		return State{}, err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		if err := validate(b); err != nil {
			return State{}, err
		}
		return State{Kind: "absent"}, nil
	}
	if err != nil {
		return State{}, err
	}
	if !info.Mode().IsRegular() {
		return State{}, fmt.Errorf("unsupported_object")
	}
	incarnation, err := rootIdentity(path)
	if err != nil {
		return State{}, err
	}
	if info.Size() > BlobBytes {
		return State{}, fmt.Errorf("too_large")
	}
	f, err := os.Open(path)
	if err != nil {
		return State{}, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return State{}, err
	}
	if !os.SameFile(info, opened) {
		return State{}, fmt.Errorf("content_changed")
	}
	var metadata []byte
	if m.nativeIO.Capture != nil {
		metadata, err = m.nativeIO.Capture(ctx, f)
		if err != nil {
			return State{}, err
		}
		if len(metadata) > 512<<10 {
			return State{}, fmt.Errorf("native metadata budget")
		}
	}
	var data bytes.Buffer
	chunk := make([]byte, 64<<10)
	for {
		if err := ctx.Err(); err != nil {
			return State{}, err
		}
		n, e := f.Read(chunk)
		if int64(data.Len()+n) > BlobBytes {
			return State{}, fmt.Errorf("too_large")
		}
		data.Write(chunk[:n])
		if e == io.EOF {
			break
		}
		if e != nil {
			return State{}, e
		}
	}
	after, err := os.Lstat(path)
	if err != nil {
		return State{}, err
	}
	resolved, err := m.target(b, relative)
	if err != nil {
		return State{}, err
	}
	if resolved != path || !os.SameFile(info, after) || info.Size() != after.Size() || info.ModTime() != after.ModTime() || info.Mode() != after.Mode() || int64(data.Len()) != info.Size() {
		return State{}, fmt.Errorf("content_changed")
	}
	if err := validate(b); err != nil {
		return State{}, err
	}
	if m.nativeIO.Capture != nil {
		rechecked, err := m.nativeIO.Capture(ctx, f)
		if err != nil {
			return State{}, err
		}
		if !bytes.Equal(rechecked, metadata) {
			return State{}, fmt.Errorf("metadata_changed")
		}
	}
	var metadataObject *Object
	if metadata != nil {
		metadataObject, err = m.putObject(b, metadata, "blob", relative)
		if err != nil {
			return State{}, err
		}
	}
	object, err := m.putObject(b, data.Bytes(), "blob", relative)
	if err != nil {
		return State{}, err
	}
	checkedIncarnation, err := rootIdentity(path)
	if err != nil || checkedIncarnation != incarnation {
		return State{}, fmt.Errorf("content_changed")
	}
	return State{Kind: "regular", Object: object, Mode: uint32(info.Mode().Perm()), Metadata: metadataObject, Incarnation: incarnation}, nil
}

func stateEqual(a, b State) bool {
	if a.Kind != b.Kind {
		return false
	}
	if a.Kind == "absent" {
		return true
	}
	if a.Kind != "regular" || a.Object == nil || b.Object == nil {
		return false
	}
	metadataEqual := a.Metadata == nil && b.Metadata == nil || a.Metadata != nil && b.Metadata != nil && *a.Metadata == *b.Metadata
	return *a.Object == *b.Object && a.Mode == b.Mode && metadataEqual && (b.Incarnation == "" || a.Incarnation == b.Incarnation)
}

func matchesIntended(observed, intended State) bool {
	intended.Incarnation = observed.Incarnation
	if intended.Kind == "regular" && intended.Metadata == nil {
		intended.Metadata = observed.Metadata
	}
	return stateEqual(observed, intended)
}

func validState(state State) bool {
	return state.Kind == "absent" && state.Object == nil || state.Kind == "regular" && state.Object != nil && state.Mode & ^uint32(0777) == 0 && state.Mode == supportedMode(state.Mode) && state.Object.Kind == "blob"
}

func (m *Manager) prepareRequest(req Request, kind string) (*Receipt, bool, error) {
	if err := m.validate(req.Binding); err != nil {
		return nil, false, err
	}
	if req.OperationID == "" || len(req.OperationID) > 256 || !validDigest(req.RequestDigest) {
		return nil, false, fmt.Errorf("operationId/requestDigest required")
	}
	data, _ := json.Marshal(struct {
		Kind    string  `json:"kind"`
		Request Request `json:"request"`
	}{kind, req})
	digest := hash(data)
	existing, err := m.loadReceipt(req.Binding, req.OperationID)
	if err == nil {
		if existing.RequestDigest != req.RequestDigest || existing.PayloadDigest != digest || existing.Kind != kind {
			return nil, false, fmt.Errorf("operation digest conflict")
		}
		return existing, true, nil
	}
	if !os.IsNotExist(err) {
		return nil, false, err
	}
	return &Receipt{OperationID: req.OperationID, RequestDigest: req.RequestDigest, PayloadDigest: digest, Binding: req.Binding, Kind: kind, State: "intent", Effects: []Effect{}, StartedAt: now()}, false, nil
}

// Capture builds a private sparse tree manifest from explicitly admitted paths.
// Complete means complete selected-path evidence, NOT whole-directory coverage
// or single-instant consistency. Symlinks/directories/overlarge objects are partial.
func (m *Manager) Capture(ctx context.Context, req Request) (*Receipt, error) {
	ctx, cancel := boundedContext(ctx, 120*time.Second)
	defer cancel()
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	r, exists, err := m.prepareRequest(req, "capture")
	if err != nil || exists {
		return r, err
	}
	if len(req.Paths) == 0 || len(req.Paths) > MaxFiles {
		return nil, fmt.Errorf("capture path budget")
	}
	paths := append([]string(nil), req.Paths...)
	sort.Strings(paths)
	for i, path := range paths {
		if i > 0 && paths[i-1] == path {
			return nil, fmt.Errorf("duplicate capture path")
		}
		if _, err := m.target(req.Binding, path); err != nil {
			return nil, err
		}
	}
	if err := m.saveReceipt(r); err != nil {
		return nil, err
	}
	manifest := make([]Observation, 0, len(paths))
	coverage := "complete"
	var total int64
	for _, path := range paths {
		state, err := m.observe(ctx, req.Binding, path)
		observation := Observation{Path: path}
		if err != nil {
			coverage = "partial"
			observation.Error = err.Error()
		} else {
			if state.Object != nil {
				total += state.Object.SizeBytes
			}
			if total > EvidenceBytes {
				coverage = "partial"
				observation.Error = "budget_exceeded"
			} else {
				observation.State = &state
			}
		}
		manifest = append(manifest, observation)
		if ctx.Err() != nil {
			coverage = "partial"
			break
		}
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return r, err
	}
	tree, err := m.putObject(req.Binding, data, "tree", "")
	if err != nil {
		return r, err
	}
	r.Tree = tree
	r.Coverage = coverage
	r.TemporalConsistency = "concurrent_observation"
	r.State = "settled"
	r.FinishedAt = now()
	if coverage != "complete" {
		r.Reason = "capture_incomplete"
	}
	if err := m.saveReceipt(r); err != nil {
		return r, err
	}
	return r, nil
}

func (m *Manager) Mutate(ctx context.Context, req Request, kind string) (*Receipt, error) {
	ctx, cancel := boundedContext(ctx, 120*time.Second)
	defer cancel()
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	return m.mutate(ctx, req, kind, "")
}

func (m *Manager) mutate(ctx context.Context, req Request, kind, ignorePending string) (*Receipt, error) {
	r, exists, err := m.prepareRequest(req, kind)
	if err != nil || exists {
		return r, err
	}
	if len(req.Changes) == 0 || len(req.Changes) > MaxFiles {
		return nil, fmt.Errorf("restore file budget")
	}
	cursor := ""
	for {
		pending, next, err := m.pending(ctx, req.Binding, cursor, 100)
		if err != nil {
			return nil, err
		}
		for _, p := range pending {
			if p.OperationID != ignorePending && p.Kind != "capture" {
				return nil, fmt.Errorf("recovery_required: unsettled operation")
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	seen := map[string]bool{}
	var total int64
	for i := range req.Changes {
		change := &req.Changes[i]
		path, err := m.target(req.Binding, change.Path)
		if err != nil {
			return nil, err
		}
		if seen[path] {
			return nil, fmt.Errorf("duplicate change target")
		}
		seen[path] = true
		if !validState(change.Expected) || !validState(change.Desired) {
			return nil, fmt.Errorf("unsupported state")
		}
		if change.Desired.Kind == "regular" && change.Desired.Object.Path != change.Path {
			return nil, fmt.Errorf("desired object origin does not match mutation target")
		}
		before, err := m.observe(ctx, req.Binding, change.Path)
		if err != nil {
			return nil, err
		}
		if !stateEqual(before, change.Expected) {
			return nil, fmt.Errorf("content_changed: %s", change.Path)
		}
		if before.Kind == "regular" && m.nativeIO.Apply != nil && before.Metadata == nil {
			return nil, fmt.Errorf("missing_before_metadata")
		}
		if before.Kind == "regular" && m.nativeIO.Apply == nil {
			if m.nativeIO.Validate == nil || m.nativeIO.Replace == nil {
				return nil, fmt.Errorf("unsupported_metadata: native replacement adapter required")
			}
			if err := m.nativeIO.Validate(ctx, path, before, change.Desired); err != nil {
				return nil, err
			}
		}
		if before.Object != nil {
			total += before.Object.SizeBytes
		}
		desired := change.Desired
		if m.nativeIO.Apply != nil && desired.Kind == "regular" {
			if desired.Metadata == nil && before.Kind == "regular" {
				desired.Metadata = before.Metadata
			}
			if desired.Metadata != nil {
				metadata, err := m.objectBytes(req.Binding, *desired.Metadata)
				if err != nil {
					return nil, err
				}
				if before.Kind == "regular" && desired.Mode != before.Mode && desired.Metadata != nil && before.Metadata != nil && *desired.Metadata == *before.Metadata {
					if m.nativeIO.WithMode == nil {
						return nil, fmt.Errorf("native mode transform unavailable")
					}
					metadata, err = m.nativeIO.WithMode(ctx, metadata, desired.Mode)
					if err != nil {
						return nil, err
					}
					desired.Metadata, err = m.putObject(req.Binding, metadata, "blob", change.Path)
					if err != nil {
						return nil, err
					}
				}
				total += int64(len(metadata))
			}
		}
		if desired.Kind == "regular" {
			var data []byte
			if change.ContentBase64 != nil {
				if len(*change.ContentBase64) > int(BlobBytes+2)/3*4+4 {
					return nil, fmt.Errorf("too_large")
				}
				data, err = base64.StdEncoding.DecodeString(*change.ContentBase64)
				if err != nil || int64(len(data)) > BlobBytes {
					return nil, fmt.Errorf("invalid bounded content")
				}
				object, err := m.putObject(req.Binding, data, "blob", change.Path)
				if err != nil {
					return nil, err
				}
				if *object != *desired.Object {
					return nil, fmt.Errorf("desired content identity mismatch")
				}
			} else {
				data, err = m.objectBytes(req.Binding, *desired.Object)
				if err != nil {
					return nil, err
				}
			}
			total += int64(len(data))
		} else if change.ContentBase64 != nil {
			return nil, fmt.Errorf("absence must not contain bytes")
		}
		if total > EvidenceBytes {
			return nil, fmt.Errorf("operation evidence budget")
		}
		r.Effects = append(r.Effects, Effect{Path: change.Path, Before: before, Intended: desired, Outcome: "pending"})
	}
	if m.nativeIO.Apply != nil && m.nativeIO.Preflight != nil {
		var refusal error
		// Complete the whole batch's read-only admission before persisting ANY
		// effect as dispatching. Never partially apply a mixed-filesystem batch.
		for _, effect := range r.Effects {
			request, err := m.nativeRequest(ctx, req.Binding, effect)
			if err != nil {
				return nil, err
			}
			if err := m.nativeIO.Preflight(ctx, request); err != nil {
				if !errors.Is(err, ErrUnsupportedCrossFilesystem) {
					return nil, err
				}
				refusal = err
			}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := m.validate(req.Binding); err != nil {
			return nil, err
		}
		if refusal != nil {
			// This is refusal evidence, NOT successful IO or compensation. The
			// original op/digest/payload/fence remains durable and idempotent.
			r.State = "rejected"
			r.Reason = ErrUnsupportedCrossFilesystem.Error()
			r.FinishedAt = now()
			for i := range r.Effects {
				r.Effects[i].Intended = req.Changes[i].Desired
			}
			if err := m.saveReceipt(r); err != nil {
				return nil, err
			}
			return r, nil
		}
	}
	if err := m.saveReceipt(r); err != nil {
		return nil, err
	}
	if err := m.fault("intent"); err != nil {
		return r, err
	}
	r.State = "applying"
	if err := m.saveReceipt(r); err != nil {
		return r, err
	}
	for i := range r.Effects {
		effect := &r.Effects[i]
		if err := ctx.Err(); err != nil {
			r.State = "recovery_required"
			r.Reason = "cancelled"
			break
		}
		if err := m.validate(req.Binding); err != nil {
			r.State = "recovery_required"
			r.Reason = err.Error()
			break
		}
		// Persist per-effect dispatch admission BEFORE touching the target. A pending
		// entry is thus proven not dispatched; dispatching survives a lost IO receipt.
		effect.Outcome = "dispatching"
		if err := m.saveReceipt(r); err != nil {
			return r, err
		}
		if err := m.fault("dispatching"); err != nil {
			return r, err
		}
		if err := m.replace(ctx, req.Binding, *effect); err != nil {
			r.State = "recovery_required"
			r.Reason = err.Error()
			effect.Outcome = "unknown"
			break
		}
		if err := m.fault("io"); err != nil {
			return r, err
		}
		after, err := m.observe(ctx, req.Binding, effect.Path)
		if err != nil || !matchesIntended(after, effect.Intended) {
			r.State = "recovery_required"
			r.Reason = "after observation mismatch"
			effect.Outcome = "unknown"
			break
		}
		effect.After = &after
		effect.Outcome = "applied"
		if err := m.saveReceipt(r); err != nil {
			return r, err
		}
		if err := m.fault("ack"); err != nil {
			return r, err
		}
	}
	if r.State == "applying" {
		r.State = "settled"
	}
	r.FinishedAt = now()
	if err := m.saveReceipt(r); err != nil {
		return r, err
	}
	return r, nil
}

func (m *Manager) nativeRequest(ctx context.Context, b Binding, effect Effect) (NativeApplyRequest, error) {
	if err := ctx.Err(); err != nil {
		return NativeApplyRequest{}, err
	}
	path, err := m.target(b, effect.Path)
	if err != nil {
		return NativeApplyRequest{}, err
	}
	request := NativeApplyRequest{Path: path, Before: effect.Before, Desired: effect.Intended, PrivateRecoveryDirectory: filepath.Join(m.dir, "recovery")}
	for _, entry := range []struct {
		object *Object
		bytes  *[]byte
	}{
		{effect.Before.Object, &request.BeforeBytes},
		{effect.Intended.Object, &request.DesiredBytes},
		{effect.Before.Metadata, &request.BeforeMetadata},
		{effect.Intended.Metadata, &request.DesiredMetadata},
	} {
		if entry.object != nil {
			*entry.bytes, err = m.objectBytes(b, *entry.object)
			if err != nil {
				return NativeApplyRequest{}, err
			}
		}
	}
	return request, nil
}

// replace is executor-serialized conditional IO, not OS-level CAS against an
// external editor. It rechecks content/root immediately before replacement and
// records uncertainty rather than claiming an external writer was excluded.
func (m *Manager) replace(ctx context.Context, b Binding, effect Effect) error {
	if effect.Before.Kind == "absent" && m.nativeIO.Acquire != nil && m.nativeIO.Apply == nil {
		release, err := m.nativeIO.Acquire(ctx)
		if err != nil {
			return err
		}
		defer release()
	}
	current, err := m.observe(ctx, b, effect.Path)
	if err != nil {
		return err
	}
	if !stateEqual(current, effect.Before) {
		return fmt.Errorf("content_changed")
	}
	path, err := m.target(b, effect.Path)
	if err != nil {
		return err
	}
	if m.nativeIO.Apply != nil {
		request, err := m.nativeRequest(ctx, b, effect)
		if err != nil {
			return err
		}
		m.objectMu.Lock()
		admissionErr := m.admission(int64(len(request.BeforeBytes) + len(request.BeforeMetadata)))
		m.objectMu.Unlock()
		if admissionErr != nil {
			return admissionErr
		}
		return m.nativeIO.Apply(ctx, request)
	}
	if effect.Before.Kind == "regular" {
		before, err := m.objectBytes(b, *effect.Before.Object)
		if err != nil {
			return err
		}
		var desired []byte
		if effect.Intended.Kind == "regular" {
			desired, err = m.objectBytes(b, *effect.Intended.Object)
			if err != nil {
				return err
			}
		}
		if m.nativeIO.Replace == nil {
			return fmt.Errorf("unsupported_metadata: native replacement adapter required")
		}
		return m.nativeIO.Replace(ctx, path, effect.Intended, before, desired)
	}
	parent := filepath.Dir(path)
	parentInfo, err := os.Stat(parent)
	if err != nil || !parentInfo.IsDir() {
		return fmt.Errorf("parent must exist")
	}
	parentIdentity, err := rootIdentity(parent)
	if err != nil {
		return err
	}
	if effect.Intended.Kind == "absent" {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := m.validate(b); err != nil {
			return err
		}
		if _, err := m.target(b, effect.Path); err != nil {
			return err
		}
		if current.Kind != "absent" {
			if err := os.Remove(path); err != nil {
				return err
			}
		}
		return syncDir(parent)
	}
	data, err := m.objectBytes(b, *effect.Intended.Object)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(parent, ".narrafork-history-")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(os.FileMode(effect.Intended.Mode)); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := m.validate(b); err != nil {
		return err
	}
	if _, err := m.target(b, effect.Path); err != nil {
		return err
	}
	identity, err := rootIdentity(parent)
	if err != nil || identity != parentIdentity {
		return fmt.Errorf("parent identity changed")
	}
	current, err = m.observe(ctx, b, effect.Path)
	if err != nil || !stateEqual(current, effect.Before) {
		return fmt.Errorf("content_changed")
	}
	if err := durableRename(tempPath, path); err != nil {
		return err
	}
	return syncDir(parent)
}

func (m *Manager) Status(ctx context.Context, b Binding, id string) (*Receipt, error) {
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := m.validateHistorical(b); err != nil {
		return nil, err
	}
	return m.loadReceipt(b, id)
}

func (m *Manager) Finalize(ctx context.Context, b Binding, id, digest, serverCommit string) (*Receipt, error) {
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := m.validateHistorical(b); err != nil {
		return nil, err
	}
	r, err := m.loadReceipt(b, id)
	if err != nil {
		return nil, err
	}
	if r.RequestDigest != digest || serverCommit == "" || len(serverCommit) > 256 {
		return nil, fmt.Errorf("finalize commit/digest mismatch")
	}
	if r.State == "finalized" {
		if r.ServerCommitID != serverCommit {
			return nil, fmt.Errorf("finalize commit conflict")
		}
		return r, nil
	}
	proven := r.State == "applying" && len(r.Effects) > 0
	for _, effect := range r.Effects {
		if effect.Outcome != "applied" || effect.After == nil {
			proven = false
		}
	}
	if r.State != "settled" && !proven {
		return nil, fmt.Errorf("recovery_required: cannot finalize unsettled mutation")
	}
	for _, effect := range r.Effects {
		if effect.Outcome == "applied" && effect.After != nil {
			observed, err := m.observe(ctx, b, effect.Path)
			if err != nil || !stateEqual(observed, *effect.After) {
				return nil, fmt.Errorf("finalize_after_conflict: external modification; retain barrier")
			}
		}
	}
	r.State = "finalized"
	r.ServerCommitID = serverCommit
	if err := m.saveReceipt(r); err != nil {
		return r, err
	}
	return r, m.fault("finalize")
}

func (m *Manager) Compensate(ctx context.Context, req Request) (*Receipt, error) {
	ctx, cancel := boundedContext(ctx, 120*time.Second)
	defer cancel()
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	if err := m.validate(req.Binding); err != nil {
		return nil, err
	}
	original, err := m.loadReceipt(req.Binding, req.OriginalOperationID)
	if err != nil {
		return nil, err
	}
	if original.State == "finalized" {
		return nil, fmt.Errorf("cannot compensate finalized operation")
	}
	changes := []Change{}
	for _, effect := range original.Effects {
		if effect.Outcome == "pending" {
			continue
		}
		if effect.Outcome != "applied" || effect.After == nil {
			return nil, fmt.Errorf("recovery_required: compensation lacks mutation proof")
		}
		changes = append(changes, Change{Path: effect.Path, Expected: *effect.After, Desired: effect.Before})
	}
	if len(changes) == 0 {
		return nil, fmt.Errorf("no proven effects to compensate")
	}
	req.Changes = changes
	receipt, err := m.mutate(ctx, req, "compensate", original.OperationID)
	if err != nil {
		return receipt, err
	}
	if receipt.State == "settled" {
		// Compensation has no server history commit to wait for; keep both journals.
		receipt.State = "compensated"
		if err := m.saveReceipt(receipt); err != nil {
			return receipt, err
		}
		original.State = "compensated"
		if err := m.saveReceipt(original); err != nil {
			return receipt, err
		}
	}
	return receipt, nil
}

func (m *Manager) ReadObject(ctx context.Context, b Binding, object Object, offset, maxBytes int64) (*ObjectRead, error) {
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := m.validateHistorical(b); err != nil {
		return nil, err
	}
	if offset < 0 || maxBytes < 1 || maxBytes > ChunkBytes {
		return nil, fmt.Errorf("object chunk budget")
	}
	data, err := m.objectBytes(b, object)
	if err != nil {
		return nil, err
	}
	if offset > int64(len(data)) {
		return nil, fmt.Errorf("object offset out of range")
	}
	end := offset + maxBytes
	if end > int64(len(data)) {
		end = int64(len(data))
	}
	return &ObjectRead{Object: object, ContentBase64: base64.StdEncoding.EncodeToString(data[offset:end]), Offset: offset, EOF: end == int64(len(data))}, nil
}

func (m *Manager) Inspect(ctx context.Context, b Binding, paths []string, cursor string) (*Inspection, error) {
	ctx, cancel := boundedContext(ctx, 10*time.Second)
	defer cancel()
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	if err := m.validateHistorical(b); err != nil {
		return nil, err
	}
	if len(paths) > 100 {
		return nil, fmt.Errorf("inspection page budget")
	}
	result := &Inspection{Binding: b, Observations: []Observation{}}
	for _, path := range paths {
		state, err := m.observe(ctx, b, path, true)
		observation := Observation{Path: path}
		if err != nil {
			observation.Error = err.Error()
		} else {
			observation.State = &state
		}
		result.Observations = append(result.Observations, observation)
	}
	var err error
	result.Pending, result.NextCursor, err = m.pending(ctx, b, cursor, 100)
	return result, err
}
