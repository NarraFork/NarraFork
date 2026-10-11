package windowsbackup

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSharedFirstCaptureGolden(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/windows-first-capture.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		PublicKey, Token                       string
		Preauth, Capture, EnrollmentInspection struct{ CanonicalPayload, Signature string }
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	key, err := base64.RawURLEncoding.DecodeString(golden.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	vectors := []struct {
		name                     string
		raw, signature, wantHash string
		size                     int
		target                   any
	}{{"preauth", golden.Preauth.CanonicalPayload, golden.Preauth.Signature, "fe72e0d904718380f1bb00c4a4f97836736a897f0d3dbcbf02c3d07c379eb39b", 1481, &FirstCapturePreauthorization{}}, {"capture", golden.Capture.CanonicalPayload, golden.Capture.Signature, "d835dd4fc81339206c4117645a21a63d3b962030af0cd8bf37adff668d0b052a", 2860, &FirstCaptureResultPayload{}}, {"enrollment", golden.EnrollmentInspection.CanonicalPayload, golden.EnrollmentInspection.Signature, "3b8a0c3fcb50e455a40ae21f1475350b8fa02b428e2d7681a4e001c2a10e32df", 1007, &FirstCaptureEnrollmentInspection{}}}
	for _, v := range vectors {
		t.Run(v.name, func(t *testing.T) {
			if len(v.raw) != v.size || Digest([]byte(v.raw)) != v.wantHash {
				t.Fatal("frozen owner golden byte/hash mismatch")
			}
			envelope := FirstCaptureEnvelope{1, base64.RawURLEncoding.EncodeToString([]byte(v.raw)), v.signature}
			if err := verifyFirstCaptureEnvelope(envelope, key, v.target); err != nil {
				t.Fatal("TS canonical Ed25519 did not verify in Go", err)
			}
			switch value := v.target.(type) {
			case *FirstCapturePreauthorization:
				tokenDigest, err := FirstCaptureTokenDigest(golden.Token)
				if value.Validate() != nil || err != nil || value.TokenDigest != tokenDigest {
					t.Fatal("preauth semantic mismatch")
				}
			case *FirstCaptureResultPayload:
				if value.Validate(ed25519.PublicKey(key)) != nil {
					t.Fatal("capture semantic mismatch")
				}
			case *FirstCaptureEnrollmentInspection:
				if value.Enrollment.Validate() != nil {
					t.Fatal("enrollment invalid")
				}
				bytes, err := CanonicalJSON(value.Enrollment)
				if err != nil || Digest(bytes) != value.EnrollmentFileDigest {
					t.Fatal("enrollment canonical digest mismatch")
				}
			}
		})
	}
}
func TestFirstCaptureIssuedTicketGoldenAndOldValidTicketRefusal(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/windows-first-capture.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 8672 || Digest(raw) != "acbd2f0e1947bfb5f1ae86996bc6c1bed76b553dec26ed4fd92af3e568f94707" {
		t.Fatal("owner final wholefile golden differs")
	}
	var golden struct {
		IssuedTicket SignedTicket
		IssuerPin    struct {
			Issuer, ServiceID string
			KeyEpoch          uint64
			PublicKey         string
		}
		Capture struct{ CanonicalPayload string }
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	payload, err := decodeTicketPayload(golden.IssuedTicket)
	if err != nil || len(payload) != 1327 || Digest(payload) != "78164ca4a87b8c7c42e241a0b97a9fec8382c6d6e60a03e8e1214de84c977bf6" {
		t.Fatal("new issued ticket raw bytes/digest")
	}
	var ticket Ticket
	if err := strictJSON(payload, &ticket); err != nil {
		t.Fatal(err)
	}
	var completed FirstCaptureResultPayload
	if err := strictJSON([]byte(golden.Capture.CanonicalPayload), &completed); err != nil {
		t.Fatal(err)
	}
	key, err := base64.RawURLEncoding.DecodeString(golden.IssuerPin.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	peer := PeerIdentity{PID: 42, CreationTime: 1, SID: "test", ServiceSID: "service", ExecutorInstance: "executor"}
	v := &Verifier{Keys: []IssuerKey{{golden.IssuerPin.Issuer, golden.IssuerPin.ServiceID, golden.IssuerPin.KeyEpoch, key}}, Roots: []NativeDescriptor{ticket.Root}, Session: Session{Peer: peer, DeviceID: ticket.DeviceID, SourceID: ticket.ExecutorSourceID, HelperInstanceID: ticket.HelperInstanceID, ConnectionID: ticket.ConnectionID, SessionID: ticket.SessionID, ChallengeNonce: ticket.ChallengeNonce, Generation: ticket.RuntimeGeneration}, Now: func() time.Time { return time.UnixMilli(1700000000000) }}
	envelope, _ := json.Marshal(golden.IssuedTicket)
	verified, err := v.Verify(envelope, peer, ticket.ChallengeNonce)
	if err != nil || !completed.Origin.matchesTicket(ticket) || completed.TicketPayloadDigest != verified.digest {
		t.Fatal("fresh signed null-current/proof/prepared/recovery capture ticket mismatch", err)
	}
	oldRaw, err := os.ReadFile("../../../shared/windows-io-authority.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var old struct{ PublicKey, Signature, CanonicalPayload string }
	if json.Unmarshal(oldRaw, &old) != nil {
		t.Fatal("old golden decode")
	}
	oldKey, _ := base64.RawURLEncoding.DecodeString(old.PublicKey)
	oldSig, _ := base64.RawURLEncoding.DecodeString(old.Signature)
	if !ed25519.Verify(oldKey, []byte(old.CanonicalPayload), oldSig) {
		t.Fatal("old legacy authority signature no longer valid")
	}
	var oldTicket Ticket
	if err := strictJSON([]byte(old.CanonicalPayload), &oldTicket); err != nil {
		t.Fatal(err)
	}
	if completed.Origin.matchesTicket(oldTicket) {
		t.Fatal("valid old v1 authority ticket with current hashes borrowed by first-capture facade")
	}
}

func TestFirstCaptureOriginAndRightsNeverBecomeAuthority(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/windows-first-capture.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Preauth struct{ CanonicalPayload string }
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	var preauth FirstCapturePreauthorization
	if err := strictJSON([]byte(golden.Preauth.CanonicalPayload), &preauth); err != nil {
		t.Fatal(err)
	}
	preauth.OrdinaryHandle.GrantedAccess = 0x120089
	if err := preauth.Validate(); err == nil {
		t.Fatal("missing ordinary WRITE_ATTRIBUTES admitted")
	}
	preauth.OrdinaryHandle.GrantedAccess = FirstCaptureOrdinaryAccess
	for _, kind := range []string{"phase", "domain", "root", "duplicated", "pins", "ttl"} {
		p := preauth
		switch kind {
		case "phase":
			p.Origin.Phase = "status_original"
		case "domain":
			p.Domain = "windows_metadata_capture_result_v1"
		case "root":
			p.Descriptors.Root.FileID = "other"
		case "duplicated":
			p.OrdinaryHandle.SameAccessDuplicate = false
		case "pins":
			p.OrdinaryHandle.AncestorPins = 0
		case "ttl":
			p.ExpiresAt = p.IssuedAt + 30001
		}
		if p.Validate() == nil {
			t.Fatal("invalid preauth", kind)
		}
	}
	for _, input := range []string{"{}", strings.Replace(golden.Preauth.CanonicalPayload, "\"domain\":", "\"unknown\":true,\"domain\":", 1), strings.Replace(golden.Preauth.CanonicalPayload, "\"version\":1", "\"version\":1,\"version\":1", 1)} {
		var p FirstCapturePreauthorization
		if strictJSON([]byte(input), &p) == nil {
			t.Fatal("missing/unknown/duplicate field accepted")
		}
	}
}
