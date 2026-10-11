package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

func metadataFixture(t *testing.T) (*connectionState, *websocket.Conn, context.Context, *requestCancel, windowsbackup.MetadataCallback) {
	t.Helper()
	state, peer, _ := newCancelTestConnection(t)
	if err := state.installMetadataSession(&rpc.WindowsMetadataSession{Version: 1, ConnectionID: "connection-test", SessionID: "session-test", RuntimeGeneration: 7}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	t.Cleanup(cancel)
	entry := &requestCancel{cancel: cancel}
	state.cancelMu.Lock()
	state.cancels["outer-test"] = entry
	state.cancelMu.Unlock()
	native := windowsbackup.NativeDescriptor{VolumeID: "volume-test", FileID: strings.Repeat("a", 32), CreationTime: "1", PathKey: "slot-test"}
	frame := windowsbackup.MetadataCallback{Type: "windows_metadata_callback", Version: 1, OuterRPCID: "outer-test", StepID: "step-test", Nonce: strings.Repeat("A", 43), Action: "capture_exact",
		HelperChallenge: windowsbackup.HelperChallenge{HelperInstanceID: "helper-test", KeyEpoch: 1, ChallengeNonce: strings.Repeat("B", 42) + "A", ConnectionID: "connection-test", SessionID: "session-test", RuntimeGeneration: 7, Signature: base64.RawURLEncoding.EncodeToString(make([]byte, 64))},
		Descriptors:     windowsbackup.CallbackDescriptors{Root: native, Parent: native, Target: native}}
	return state, peer, ctx, entry, frame
}
func metadataBytes(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := windowsbackup.CanonicalJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func metadataFixtureResult(frame windowsbackup.MetadataCallback) metadataResult {
	// Transport fixture only. This deliberately is not a privileged/native ticket.
	return metadataResult{Type: "windows_metadata_callback_result", Version: 1, OuterRPCID: frame.OuterRPCID, StepID: frame.StepID, Nonce: frame.Nonce, Ticket: windowsbackup.SignedTicket{Payload: "transport-fixture", Signature: "not-a-native-signature"}}
}

func TestMetadataControlCorrelatesOriginalRawReply(t *testing.T) {
	state, peer, ctx, entry, frame := metadataFixture(t)
	go func() { _ = state.serveAuthenticated() }()
	controlCtx := state.metadataRequestContext(ctx, frame.OuterRPCID, entry)
	facts, err := windowsbackup.MetadataControl(controlCtx)
	if err != nil {
		t.Fatal(err)
	}
	if facts.Session.ConnectionID != "connection-test" || facts.OuterRPCID != frame.OuterRPCID {
		t.Fatal("original transport identity lost")
	}
	request := metadataBytes(t, frame)
	type outcome struct {
		raw []byte
		err error
	}
	done := make(chan outcome, 1)
	go func() { raw, err := facts.Send(controlCtx, request); done <- outcome{raw, err} }()
	_, received, err := peer.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(received, request) {
		t.Fatal("canonical helper request was reconstructed")
	}
	wrong := metadataFixtureResult(frame)
	wrong.Nonce = strings.Repeat("C", 43)
	if err := peer.Write(ctx, websocket.MessageText, metadataBytes(t, wrong)); err != nil {
		t.Fatal(err)
	}
	correct := metadataBytes(t, metadataFixtureResult(frame))
	if err := peer.Write(ctx, websocket.MessageText, correct); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got.err != nil || !bytes.Equal(got.raw, correct) {
			t.Fatalf("wrong correlation: %v", got.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	state.metadataMu.Lock()
	count := len(state.metadataPending)
	state.metadataMu.Unlock()
	if count != 0 || len(state.metadataAdmission) != 0 || len(state.metadataWorkers) != 0 {
		t.Fatal("control resources leaked")
	}
}

func TestMetadataControlRejectsOriginalSessionDriftBeforeWrite(t *testing.T) {
	for _, field := range []string{"outer", "connection", "session", "generation", "duplicate", "oversized"} {
		t.Run(field, func(t *testing.T) {
			state, _, ctx, entry, frame := metadataFixture(t)
			switch field {
			case "outer":
				frame.OuterRPCID = "different-outer"
			case "connection":
				frame.HelperChallenge.ConnectionID = "replacement"
			case "session":
				frame.HelperChallenge.SessionID = "replacement"
			case "generation":
				frame.HelperChallenge.RuntimeGeneration++
			case "oversized":
				frame.StepID = strings.Repeat("x", metadataRequestBytes)
			}
			raw := metadataBytes(t, frame)
			if field == "duplicate" {
				raw = bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1)
			}
			if _, err := state.sendMetadataCallback(ctx, "outer-test", entry, raw); err == nil {
				t.Fatal("unbound metadata request accepted")
			}
			if len(state.metadataAdmission) != 0 || len(state.metadataWorkers) != 0 {
				t.Fatal("rejected request acquired IO budget")
			}
		})
	}
}
func TestMetadataControlQueueAndWorkerDeadlineRelease(t *testing.T) {
	state, _, ctx, entry, frame := metadataFixture(t)
	for i := 0; i < metadataControlQueue; i++ {
		state.metadataAdmission <- struct{}{}
	}
	if _, err := state.sendMetadataCallback(ctx, frame.OuterRPCID, entry, metadataBytes(t, frame)); err == nil || !strings.Contains(err.Error(), "queue full") {
		t.Fatal("control queue was not bounded")
	}
	for i := 0; i < metadataControlQueue; i++ {
		<-state.metadataAdmission
	}
	for i := 0; i < metadataControlWorkers; i++ {
		state.metadataWorkers <- struct{}{}
	}
	deadline, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
	defer cancel()
	if _, err := state.sendMetadataCallback(deadline, frame.OuterRPCID, entry, metadataBytes(t, frame)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("worker wait lacked deadline: %v", err)
	}
	if len(state.metadataAdmission) != 0 {
		t.Fatal("timed-out callback admission leaked")
	}
	for i := 0; i < metadataControlWorkers; i++ {
		<-state.metadataWorkers
	}
}
func TestMetadataControlCancelledParentCannotAcceptLateTicket(t *testing.T) {
	state, peer, ctx, entry, frame := metadataFixture(t)
	go func() { _ = state.serveAuthenticated() }()
	done := make(chan error, 1)
	go func() {
		_, err := state.sendMetadataCallback(ctx, frame.OuterRPCID, entry, metadataBytes(t, frame))
		done <- err
	}()
	if _, _, err := peer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	state.cancelRequest(frame.OuterRPCID)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel did not unblock callback: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled callback stalled")
	}
	state.handleMetadataResult(metadataBytes(t, metadataFixtureResult(frame)))
	state.metadataMu.Lock()
	count := len(state.metadataPending)
	state.metadataMu.Unlock()
	if count != 0 {
		t.Fatal("late ticket retained cancelled callback")
	}
}
func TestMetadataControlDisconnectUnblocksOriginalWait(t *testing.T) {
	state, peer, ctx, entry, frame := metadataFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := state.sendMetadataCallback(ctx, frame.OuterRPCID, entry, metadataBytes(t, frame))
		done <- err
	}()
	if _, _, err := peer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	state.close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("disconnect manufactured a ticket")
		}
	case <-time.After(time.Second):
		t.Fatal("disconnected callback stalled")
	}
}
func TestMetadataControlLegacyAndIncompleteHandshakeNeverAcquireFacts(t *testing.T) {
	state, _, ctx, entry, frame := metadataFixture(t)
	state.metadataSession = nil
	if err := state.installMetadataSession(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := windowsbackup.MetadataControl(state.metadataRequestContext(ctx, frame.OuterRPCID, entry)); err == nil {
		t.Fatal("legacy connection obtained invented control facts")
	}
	for _, session := range []rpc.WindowsMetadataSession{{Version: 1}, {Version: 2, ConnectionID: "connection", SessionID: "session", RuntimeGeneration: 1}, {Version: 1, ConnectionID: "connection", SessionID: "session", RuntimeGeneration: 9007199254740992}} {
		if err := state.installMetadataSession(&session); err == nil {
			t.Fatal("invalid metadata handshake accepted")
		}
	}
}
func TestMetadataControlRejectsNoncanonicalReply(t *testing.T) {
	state, _, _, entry, frame := metadataFixture(t)
	pending := &metadataPending{outer: frame.OuterRPCID, step: frame.StepID, nonce: frame.Nonce, entry: entry, result: make(chan []byte, 1)}
	state.metadataPending[metadataCorrelation(frame.OuterRPCID, frame.StepID, frame.Nonce)] = pending
	valid := metadataBytes(t, metadataFixtureResult(frame))
	var decoded map[string]any
	if err := json.Unmarshal(valid, &decoded); err != nil {
		t.Fatal(err)
	}
	decoded["actorSubjectKey"] = "device-claimed-actor"
	for _, raw := range [][]byte{append([]byte(" "), valid...), bytes.Repeat([]byte("x"), metadataResponseBytes+1), metadataBytes(t, decoded), bytes.Replace(valid, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1)} {
		state.handleMetadataResult(raw)
		select {
		case <-pending.result:
			t.Fatal("untrusted result matched control waiter")
		default:
		}
	}
}
