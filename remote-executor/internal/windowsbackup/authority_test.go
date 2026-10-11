package windowsbackup

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestSharedAuthorityGolden(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/windows-io-authority.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		PublicKey, Signature, CanonicalPayload string
		Proof                                  CaptureProof
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	key, err := base64.RawURLEncoding.DecodeString(golden.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	var ticket Ticket
	if err := strictJSON([]byte(golden.CanonicalPayload), &ticket); err != nil {
		t.Fatal(err)
	}
	peer := PeerIdentity{PID: 42, CreationTime: 1, SID: "test-SID", ServiceSID: "test-service-SID", ExecutorInstance: "test-instance"}
	v := Verifier{Keys: []IssuerKey{{ticket.Issuer, ticket.ServiceID, ticket.KeyEpoch, ed25519.PublicKey(key)}}, Roots: []NativeDescriptor{ticket.Root}, Session: Session{peer, ticket.DeviceID, ticket.ExecutorSourceID, ticket.HelperInstanceID, ticket.ConnectionID, ticket.SessionID, ticket.ChallengeNonce, ticket.RuntimeGeneration}, Now: func() time.Time { return time.UnixMilli(1700000000000) }}
	envelope, _ := json.Marshal(SignedTicket{base64.RawURLEncoding.EncodeToString([]byte(golden.CanonicalPayload)), golden.Signature})
	if _, err := v.Verify(envelope, peer, ticket.ChallengeNonce); err != nil {
		t.Fatal("TS ticket did not verify in Go", err)
	}
	if err := VerifyProof(golden.Proof, key); err != nil {
		t.Fatal("TS proof did not verify in Go", err)
	}
	peer.PID++
	if _, err := v.Verify(envelope, peer, ticket.ChallengeNonce); err == nil {
		t.Fatal("another executor/same-SID PID was accepted")
	}
	if _, err := v.Verify(envelope, v.Session.Peer, "wrong challenge"); err == nil {
		t.Fatal("wrong session accepted")
	}
	golden.Proof.RecordID = "foreign"
	if VerifyProof(golden.Proof, key) == nil {
		t.Fatal("foreign record proof accepted")
	}
}
func TestCanonicalStrictRejectsDuplicateMissingUnknown(t *testing.T) {
	tkt := Ticket{}
	data, _ := CanonicalJSON(tkt)
	for _, input := range [][]byte{append([]byte("{\"version\":1,"), data[1:]...), []byte("{}"), append(data[:len(data)-1], []byte(",\"unknown\":true}")...)} {
		var decoded Ticket
		if strictJSON(input, &decoded) == nil {
			t.Fatalf("malformed tuple accepted: %s", input)
		}
	}
}
