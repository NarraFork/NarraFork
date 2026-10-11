//go:build windows

package handlers

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/history"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
	"golang.org/x/sys/windows"
)

// Test-only in-process transport; uses the actual production adapter, challenge,
// ticket verifier, helper and protected store, NOT a general production admission.
type publicationNativeTransport struct {
	helper *windowsbackup.Helper
	peer   windowsbackup.PeerIdentity
}

func (p publicationNativeTransport) Challenge(ctx context.Context, o windowsbackup.ChallengeOrigin, r windowsbackup.MetadataCallback, f *os.File) (*windowsbackup.MetadataCallback, error) {
	return p.helper.Challenge(ctx, p.peer, o, r, f)
}
func (p publicationNativeTransport) Execute(ctx context.Context, raw []byte, f *os.File, proof *windowsbackup.CaptureProof) (*windowsbackup.OperationResult, error) {
	var signed windowsbackup.SignedTicket
	if err := json.Unmarshal(raw, &signed); err != nil {
		return nil, err
	}
	data, err := base64.RawURLEncoding.DecodeString(signed.Payload)
	if err != nil {
		return nil, err
	}
	var ticket windowsbackup.Ticket
	if err := json.Unmarshal(data, &ticket); err != nil {
		return nil, err
	}
	return p.helper.Execute(ctx, raw, p.peer, ticket.ChallengeNonce, f, proof)
}

type publicationNativeChannel struct {
	*windowsbackup.AuthorizedChannel
	t        *testing.T
	captures int
	changed  bool
	proofs   []*windowsbackup.Descriptor
}

func (c *publicationNativeChannel) Capture(ctx context.Context, f *os.File) (*windowsbackup.Descriptor, error) {
	c.captures++
	if c.changed && c.captures == 2 {
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info); err != nil {
			return nil, err
		}
		stamp := info.LastWriteTime
		ticks := uint64(stamp.HighDateTime)<<32 | uint64(stamp.LowDateTime)
		ticks += 10000000
		stamp.HighDateTime = uint32(ticks >> 32)
		stamp.LowDateTime = uint32(ticks)
		if err := windows.SetFileTime(windows.Handle(f.Fd()), nil, nil, &stamp); err != nil {
			return nil, err
		}
	}
	d, err := c.AuthorizedChannel.Capture(ctx, f)
	if err == nil {
		c.proofs = append(c.proofs, d)
	}
	return d, err
}

func TestWindowsAttachmentPublicationActualAdapter(t *testing.T) {
	scratch := os.Getenv("NARRAFORK_NATIVE_PATH_TEST_ROOT")
	if scratch == "" {
		t.Skip("explicit Windows scratch root required")
	}
	if !filepath.IsAbs(os.Getenv("TEMP")) || !strings.EqualFold(filepath.Clean(scratch), filepath.Clean(os.TempDir())) {
		t.Fatal("TEMP and NARRAFORK_NATIVE_PATH_TEST_ROOT must equal the allocated scratch root")
	}
	for _, changed := range []bool{false, true} {
		name := "same-object-rename"
		if changed {
			name = "full-matrix-lastwrite-change"
		}
		t.Run(name, func(t *testing.T) {
			root := nativePathFixture(t)
			guard := NewPathGuard([]string{root})
			h := New(guard, 10<<20)
			m, err := history.New(filepath.Join(t.TempDir(), "history"), func(path string, create bool) (string, error) {
				if create {
					return guard.CheckCreate(path)
				}
				return guard.CheckExisting(path)
			})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			h.SetHistory(m)
			if err := h.ConfigureAttachmentStateDirectory(filepath.Join(t.TempDir(), "attachments")); err != nil {
				t.Fatal(err)
			}
			binding, err := m.Open(context.Background(), root, "attachment-scope", 1)
			if err != nil {
				t.Fatal(err)
			}
			_, key, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			_, helperKey, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			store, err := windowsbackup.NewProtectedStore(windowsbackup.StoreConfig{Directory: filepath.Join(t.TempDir(), "protected"), HelperInstanceID: "fixture-helper", ServiceSID: "S-1-5-80-1-2-3-4-5", KeyEpoch: 7, SigningKey: helperKey})
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			ops, err := NewWindowsBackupNativeOperations(h, []string{root}, nil, store)
			if err != nil {
				t.Fatal(err)
			}
			nativeRoot := ops.ApprovedRoots()[0]
			now := uint64(time.Now().UnixMilli())
			base := windowsbackup.Ticket{Version: 1, Issuer: "fixture-issuer", ServiceID: "fixture-service", KeyEpoch: 2, DeviceID: "device", ExecutorSourceID: "source", HelperInstanceID: "fixture-helper", ConnectionID: "connection", SessionID: "session", RuntimeGeneration: 1, ActorSubjectKey: "actor", OriginRefHash: strings.Repeat("a", 64), Action: "capture_exact", BudgetClass: "metadata", ScopeID: "scope", Root: nativeRoot, Parent: nativeRoot, Target: nativeRoot, OperationID: "operation", RequestDigest: strings.Repeat("b", 64), LeaseID: "lease", Fence: 1, IssuedAt: now, ExpiresAt: now + 30000}
			peer := windowsbackup.PeerIdentity{PID: 42, CreationTime: 1, SID: "user", ServiceSID: "service", ExecutorInstance: "executor"}
			session := windowsbackup.Session{Peer: peer, DeviceID: base.DeviceID, SourceID: base.ExecutorSourceID, HelperInstanceID: base.HelperInstanceID, ConnectionID: base.ConnectionID, SessionID: base.SessionID, Generation: 1}
			verifier := &windowsbackup.Verifier{Keys: []windowsbackup.IssuerKey{{Issuer: base.Issuer, ServiceID: base.ServiceID, Epoch: base.KeyEpoch, PublicKey: key.Public().(ed25519.PublicKey)}}, Roots: []windowsbackup.NativeDescriptor{nativeRoot}, Session: session}
			helper, err := windowsbackup.NewHelper(verifier, store, ops)
			if err != nil {
				t.Fatal(err)
			}
			transport := publicationNativeTransport{helper, peer}
			origin := windowsbackup.ChallengeOrigin{DeviceID: base.DeviceID, ExecutorSourceID: base.ExecutorSourceID, ScopeID: base.ScopeID, Root: nativeRoot, OperationID: base.OperationID, RequestDigest: base.RequestDigest, LeaseID: base.LeaseID, Fence: base.Fence, RuntimeGeneration: base.RuntimeGeneration, HelperInstanceID: base.HelperInstanceID, ConnectionID: base.ConnectionID, SessionID: base.SessionID}
			issuer := &windowsbackup.CallbackTicketIssuer{Transport: transport, HelperPublicKey: helperKey.Public().(ed25519.PublicKey), Original: func(context.Context) (windowsbackup.ChallengeOrigin, error) { return origin, nil }, Describe: func(ctx context.Context, f *os.File, o windowsbackup.ChallengeOrigin) (windowsbackup.NativeObservation, error) {
				return ops.DescribeOrdinary(ctx, o.Root, f)
			}}
			actions := map[string]int{}
			ctx := windowsbackup.WithMetadataControl(context.Background(), session, "fixture-rpc", func(_ context.Context, raw []byte) ([]byte, error) {
				var r windowsbackup.MetadataCallback
				if err := json.Unmarshal(raw, &r); err != nil {
					return nil, err
				}
				if r.Action != "capture_exact" && r.Action != "status_original" {
					return nil, fmt.Errorf("fixture mutation action forbidden")
				}
				actions[r.Action]++
				ticket := base
				ticket.Action = r.Action
				ticket.Root = r.Descriptors.Root
				ticket.Parent = r.Descriptors.Parent
				ticket.Target = r.Descriptors.Target
				ticket.CaptureProofID = r.ProofIDs.CaptureProofID
				ticket.PreparedObjectID = r.ProofIDs.PreparedObjectID
				ticket.ExpectedCurrentMetadataHash = r.ExpectedCurrent.MetadataHash
				ticket.ExpectedCurrentContentHash = r.ExpectedCurrent.ContentHash
				ticket.Nonce = r.Nonce
				ticket.ChallengeNonce = r.HelperChallenge.ChallengeNonce
				data, err := windowsbackup.CanonicalJSON(ticket)
				if err != nil {
					return nil, err
				}
				signed := windowsbackup.SignedTicket{Payload: base64.RawURLEncoding.EncodeToString(data), Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, data))}
				return json.Marshal(map[string]any{"type": "windows_metadata_callback_result", "version": 1, "outerRpcId": r.OuterRPCID, "stepId": r.StepID, "nonce": r.Nonce, "ticket": signed})
			})
			channel := &publicationNativeChannel{AuthorizedChannel: &windowsbackup.AuthorizedChannel{Issuer: issuer, Transport: transport, HelperInstanceID: base.HelperInstanceID, HelperKeyEpoch: 7, HelperPublicKey: helperKey.Public().(ed25519.PublicKey)}, t: t, changed: changed}
			ctx = windowsbackup.WithMetadataChannel(ctx, channel)
			data := []byte("actual adapter attachment")
			intent := attachmentIntent{Binding: binding, OperationID: "create", RequestDigest: attachmentHash([]byte("create-intent")), Path: "published.txt", SizeBytes: int64(len(data)), Digest: attachmentHash(data), Expected: "absent", NoOverwrite: true}
			raw, _ := json.Marshal(intent)
			var params map[string]any
			json.Unmarshal(raw, &params)
			if _, err := h.WorkspaceAttachment(ctx, "attachment.begin", params); err != nil {
				t.Fatal(err)
			}
			appendParams := map[string]any{"binding": binding, "operationId": intent.OperationID, "requestDigest": intent.RequestDigest, "offset": 0, "contentBase64": base64.StdEncoding.EncodeToString(data), "chunkDigest": intent.Digest}
			if _, err := h.WorkspaceAttachment(ctx, "attachment.append", appendParams); err != nil {
				t.Fatal(err)
			}
			result, commitErr := h.WorkspaceAttachment(ctx, "attachment.commit", params)
			if result == nil {
				t.Fatal("no durable result", commitErr)
			}
			status := result.(attachmentStatus)
			if changed {
				if commitErr == nil || status.State != "unknown" || status.Proof != nil {
					t.Fatal("matrix change committed", status, commitErr)
				}
			} else if commitErr != nil || status.State != "committed" || status.Proof == nil {
				t.Fatal("same object publication failed", status, commitErr)
			}
			if channel.captures != 2 || actions["status_original"] != 4 {
				t.Fatal("wrong authenticated capture/status counts", channel.captures, actions)
			}
			left, right := channel.proofs[0], channel.proofs[1]
			if left.Proof.RecordID == right.Proof.RecordID || left.Target.FileID != right.Target.FileID || left.Target.PathKey == right.Target.PathKey || len(left.Target.PathKey) != 64 || len(right.Target.PathKey) != 64 {
				t.Fatal("real native hash slot/proof/object fixture not exercised")
			}
			actual, err := os.ReadFile(filepath.Join(root, intent.Path))
			if err != nil || string(actual) != string(data) {
				t.Fatal("published bytes", err)
			}
			t.Logf("actual adapter capture_exact=%d status_original=%d privileged mutations=0 state=%s", actions["capture_exact"], actions["status_original"], status.State)
		})
	}
}
