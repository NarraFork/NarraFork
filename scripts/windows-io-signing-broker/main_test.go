package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func unitFixture(t *testing.T) (config, map[string]any, []byte) {
	t.Helper()
	d := descriptor{"volume", "root-file", "root-created", `C:\root`}
	c := config{Pin: pin{Issuer: "platform", ServiceID: "service", KeyEpoch: 7}, AllowedRoots: []descriptor{d}, AllowedBindings: []allowedBinding{{"device", "source", "helper", d}}, AllowedActions: []string{"capture_exact", "prepare_owned", "restore_original", "seal_owned", "unseal_original", "cleanup_created", "status_original"}}
	m := map[string]any{
		"version": 1, "issuer": "platform", "serviceId": "service", "keyEpoch": 7,
		"deviceId": "device", "executorSourceId": "source", "helperInstanceId": "helper",
		"challengeNonce": base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 24)),
		"connectionId":   "connection", "sessionId": "session", "runtimeGeneration": 1,
		"actorSubjectKey": "actor", "narratorId": "narrator", "projectId": "project",
		"originRefHash": strings.Repeat("a", 64), "action": "capture_exact", "budgetClass": "metadata",
		"scopeId": "scope", "root": d, "parent": d, "target": d, "operationId": "operation",
		"requestDigest": strings.Repeat("b", 64), "leaseId": "lease", "fence": 1,
		"expectedCurrentMetadataHash": nil, "expectedCurrentContentHash": nil, "captureProofId": nil,
		"preparedObjectId": nil, "recoveryOriginal": nil, "issuedAt": 100000, "expiresAt": 130000,
		"nonce": base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 24)),
	}
	raw, e := canonical(m)
	if e != nil {
		t.Fatal(e)
	}
	parsed, _, e := parsePayload(raw, c, 100000)
	if e != nil {
		t.Fatal(e)
	}
	return c, parsed, raw
}
func unitKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	return key
}

func TestCanonicalUTF8AndDecodedByteSignature(t *testing.T) {
	c, m, _ := unitFixture(t)
	m["actorSubjectKey"] = "原用户<>&\u2028\u2029"
	raw, e := canonical(m)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(raw, []byte(`\u2028`)) || bytes.Contains(raw, []byte(`\u003c`)) {
		t.Fatal("JS canonical UTF8 mismatch")
	}
	if _, _, e = parsePayload(raw, c, 100000); e != nil {
		t.Fatal(e)
	}
	key := unitKey(t)
	sig := ed25519.Sign(key, raw)
	if !ed25519.Verify(key.Public().(ed25519.PublicKey), raw, sig) {
		t.Fatal("raw signature")
	}
	if ed25519.Verify(key.Public().(ed25519.PublicKey), []byte(base64.RawURLEncoding.EncodeToString(raw)), sig) {
		t.Fatal("signed base64 string instead of decoded bytes")
	}
}
func TestContractTamperingDenied(t *testing.T) {
	tests := map[string]func(map[string]any){
		"epoch":           func(m map[string]any) { m["keyEpoch"] = 8 },
		"device binding":  func(m map[string]any) { m["deviceId"] = "other" },
		"source binding":  func(m map[string]any) { m["executorSourceId"] = "other" },
		"helper binding":  func(m map[string]any) { m["helperInstanceId"] = "other" },
		"issuer":          func(m map[string]any) { m["issuer"] = "other" },
		"service":         func(m map[string]any) { m["serviceId"] = "other" },
		"action":          func(m map[string]any) { m["action"] = "arbitrary_sign" },
		"unknown field":   func(m map[string]any) { m["sd"] = "secret" },
		"root":            func(m map[string]any) { r := m["root"].(map[string]any); r["fileId"] = "another" },
		"expired":         func(m map[string]any) { m["expiresAt"] = 100000 },
		"ttl":             func(m map[string]any) { m["expiresAt"] = 130001 },
		"future":          func(m map[string]any) { m["issuedAt"] = 100001 },
		"unsafe integer":  func(m map[string]any) { m["fence"] = json.Number("9007199254740992") },
		"fraction":        func(m map[string]any) { m["fence"] = 1.5 },
		"nullable empty":  func(m map[string]any) { m["projectId"] = "" },
		"actor empty":     func(m map[string]any) { m["actorSubjectKey"] = "" },
		"nonce alias":     func(m map[string]any) { m["nonce"] = stringClaim(m, "nonce") + "=" },
		"borrow original": func(m map[string]any) { m["captureProofId"] = "proof" },
		"cleanup capture": func(m map[string]any) {
			m["action"] = "cleanup_created"
			m["captureProofId"] = "proof"
			m["preparedObjectId"] = "owned"
		},
		"restore missing proof": func(m map[string]any) { m["action"] = "restore_original" },
		"recovery capture": func(m map[string]any) {
			m["recoveryOriginal"] = map[string]any{"operationId": "op", "requestDigest": strings.Repeat("a", 64), "leaseId": "l", "fence": 1}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			c, m, _ := unitFixture(t)
			mutate(m)
			raw, _ := canonical(m)
			if _, _, e := parsePayload(raw, c, 100000); e == nil {
				t.Fatal("tampering accepted")
			}
		})
	}
}
func TestSoftwarePolicyAndGrantPublicationRoleDefaultClosed(t *testing.T) {
	c, _, raw := unitFixture(t)
	b := broker{cfg: c}
	if _, e := b.sign(raw, 100000); e == nil {
		t.Fatal("software signing without administrator model allow")
	}
	if _, e := b.publishGrant(raw, 100000); e == nil {
		t.Fatal("undelegated auth grant role published")
	}
	b.cfg.AllowRegisteredAuthGrantPublication = true
	if _, e := b.publishGrant(raw, 100000); e == nil {
		t.Fatal("grant role bypassed software custody policy")
	}
	b.cfg.AllowedCustodyModels = []string{"os_isolated_software"}
	invalid := bytes.Replace(raw, []byte(`"capture_exact"`), []byte(`"arbitrary_sign"`), 1)
	if _, e := b.publishGrant(invalid, 100000); e == nil {
		t.Fatal("publication accepted arbitrary signing contract")
	}
	if _, e := b.publishGrant(raw, 100000); e == nil {
		t.Fatal("no protected dynamic grant store became ready")
	}
}

func TestDuplicateNoncanonicalAndOversizedDenied(t *testing.T) {
	c, _, raw := unitFixture(t)
	duplicate := append([]byte(`{"version":1,`), raw[1:]...)
	for _, b := range [][]byte{duplicate, append([]byte(" "), raw...), bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1.0`), 1), bytes.Repeat([]byte("a"), maxPayload+1), {0xff}} {
		if _, _, e := parsePayload(b, c, 100000); e == nil {
			t.Fatal("noncanonical accepted")
		}
	}
	var req request
	for _, b := range []string{`{"version":1,"method":"sign","method":"sign"}`, `{"version":1,"method":"sign","privateKey":"x"}`, `{"version":1} {}`} {
		if strictDecode([]byte(b), &req) == nil {
			t.Fatal("bad request accepted")
		}
	}
}
func TestDurableNonceFenceSessionUnitNotNative(t *testing.T) {
	_, m, raw := unitFixture(t)
	b := broker{configDigest: strings.Repeat("c", 64), key: unitKey(t)}
	s := durableState{Version: ledgerVersion, StageScheme: ledgerStageScheme, ConfigDigest: b.configDigest, Operations: map[string]signedRecord{}, Nonces: map[string]string{}, Fences: map[string]fenceRecord{}, Masters: map[string]string{}, Stages: map[string]stageRecord{}}
	first, e := b.authorizeState(&s, m, raw)
	if e != nil {
		t.Fatal(e)
	}
	data, _ := canonical(s)
	path := filepath.Join(t.TempDir(), "state.json")
	if e = os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
	data, e = os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var loaded durableState
	if e = strictDecode(data, &loaded); e != nil {
		t.Fatal(e)
	}
	prior, e := b.authorizeState(&loaded, m, raw)
	if e != nil || prior != first {
		t.Fatal("exact retry lost persisted signature", e)
	}
	m["operationId"] = "second"
	raw, _ = canonical(m)
	if _, e = b.authorizeState(&loaded, m, raw); e == nil {
		t.Fatal("new op reused nonce")
	}
	m["operationId"] = "operation"
	m["requestDigest"] = strings.Repeat("e", 64)
	raw, _ = canonical(m)
	if _, e = b.authorizeState(&loaded, m, raw); e == nil {
		t.Fatal("same op different digest")
	}
	m["operationId"] = "new-session"
	m["sessionId"] = "session-2"
	m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{4}, 24))
	raw, _ = canonical(m)
	if _, e = b.authorizeState(&loaded, m, raw); e == nil {
		t.Fatal("new session borrowed old fence/generation")
	}
	m["fence"] = json.Number("2")
	m["runtimeGeneration"] = json.Number("2")
	raw, _ = canonical(m)
	if _, e = b.authorizeState(&loaded, m, raw); e != nil {
		t.Fatal("new session reservation rejected", e)
	}
	_, old, oldRaw := unitFixture(t)
	if _, e = b.authorizeState(&loaded, old, oldRaw); e == nil {
		t.Fatal("old session ticket replay accepted")
	}
	loaded.ConfigDigest = "old-epoch"
	if _, e = b.authorizeState(&loaded, m, raw); e == nil {
		t.Fatal("old config state accepted")
	}
}
func TestMasterSupportsMultipleRegisteredObjectStagesUnitNotNative(t *testing.T) {
	_, m, _ := unitFixture(t)
	b := broker{configDigest: strings.Repeat("c", 64), key: unitKey(t)}
	s := durableState{Version: ledgerVersion, StageScheme: ledgerStageScheme, ConfigDigest: b.configDigest, Operations: map[string]signedRecord{}, Nonces: map[string]string{}, Fences: map[string]fenceRecord{}, Masters: map[string]string{}, Stages: map[string]stageRecord{}}
	m["action"] = "restore_original"
	m["captureProofId"] = "capture-A"
	m["preparedObjectId"] = "prepared-A"
	target := m["target"].(map[string]any)
	target["pathKey"] = `C:\root\A`
	target["fileId"] = "file-A"
	raw, _ := canonical(m)
	if _, e := b.authorizeState(&s, m, raw); e != nil {
		t.Fatal(e)
	}
	m["captureProofId"] = "capture-B"
	m["preparedObjectId"] = "prepared-B"
	target["pathKey"] = `C:\root\B`
	target["fileId"] = "file-B"
	m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{6}, 24))
	m["challengeNonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 24))
	raw, _ = canonical(m)
	if _, e := b.authorizeState(&s, m, raw); e != nil {
		t.Fatal("second file under same original operation rejected", e)
	}
	if len(s.Masters) != 1 || len(s.Stages) != 2 || len(s.Operations) != 2 {
		t.Fatal("master/object stages were conflated")
	}
	m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 24))
	m["challengeNonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 24))
	m["issuedAt"] = json.Number("100001")
	m["expiresAt"] = json.Number("130001")
	raw, _ = canonical(m)
	if _, e := b.authorizeState(&s, m, raw); e != nil {
		t.Fatal("fresh exact authority for registered original stage rejected", e)
	}
	if len(s.Stages) != 2 || len(s.Operations) != 3 {
		t.Fatal("fresh nonce created another mutation stage")
	}
	m["expectedCurrentMetadataHash"] = strings.Repeat("e", 64)
	m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{10}, 24))
	raw, _ = canonical(m)
	if _, e := b.authorizeState(&s, m, raw); e == nil {
		t.Fatal("fresh challenge reset the registered mutation stage binding")
	}
	m["expectedCurrentMetadataHash"] = nil
	m["requestDigest"] = strings.Repeat("e", 64)
	raw, _ = canonical(m)
	if _, e := b.authorizeState(&s, m, raw); e == nil {
		t.Fatal("same master operation changed original digest")
	}
}
func TestNativeObjectStageCannotBeResetByProofOrCreationUnitNotNative(t *testing.T) {
	for _, action := range []string{"prepare_owned", "restore_original", "seal_owned", "unseal_original", "cleanup_created"} {
		t.Run(action, func(t *testing.T) {
			fixture := func() map[string]any {
				_, m, _ := unitFixture(t)
				m["action"] = action
				if action == "prepare_owned" || action == "cleanup_created" {
					m["preparedObjectId"] = "prepared-A"
				} else {
					m["captureProofId"] = "capture-A"
					m["preparedObjectId"] = "prepared-A"
				}
				target := m["target"].(map[string]any)
				target["fileId"] = "file-A"
				target["pathKey"] = `C:\root\A`
				return m
			}
			b := broker{configDigest: strings.Repeat("c", 64), key: unitKey(t)}
			s := durableState{Version: ledgerVersion, StageScheme: ledgerStageScheme, ConfigDigest: b.configDigest, Operations: map[string]signedRecord{}, Nonces: map[string]string{}, Fences: map[string]fenceRecord{}, Masters: map[string]string{}, Stages: map[string]stageRecord{}}
			m := fixture()
			raw, _ := canonical(m)
			if _, e := b.authorizeState(&s, m, raw); e != nil {
				t.Fatal(e)
			}
			mutations := map[string]func(map[string]any){
				"prepared proof swap":               func(m map[string]any) { m["preparedObjectId"] = "prepared-B" },
				"metadata change":                   func(m map[string]any) { m["expectedCurrentMetadataHash"] = strings.Repeat("e", 64) },
				"content change":                    func(m map[string]any) { m["expectedCurrentContentHash"] = strings.Repeat("e", 64) },
				"same fid recycled target creation": func(m map[string]any) { m["target"].(map[string]any)["creationTime"] = "new-creation" },
				"same parent fid recycled creation": func(m map[string]any) { m["parent"].(map[string]any)["creationTime"] = "new-parent-creation" },
			}
			if action != "prepare_owned" && action != "cleanup_created" {
				mutations["original proof swap"] = func(m map[string]any) { m["captureProofId"] = "capture-B" }
			}
			for name, mutate := range mutations {
				t.Run(name, func(t *testing.T) {
					m := fixture()
					m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{20}, 24))
					m["challengeNonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{21}, 24))
					mutate(m)
					raw, _ := canonical(m)
					before, _ := canonical(s)
					if _, e := b.authorizeState(&s, m, raw); e == nil {
						t.Fatal("new proof/nonce authorized a second intent for the same native object")
					}
					after, _ := canonical(s)
					if !bytes.Equal(before, after) {
						t.Fatal("rejected equivocation changed durable evidence")
					}
				})
			}
			m = fixture()
			m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{22}, 24))
			m["challengeNonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{23}, 24))
			m["issuedAt"] = json.Number("100001")
			m["expiresAt"] = json.Number("130001")
			raw, _ = canonical(m)
			if _, e := b.authorizeState(&s, m, raw); e != nil {
				t.Fatal("unchanged native stage could not receive fresh authority", e)
			}
			if len(s.Masters) != 1 || len(s.Stages) != 1 || len(s.Operations) != 2 {
				t.Fatal("fresh authorization created another mutation stage")
			}
			for _, field := range []string{"actorSubjectKey", "requestDigest", "leaseId"} {
				m = fixture()
				m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{24}, 24))
				if field == "requestDigest" {
					m[field] = strings.Repeat("e", 64)
				} else {
					m[field] = "different"
				}
				raw, _ = canonical(m)
				if _, e := b.authorizeState(&s, m, raw); e == nil {
					t.Fatal("master tuple drift accepted", field)
				}
			}
			// Legacy/scheme-less ledgers retain all existing masters, stages,
			// nonces and fences. Do not reinterpret their opaque stage hashes.
			for _, legacyVersion := range []int{1, 2, ledgerVersion} {
				legacy := s
				legacy.Version = legacyVersion
				legacy.StageScheme = ""
				before, _ := canonical(legacy)
				m = fixture()
				raw, _ = canonical(m)
				if _, e := b.authorizeState(&legacy, m, raw); e == nil {
					t.Fatal("missing native scheme silently upgraded")
				}
				after, _ := canonical(legacy)
				if !bytes.Equal(before, after) {
					t.Fatal("legacy evidence overwritten")
				}
			}
		})
	}
}

func TestRegisteredFreshObservationStageUnitNotNative(t *testing.T) {
	_, m, raw := unitFixture(t)
	b := broker{configDigest: strings.Repeat("c", 64), key: unitKey(t)}
	s := durableState{Version: ledgerVersion, StageScheme: ledgerStageScheme, ConfigDigest: b.configDigest, Operations: map[string]signedRecord{}, Nonces: map[string]string{}, Fences: map[string]fenceRecord{}, Masters: map[string]string{}, Stages: map[string]stageRecord{}}
	if _, e := b.authorizeState(&s, m, raw); e != nil {
		t.Fatal(e)
	}
	// Pure post-grant transition: in production a fresh signed/helper-registered
	// observation is mandatory before this code, not a caller's random nonce.
	m["challengeNonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{11}, 24))
	m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{12}, 24))
	m["expectedCurrentContentHash"] = strings.Repeat("d", 64)
	raw, _ = canonical(m)
	if _, e := b.authorizeState(&s, m, raw); e != nil {
		t.Fatal("new explicit observation under same master rejected", e)
	}
	if len(s.Masters) != 1 || len(s.Stages) != 2 {
		t.Fatal("fresh observations not separated")
	}
	m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{13}, 24))
	m["expectedCurrentContentHash"] = strings.Repeat("e", 64)
	raw, _ = canonical(m)
	if _, e := b.authorizeState(&s, m, raw); e == nil {
		t.Fatal("registered observation challenge changed its original binding")
	}
	legacy := s
	legacy.Version = 1
	if _, e := b.authorizeState(&legacy, m, raw); e == nil {
		t.Fatal("opaque legacy ledger silently reset")
	}
}

func TestExactFreshGrantHashBindsAllAuthorityFields(t *testing.T) {
	c, m, raw := unitFixture(t)
	_, original, e := parsePayload(raw, c, 100000)
	if e != nil {
		t.Fatal(e)
	}
	for _, field := range []string{"deviceId", "executorSourceId", "helperInstanceId", "sessionId", "connectionId", "actorSubjectKey", "originRefHash", "requestDigest", "operationId", "scopeId", "leaseId"} {
		_, copy, _ := unitFixture(t)
		if strings.HasSuffix(field, "Hash") || field == "requestDigest" {
			copy[field] = strings.Repeat("e", 64)
		} else {
			copy[field] = "different"
		}
		binding := c.AllowedBindings[0]
		switch field {
		case "deviceId":
			binding.DeviceID = "different"
		case "executorSourceId":
			binding.ExecutorSourceID = "different"
		case "helperInstanceId":
			binding.HelperInstanceID = "different"
		}
		allowed := c
		allowed.AllowedBindings = append(append([]allowedBinding{}, c.AllowedBindings...), binding)
		b, _ := canonical(copy)
		_, changed, e := parsePayload(b, allowed, 100000)
		if e != nil {
			t.Fatal(e)
		}
		if original == changed {
			t.Fatal("grant binding omitted", field)
		}
	}
	m["issuedAt"] = json.Number("100001")
	m["expiresAt"] = json.Number("130001")
	m["nonce"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{5}, 24))
	raw, _ = canonical(m)
	_, retryGrant, e := parsePayload(raw, c, 100001)
	if e != nil || retryGrant != original {
		t.Fatal("approval must bind operation, not controller selected ticket entropy", e)
	}
}
func TestNativeLinuxSocketKernelCredentials(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux native SO_PEERCRED only")
	}
	path := filepath.Join(t.TempDir(), "peer.sock")
	l, e := net.ListenUnix("unix", &net.UnixAddr{Net: "unix", Name: path})
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	ch := make(chan *net.UnixConn, 1)
	go func() {
		conn, e := l.AcceptUnix()
		if e == nil {
			ch <- conn
		}
	}()
	conn, e := net.DialUnix("unix", nil, &net.UnixAddr{Net: "unix", Name: path})
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	var accepted *net.UnixConn
	select {
	case accepted = <-ch:
	case <-time.After(time.Second):
		t.Fatal("accept timeout")
	}
	defer accepted.Close()
	for _, socket := range []*net.UnixConn{conn, accepted} {
		p, e := peerCredentials(socket)
		if e != nil {
			t.Fatal(e)
		}
		if p.PID != os.Getpid() || p.UID != uint32(os.Getuid()) {
			t.Fatal("kernel peer identity not actual caller")
		}
	}
	// This verifies real kernel identity, NOT an installed isolated deployment.
	if os.Getuid() != 0 {
		p, e := peerIdentity(accepted)
		if e != nil {
			t.Fatal(e)
		}
		if p.StartTime == "" || p.ExeSHA256 == "" {
			t.Fatal("creation/executable identity missing")
		}
	}
}
func TestUnprotectedScratchAndSameUIDDeploymentFailClosed(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux native protection path")
	}
	path := filepath.Join(t.TempDir(), "untrusted.json")
	if e := os.WriteFile(path, []byte(`{"version":1}`), 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := loadConfig(path); e == nil {
		t.Fatal("mutable scratch config trusted")
	}
	if _, e := client(path, []byte(`{"version":1,"method":"inspect_windows_io_security"}`)); e == nil {
		t.Fatal("unenrolled client ready")
	}
	link := filepath.Join(t.TempDir(), "link")
	if e := os.Symlink(path, link); e != nil {
		t.Fatal(e)
	}
	if protectedPath(link, 0, false, false) == nil {
		t.Fatal("symlink trusted")
	}
	// No root account switching, service installation or host ACL modification here.
}

// The child is isolated solely within an ephemeral user namespace. Its UID is
// mapped to an existing subordinate range; no host accounts/ACLs/services change.
func TestNativeDifferentUIDChild(t *testing.T) {
	path := os.Getenv("NF_UNIT_PEER_SOCKET")
	if path == "" {
		t.Skip("namespace-only child")
	}
	conn, e := net.DialUnix("unix", nil, &net.UnixAddr{Net: "unix", Name: path})
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	if e = writeFrame(conn, []byte(`{"version":1,"method":"inspect_windows_io_security","challenge":"claimed platform authority","phase":"before"}`)); e != nil {
		t.Fatal(e)
	}
	if _, e = readFrame(conn, 1024); e == nil {
		t.Fatal("different UID unexpectedly authorized")
	}
}
func TestNativeMappedToolUIDRejectedByKernelPeer(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getuid() == 0 {
		t.Skip("non-root Linux subordinate UID test")
	}
	unshare, e := exec.LookPath("unshare")
	if e != nil {
		t.Skip("unshare unavailable")
	}
	probeContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	probe := exec.CommandContext(probeContext, unshare, "-Ur", "--map-auto", "--setuid", "1001", "--setgid", "1001", "true")
	probe.Env = []string{"PATH=/usr/bin:/bin"}
	probe.Stdout = io.Discard
	probe.Stderr = io.Discard
	if e = probe.Run(); e != nil {
		t.Skip("existing subordinate UID mapping unavailable")
	}
	dir := t.TempDir()
	// Only these test-owned temporary directories become traversable by the mapped
	// child. A production signer would reject this mutable test directory outright.
	for _, p := range []string{filepath.Dir(dir), dir} {
		if e = os.Chmod(p, 0755); e != nil {
			t.Fatal(e)
		}
	}
	binary := filepath.Join(dir, "peer-test")
	self, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	input, e := os.Open(self)
	if e != nil {
		t.Fatal(e)
	}
	defer input.Close()
	output, e := os.OpenFile(binary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if e != nil {
		t.Fatal(e)
	}
	_, e = io.Copy(output, io.LimitReader(input, 64*1024*1024))
	closeErr := output.Close()
	if e != nil || closeErr != nil {
		t.Fatal("test executable copy failed")
	}
	path := filepath.Join(dir, "mapped-peer.sock")
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Net: "unix", Name: path})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	listener.SetDeadline(time.Now().Add(5 * time.Second))
	if e = os.Chmod(path, 0666); e != nil {
		t.Fatal(e)
	}
	ctx, stop := context.WithTimeout(context.Background(), 8*time.Second)
	defer stop()
	child := exec.CommandContext(ctx, unshare, "-Ur", "--map-auto", "--setuid", "1001", "--setgid", "1001", binary, "-test.run=^TestNativeDifferentUIDChild$")
	child.Env = []string{"PATH=/usr/bin:/bin", "NF_UNIT_PEER_SOCKET=" + path}
	child.Stdout = io.Discard
	child.Stderr = io.Discard
	if e = child.Start(); e != nil {
		t.Fatal(e)
	}
	conn, e := listener.AcceptUnix()
	if e != nil {
		t.Fatal(e)
	}
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	actual, e := peerCredentials(conn)
	if e != nil {
		t.Fatal(e)
	}
	if actual.UID == uint32(os.Getuid()) || actual.PID != child.Process.Pid {
		t.Fatal("mapped child did not have actual separate kernel UID/PID")
	}
	b := broker{cfg: config{AuthUID: uint32(os.Getuid())}}
	if _, e = b.caller(actual); e == nil {
		t.Fatal("OS-mapped tool UID impersonated auth service")
	}
	// Drain the one bounded fake claim before closing, so the child observes a
	// clean refusal rather than failing while its frame is still being written.
	if _, e = readFrame(conn, 1024); e != nil {
		t.Fatal(e)
	}
	conn.Close()
	if e = child.Wait(); e != nil {
		t.Fatal("mapped child verification failed", e)
	}
}

func TestFrameInputBudgetNativeSocket(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go func() { var n [4]byte; binary.BigEndian.PutUint32(n[:], maxMessage+1); a.Write(n[:]) }()
	if _, e := readFrame(b, maxMessage); e == nil {
		t.Fatal("oversized frame accepted")
	}
}
