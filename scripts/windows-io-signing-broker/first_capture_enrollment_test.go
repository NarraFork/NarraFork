package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func unitEnrollment(t *testing.T) (config, firstCaptureEnrollment, []byte) {
	t.Helper()
	c, _, _ := unitFixture(t)
	c.BrokerServiceID = "broker-test"
	e := firstCaptureEnrollment{Version: 2, EnrollmentID: "enrollment-test", Revision: 1, Matrix: firstCaptureEnrollmentMatrix, DeviceID: "device", ExecutorSourceID: "source", Root: c.AllowedRoots[0], HelperInstanceID: "helper", HelperPublicKey: base64.RawURLEncoding.EncodeToString(unitKey(t).Public().(ed25519.PublicKey)), HelperKeyEpoch: 7, PipePeer: firstCapturePipePeer{Name: `\\.\pipe\narrafork-backup-test`, ProcessID: 42, CreationTime: "133700000000000000", SID: "S-1-5-80-test"}, Session: firstCaptureSession{ConnectionID: "connection-test", SessionID: "session-test", RuntimeGeneration: 7}, Policy: firstCaptureEnrollmentPolicy}
	raw, err := canonical(e)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = parseFirstCaptureEnrollment(raw, c); err != nil {
		t.Fatal(err)
	}
	return c, e, raw
}
func TestFirstCaptureEnrollmentStrictFrozenPublicSchemaUnitNotNative(t *testing.T) {
	tests := map[string]func(*firstCaptureEnrollment){
		"old version":              func(e *firstCaptureEnrollment) { e.Version = 1 },
		"empty id":                 func(e *firstCaptureEnrollment) { e.EnrollmentID = "" },
		"unsafe revision":          func(e *firstCaptureEnrollment) { e.Revision = 9007199254740992 },
		"unsafe epoch":             func(e *firstCaptureEnrollment) { e.HelperKeyEpoch = 9007199254740992 },
		"unsafe generation":        func(e *firstCaptureEnrollment) { e.Session.RuntimeGeneration = 9007199254740992 },
		"wrong matrix":             func(e *firstCaptureEnrollment) { e.Matrix = "best-effort" },
		"restore policy":           func(e *firstCaptureEnrollment) { e.Policy = "restore_original" },
		"another device":           func(e *firstCaptureEnrollment) { e.DeviceID = "unregistered" },
		"another source":           func(e *firstCaptureEnrollment) { e.ExecutorSourceID = "unregistered" },
		"another helper":           func(e *firstCaptureEnrollment) { e.HelperInstanceID = "unregistered" },
		"another native root":      func(e *firstCaptureEnrollment) { e.Root.FileID = "unregistered" },
		"another root volume":      func(e *firstCaptureEnrollment) { e.Root.VolumeID = "unregistered" },
		"another root creation":    func(e *firstCaptureEnrollment) { e.Root.CreationTime = "new-created" },
		"another root slot":        func(e *firstCaptureEnrollment) { e.Root.PathKey = `C:\other` },
		"zero pid":                 func(e *firstCaptureEnrollment) { e.PipePeer.ProcessID = 0 },
		"creation alias":           func(e *firstCaptureEnrollment) { e.PipePeer.CreationTime = "0133700000000000000" },
		"creation uint64 overflow": func(e *firstCaptureEnrollment) { e.PipePeer.CreationTime = "18446744073709551616" },
		"zero creation":            func(e *firstCaptureEnrollment) { e.PipePeer.CreationTime = "0" },
		"empty sid":                func(e *firstCaptureEnrollment) { e.PipePeer.SID = "" },
		"empty session":            func(e *firstCaptureEnrollment) { e.Session.SessionID = "" },
		"padded key":               func(e *firstCaptureEnrollment) { e.HelperPublicKey += "=" },
		"short key":                func(e *firstCaptureEnrollment) { e.HelperPublicKey = "QQQQ" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			c, e, _ := unitEnrollment(t)
			mutate(&e)
			raw, _ := canonical(e)
			if _, err := parseFirstCaptureEnrollment(raw, c); err == nil {
				t.Fatal("invalid public enrollment accepted")
			}
		})
	}
	c, _, raw := unitEnrollment(t)
	for _, bad := range [][]byte{append([]byte(" "), raw...), append([]byte(`{"version":2,`), raw[1:]...), append([]byte(`{"privateKey":"never",`), raw[1:]...), {0xff}, bytes.Repeat([]byte("a"), firstCapturePublicBytes+1)} {
		if _, err := parseFirstCaptureEnrollment(bad, c); err == nil {
			t.Fatal("noncanonical/unknown/oversized enrollment accepted")
		}
	}
	// Both preexisting administrator allowlists remain required; a file cannot
	// enroll its own target just because its public key/descriptor parses.
	c.AllowedRoots = nil
	if _, err := parseFirstCaptureEnrollment(raw, c); err == nil {
		t.Fatal("public file registered an unallowed root")
	}
}
func TestFirstCaptureInspectionExactReadOnlyRequest(t *testing.T) {
	challenge := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 24))
	valid := []byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"` + challenge + `"}`)
	if _, err := parseFirstCaptureInspectionRequest(valid); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{
		[]byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"` + challenge + `","phase":""}`),
		[]byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"` + challenge + `","payload":""}`),
		[]byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"` + challenge + `","root":{}}`),
		[]byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"` + challenge + `","key":"never"}`),
		[]byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"short"}`),
		[]byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"` + challenge + `","challenge":"` + challenge + `"}`),
		bytes.Replace(valid, []byte(`"version":1`), []byte(`"version":2`), 1),
		bytes.Replace(valid, []byte(firstCaptureInspectionMethod), []byte("sign_arbitrary"), 1),
		append(valid, []byte(` {}`)...),
		bytes.Repeat([]byte("a"), firstCaptureInspectionRequestBytes+1),
	} {
		if _, err := parseFirstCaptureInspectionRequest(bad); err == nil {
			t.Fatal("public inspection accepted action/registration/unknown request")
		}
	}
}
func TestFirstCapturePublicInspectionSignedBindingsAndNoLedgerWritesUnitNotNative(t *testing.T) {
	c, e, raw := unitEnrollment(t)
	key := unitKey(t)
	challenge := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 24))
	configDigest := strings.Repeat("a", 64)
	proof, err := encodeFirstCaptureInspection(c, configDigest, e, raw, challenge, 1700000000000, key)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := decode64(proof.Payload, firstCapturePublicBytes)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := decode64(proof.Signature, ed25519.SignatureSize)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(key.Public().(ed25519.PublicKey), payload, sig) {
		t.Fatal("not signed original decoded canonical bytes")
	}
	var parsed firstCaptureInspectionPayload
	if err = strictDecode(payload, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Domain != firstCaptureInspectionDomain || parsed.Challenge != challenge || parsed.ConfigDigest != configDigest || parsed.EnrollmentFileDigest != digest(raw) || parsed.Enrollment.HelperKeyEpoch != e.HelperKeyEpoch || parsed.Enrollment.Revision != e.Revision || parsed.Enrollment.Root != e.Root {
		t.Fatal("public signature omitted immutable enrollment context")
	}
	for _, needle := range []string{"privateKey", "externalCustody", "ticket", "operations", "secret", "securityDescriptor"} {
		if bytes.Contains(payload, []byte(`"`+needle+`"`)) {
			t.Fatal("non-public data exported", needle)
		}
	}
	if ed25519.Verify(key.Public().(ed25519.PublicKey), []byte(proof.Payload), sig) {
		t.Fatal("signed encoded string instead of decoded raw UTF8")
	}
	for _, mutation := range []func(*firstCaptureInspectionPayload){
		func(p *firstCaptureInspectionPayload) { p.Domain = "windows_io_broker_security_probe_v1" },
		func(p *firstCaptureInspectionPayload) {
			p.Challenge = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 24))
		},
		func(p *firstCaptureInspectionPayload) { p.ConfigDigest = strings.Repeat("b", 64) },
		func(p *firstCaptureInspectionPayload) { p.EnrollmentFileDigest = strings.Repeat("c", 64) },
		func(p *firstCaptureInspectionPayload) { p.Enrollment.HelperKeyEpoch++ },
		func(p *firstCaptureInspectionPayload) { p.Enrollment.Revision++ },
		func(p *firstCaptureInspectionPayload) { p.Enrollment.Root.FileID = "other" },
	} {
		copy := parsed
		mutation(&copy)
		changed, _ := canonical(copy)
		if ed25519.Verify(key.Public().(ed25519.PublicKey), changed, sig) {
			t.Fatal("tampered public inspection still verified")
		}
	}
	// A signed public inspection is not a Windows IO ticket or an action grant.
	if _, _, err := parsePayload(payload, c, 1700000000000); err == nil {
		t.Fatal("public inspection became a generic privileged ticket")
	}
	large := raw
	for len(large) < firstCapturePublicBytes {
		large = append(large, ' ')
	}
	// Bounded formatter checks full base64 envelope, not caller's byte claim.
	e.Root.PathKey = strings.Repeat("x", 60000)
	large, _ = canonical(e)
	if _, err = encodeFirstCaptureInspection(c, configDigest, e, large, challenge, 1700000000000, key); err == nil {
		t.Fatal("oversized signed response was silently emitted")
	}
}
func TestFirstCaptureEnrollmentMissingOrMutableFileNativeUnavailable(t *testing.T) {
	c, e, raw := unitEnrollment(t)
	if _, _, err := readFirstCaptureEnrollment("", c); err == nil {
		t.Fatal("unconfigured inspection silently ready")
	}
	if runtime.GOOS != "linux" {
		t.Skip("Linux native protected ancestor rejection")
	}
	path := filepath.Join(t.TempDir(), "public-enrollment.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readFirstCaptureEnrollment(path, c); err == nil {
		t.Fatal("mutable scratch enrollment became native production authority")
	}
	_ = e
}
func TestFirstCaptureInspectionGoldenCanonicalDomain(t *testing.T) {
	path := filepath.Join("..", "..", "shared", "windows-first-capture.golden.json")
	raw, err := readBounded(path, firstCapturePublicBytes)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Purpose    string `json:"purpose"`
		PublicKey  string `json:"publicKey"`
		Inspection struct {
			CanonicalPayload string `json:"canonicalPayload"`
			Signature        string `json:"signature"`
		} `json:"enrollmentInspection"`
	}
	// Only consume the relevant golden; other domains are owned/tested elsewhere.
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Purpose != "unit_test_only_not_native" {
		t.Fatal("golden must not describe native production readiness")
	}
	payload := []byte(fixture.Inspection.CanonicalPayload)
	pub, err := decode64(fixture.PublicKey, 32)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := decode64(fixture.Inspection.Signature, 64)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(pub, payload, sig) {
		t.Fatal("shared canonical public inspection golden signature mismatch")
	}
	var p firstCaptureInspectionPayload
	if err = strictDecode(payload, &p); err != nil {
		t.Fatal(err)
	}
	canon, err := canonical(p)
	if err != nil || !bytes.Equal(canon, payload) {
		t.Fatal("Go and TS public inspection canonical bytes drifted")
	}
	c := config{BrokerServiceID: p.BrokerServiceID, AllowedRoots: []descriptor{p.Enrollment.Root}, AllowedBindings: []allowedBinding{{p.Enrollment.DeviceID, p.Enrollment.ExecutorSourceID, p.Enrollment.HelperInstanceID, p.Enrollment.Root}}}
	enrollmentRaw, _ := canonical(p.Enrollment)
	if _, err = parseFirstCaptureEnrollment(enrollmentRaw, c); err != nil {
		t.Fatal(err)
	}
	if digest(enrollmentRaw) != p.EnrollmentFileDigest {
		t.Fatal("public enrollment canonical/raw digest drifted")
	}
}
func TestFirstCaptureRealCLIUnconfiguredCannotClaimProductionReady(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("native Linux CLI negative evidence only")
	}
	goBinary, err := exec.LookPath("go")
	if err != nil {
		t.Skip("Go compiler unavailable")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "broker")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, goBinary, "build", "-o", binary, ".")
	// No production tokens/keys inherited; all candidate/cache data is temporary.
	build.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "GOCACHE=" + filepath.Join(dir, "go-cache"), "CGO_ENABLED=0"}
	build.Stdout = io.Discard
	build.Stderr = io.Discard
	if err = build.Run(); err != nil {
		t.Fatal("temporary CLI build failed", err)
	}
	challenge := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 24))
	request := []byte(`{"version":1,"method":"inspect_windows_first_capture_enrollment","challenge":"` + challenge + `"}`)
	callCtx, stop := context.WithTimeout(context.Background(), 12*time.Second)
	defer stop()
	command := exec.CommandContext(callCtx, binary, "--client", "--config", filepath.Join(dir, "not-configured.json"))
	command.Env = []string{}
	command.Stdin = bytes.NewReader(request)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, firstCapturePublicBytes+1))
	exitErr := command.Wait()
	if readErr != nil {
		t.Fatal(readErr)
	}
	if exitErr == nil || len(out) != 0 {
		t.Fatal("ordinary temporary CLI fabricated a production public attestation")
	}
	// This is a real native CLI refusal, NOT a positive registered authority or
	// helper deployment. No process identity from this test becomes enrollment.
}

func TestFirstCaptureOptionalConfigKeepsV1AndLedgerV3(t *testing.T) {
	var c config
	if err := strictDecode([]byte(`{"version":1}`), &c); err != nil {
		t.Fatal(err)
	}
	if c.FirstCaptureEnrollmentFile != "" || c.Version != 1 {
		t.Fatal("optional public path changed legacy config")
	}
	if err := strictDecode([]byte(`{"version":1,"firstCaptureEnrollmentFile":"/admin/public-enrollment.json"}`), &c); err != nil {
		t.Fatal(err)
	}
	if ledgerVersion != 3 || ledgerStageScheme != "native_object_slot_v1" {
		t.Fatal("readonly inspection rewrote existing ledger scheme")
	}
}
