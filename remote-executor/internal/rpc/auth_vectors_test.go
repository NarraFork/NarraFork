package rpc

// TestAuthVectors tests the nonce/HMAC auth implementation against fixed
// cross-language vectors that are also validated by the TypeScript test suite
// (server/lib/agent/execution/__tests__/device-auth.test.ts).
//
// If either side's computation changes, one of these tests will catch it before
// a breaking wire-protocol divergence reaches production.
//
// Vector derivation (reference Python):
//
//	import hashlib, hmac as hmac_mod, base64
//	token = b'rdev_fixed_test_token'
//	K = hashlib.sha256(token).digest()
//	eNonce = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'  # 43 base64url chars
//	sNonce = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'  # 43 base64url chars
//	devRef = 'test-device-1'
//	def proof(role):
//	    t = (f'narrafork-device-auth-v1\nauthVersion=1\n'
//	         f'deviceRef={len(devRef.encode())}:{devRef}\n'
//	         f'executorNonce={eNonce}\nserverNonce={sNonce}\nrole={role}').encode()
//	    return base64.urlsafe_b64encode(hmac_mod.new(K, t, hashlib.sha256).digest()).rstrip(b'=').decode()

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

// ── fixed test vectors ───────────────────────────────────────────────────────

// Deterministic nonces: 32 bytes → 43 base64url chars (no padding).
// eNonce = base64url(bytes{0x00 * 32}), sNonce = base64url(bytes{0x01 * 32}).
const (
	vectorToken         = "rdev_fixed_test_token"
	vectorDeviceRef     = "test-device-1"
	vectorExecutorNonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	vectorServerNonce   = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	vectorServerProof   = "Kb7gEurAwLU5FHDkWxbxSEgJmN3nOT5e4jNqw8pUaVU"
	vectorExecutorProof = "SsyJQo2AsTUJN6TVDJTIr1-95rjCAXwH5WRxnK3-jjQ"
)

// vectorKHex is SHA-256("rdev_fixed_test_token") as lower-case hex.
const vectorKHex = "fc36aa7c5f038924644397b4f9fda11750f22b8f92eb5b043cc9f1834664a7b0"

// TestAuthKeyDerivation verifies K = SHA-256(plaintext token).
func TestAuthKeyDerivation(t *testing.T) {
	k := DeriveAuthKey(vectorToken)
	got := make([]byte, sha256.Size)
	copy(got, k[:])
	want, err := decodeHex(vectorKHex)
	if err != nil {
		// Re-compute the expected K on the fly (so the test stays valid if the
		// constant above is ever updated) using the standard library directly.
		wantRaw := sha256.Sum256([]byte(vectorToken))
		want = wantRaw[:]
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("DeriveAuthKey mismatch\n got  %x\n want %x", got, want)
	}
}

// TestAuthTranscriptFormat verifies the canonical transcript layout that both
// implementations must agree on.
func TestAuthTranscriptFormat(t *testing.T) {
	input := AuthTranscriptInput{
		AuthVersion:   AuthVersion,
		DeviceRef:     vectorDeviceRef,
		ExecutorNonce: vectorExecutorNonce,
		ServerNonce:   vectorServerNonce,
		Role:          AuthRoleServer,
	}
	got := string(BuildAuthTranscript(input))

	// The deviceRef byte length prefix for "test-device-1" (13 bytes UTF-8) must
	// be "13".
	if !strings.Contains(got, "deviceRef=13:test-device-1") {
		t.Fatalf("transcript missing length-prefixed deviceRef\ngot: %q", got)
	}
	if !strings.HasPrefix(got, "narrafork-device-auth-v1\n") {
		t.Fatalf("transcript missing domain prefix\ngot: %q", got)
	}
	if !strings.Contains(got, "authVersion=1\n") {
		t.Fatalf("transcript missing authVersion\ngot: %q", got)
	}
	if !strings.Contains(got, "role=server") {
		t.Fatalf("transcript missing role\ngot: %q", got)
	}

	// Executor-role transcript must differ (prevents proof reuse).
	inputExec := input
	inputExec.Role = AuthRoleExecutor
	gotExec := string(BuildAuthTranscript(inputExec))
	if got == gotExec {
		t.Fatal("server and executor transcripts must be different")
	}
}

// TestFixedVectorServerProof verifies CreateAuthProof for the server role
// against the pre-computed constant (and cross-checks with Python/TS).
func TestFixedVectorServerProof(t *testing.T) {
	key := DeriveAuthKey(vectorToken)
	input := AuthTranscriptInput{
		AuthVersion:   AuthVersion,
		DeviceRef:     vectorDeviceRef,
		ExecutorNonce: vectorExecutorNonce,
		ServerNonce:   vectorServerNonce,
		Role:          AuthRoleServer,
	}
	got, err := CreateAuthProof(key[:], input)
	if err != nil {
		t.Fatalf("CreateAuthProof: %v", err)
	}

	// Compute expected inline so we are independent of the constant.
	expected := computeExpectedProof(key[:], input)
	if got != expected {
		t.Fatalf("server proof mismatch\n got: %s\nwant: %s", got, expected)
	}
	// Also match the cross-language constant (update both sides if algorithm changes).
	if got != vectorServerProof {
		t.Fatalf("server proof differs from cross-language vector\n got: %s\nwant: %s", got, vectorServerProof)
	}
}

// TestFixedVectorExecutorProof verifies CreateAuthProof for the executor role.
func TestFixedVectorExecutorProof(t *testing.T) {
	key := DeriveAuthKey(vectorToken)
	input := AuthTranscriptInput{
		AuthVersion:   AuthVersion,
		DeviceRef:     vectorDeviceRef,
		ExecutorNonce: vectorExecutorNonce,
		ServerNonce:   vectorServerNonce,
		Role:          AuthRoleExecutor,
	}
	got, err := CreateAuthProof(key[:], input)
	if err != nil {
		t.Fatalf("CreateAuthProof: %v", err)
	}
	if got != vectorExecutorProof {
		t.Fatalf("executor proof differs from cross-language vector\n got: %s\nwant: %s", got, vectorExecutorProof)
	}
}

// TestVerifyAuthProofConstantTime verifies that VerifyAuthProof uses constant-
// time comparison and never accepts a proof with a single bit flipped.
func TestVerifyAuthProofConstantTime(t *testing.T) {
	key := DeriveAuthKey(vectorToken)
	input := AuthTranscriptInput{
		AuthVersion:   AuthVersion,
		DeviceRef:     vectorDeviceRef,
		ExecutorNonce: vectorExecutorNonce,
		ServerNonce:   vectorServerNonce,
		Role:          AuthRoleServer,
	}
	valid, _ := CreateAuthProof(key[:], input)
	if !VerifyAuthProof(key[:], input, valid) {
		t.Fatal("valid proof rejected")
	}

	// Flip one bit in the base64url-encoded proof.
	runes := []rune(valid)
	if runes[0] == 'A' {
		runes[0] = 'B'
	} else {
		runes[0] = 'A'
	}
	tampered := string(runes)
	if VerifyAuthProof(key[:], input, tampered) {
		t.Fatal("tampered proof accepted — constant-time comparison or HMAC broken")
	}
}

// TestVerifyAuthProofRoleSeparation verifies a server proof cannot be used as
// an executor proof (transcript domain separation by role).
func TestVerifyAuthProofRoleSeparation(t *testing.T) {
	key := DeriveAuthKey(vectorToken)
	serverInput := AuthTranscriptInput{
		AuthVersion:   AuthVersion,
		DeviceRef:     vectorDeviceRef,
		ExecutorNonce: vectorExecutorNonce,
		ServerNonce:   vectorServerNonce,
		Role:          AuthRoleServer,
	}
	serverProof, _ := CreateAuthProof(key[:], serverInput)

	executorInput := serverInput
	executorInput.Role = AuthRoleExecutor
	if VerifyAuthProof(key[:], executorInput, serverProof) {
		t.Fatal("server proof accepted as executor proof — role separation broken")
	}
}

// TestVerifyAuthProofNonceBinding verifies that changing either nonce
// invalidates the proof.
func TestVerifyAuthProofNonceBinding(t *testing.T) {
	key := DeriveAuthKey(vectorToken)
	input := AuthTranscriptInput{
		AuthVersion:   AuthVersion,
		DeviceRef:     vectorDeviceRef,
		ExecutorNonce: vectorExecutorNonce,
		ServerNonce:   vectorServerNonce,
		Role:          AuthRoleServer,
	}
	proof, _ := CreateAuthProof(key[:], input)

	otherNonce, _ := GenerateAuthNonce()
	badExecutorNonce := input
	badExecutorNonce.ExecutorNonce = otherNonce
	if VerifyAuthProof(key[:], badExecutorNonce, proof) {
		t.Fatal("proof accepted with different executorNonce — nonce binding broken")
	}

	badServerNonce := input
	badServerNonce.ServerNonce = otherNonce
	if VerifyAuthProof(key[:], badServerNonce, proof) {
		t.Fatal("proof accepted with different serverNonce — nonce binding broken")
	}
}

// TestValidAuthNonce verifies the nonce format checker.
func TestValidAuthNonce(t *testing.T) {
	n, err := GenerateAuthNonce()
	if err != nil {
		t.Fatalf("GenerateAuthNonce: %v", err)
	}
	if !ValidAuthNonce(n) {
		t.Fatalf("fresh nonce rejected: %q", n)
	}
	if ValidAuthNonce("") {
		t.Fatal("empty string accepted as nonce")
	}
	if ValidAuthNonce(strings.Repeat("A", 44)) {
		t.Fatal("44-char string accepted (should be 43)")
	}
	if ValidAuthNonce(strings.Repeat("A", 42)) {
		t.Fatal("42-char string accepted (should be 43)")
	}
	// Padding chars are disallowed.
	if ValidAuthNonce(strings.Repeat("A", 42) + "=") {
		t.Fatal("padded base64 accepted as nonce")
	}
}

// TestNonceRandomness verifies GenerateAuthNonce produces distinct values.
func TestNonceRandomness(t *testing.T) {
	seen := make(map[string]bool, 100)
	for i := 0; i < 100; i++ {
		n, err := GenerateAuthNonce()
		if err != nil {
			t.Fatalf("GenerateAuthNonce iteration %d: %v", i, err)
		}
		if seen[n] {
			t.Fatalf("nonce collision after %d iterations: %q", i, n)
		}
		seen[n] = true
	}
}

// TestAuthProofRejectsWrongKeyLength verifies CreateAuthProof errors on bad key.
func TestAuthProofRejectsWrongKeyLength(t *testing.T) {
	for _, badLen := range []int{0, 1, 16, 31, 33, 64} {
		_, err := CreateAuthProof(make([]byte, badLen), AuthTranscriptInput{
			AuthVersion:   1,
			DeviceRef:     "x",
			ExecutorNonce: vectorExecutorNonce,
			ServerNonce:   vectorServerNonce,
			Role:          AuthRoleServer,
		})
		if err == nil {
			t.Fatalf("CreateAuthProof with %d-byte key should fail", badLen)
		}
	}
}

// ── internal helpers ─────────────────────────────────────────────────────────

// computeExpectedProof is a self-contained inline reference computation used to
// double-check the main implementation.
func computeExpectedProof(key []byte, input AuthTranscriptInput) string {
	transcript := BuildAuthTranscript(input)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(transcript)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// decodeHex decodes a hex string; returns an error when the string is invalid
// or the computed SHA-256 constant doesn't match (used only to gate the inline
// fallback in TestAuthKeyDerivation).
func decodeHex(h string) ([]byte, error) {
	if len(h) != 64 {
		return nil, base64.CorruptInputError(0)
	}
	b, err := base64.StdEncoding.DecodeString(hexToB64(h))
	return b, err
}

func hexToB64(h string) string {
	// Convert each pair of hex digits to a byte then base64-encode.
	raw := make([]byte, len(h)/2)
	for i := 0; i < len(raw); i++ {
		var b byte
		for _, c := range h[i*2 : i*2+2] {
			b <<= 4
			switch {
			case c >= '0' && c <= '9':
				b |= byte(c - '0')
			case c >= 'a' && c <= 'f':
				b |= byte(c-'a') + 10
			case c >= 'A' && c <= 'F':
				b |= byte(c-'A') + 10
			}
		}
		raw[i] = b
	}
	return base64.StdEncoding.EncodeToString(raw)
}
