package rpc

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

const (
	AuthVersion    = 1
	AuthNonceBytes = 32
	authDomain     = "narrafork-device-auth-v1"
)

type AuthRole string

const (
	AuthRoleServer   AuthRole = "server"
	AuthRoleExecutor AuthRole = "executor"
)

type AuthTranscriptInput struct {
	AuthVersion   int
	DeviceRef     string
	ExecutorNonce string
	ServerNonce   string
	Role          AuthRole
}

// BuildAuthTranscript returns the canonical UTF-8 transcript shared with the
// TypeScript server. The deviceRef byte length prevents delimiter ambiguity.
func BuildAuthTranscript(input AuthTranscriptInput) []byte {
	return []byte(authDomain +
		"\nauthVersion=" + strconv.Itoa(input.AuthVersion) +
		"\ndeviceRef=" + strconv.Itoa(len([]byte(input.DeviceRef))) + ":" + input.DeviceRef +
		"\nexecutorNonce=" + input.ExecutorNonce +
		"\nserverNonce=" + input.ServerNonce +
		"\nrole=" + string(input.Role))
}

// DeriveAuthKey implements K = SHA-256(plaintext device token).
func DeriveAuthKey(token string) [sha256.Size]byte {
	return sha256.Sum256([]byte(token))
}

func GenerateAuthNonce() (string, error) {
	buf := make([]byte, AuthNonceBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate auth nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func ValidAuthNonce(value string) bool {
	if len(value) != 43 || strings.Contains(value, "=") {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == AuthNonceBytes && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func CreateAuthProof(key []byte, input AuthTranscriptInput) (string, error) {
	if len(key) != sha256.Size {
		return "", fmt.Errorf("device auth key must be %d bytes", sha256.Size)
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(BuildAuthTranscript(input))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func VerifyAuthProof(key []byte, input AuthTranscriptInput, proof string) bool {
	actual, err := base64.RawURLEncoding.DecodeString(proof)
	if err != nil || len(actual) != sha256.Size || base64.RawURLEncoding.EncodeToString(actual) != proof {
		return false
	}
	expected, err := CreateAuthProof(key, input)
	if err != nil {
		return false
	}
	expectedBytes, _ := base64.RawURLEncoding.DecodeString(expected)
	return hmac.Equal(actual, expectedBytes)
}
