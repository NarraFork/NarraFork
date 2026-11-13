package remotepeer

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
	"strings"
)

func Transcript(label string, fields ...string) []byte {
	out := []byte("narrafork-remote-v1\x00")
	for _, s := range append([]string{label}, fields...) {
		out = binary.BigEndian.AppendUint32(out, uint32(len([]byte(s))))
		out = append(out, []byte(s)...)
	}
	return out
}
func Hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func PublicHex(k *ecdsa.PublicKey) string {
	return hex.EncodeToString(elliptic.Marshal(elliptic.P256(), k.X, k.Y))
}
func ParsePublic(s string) (*ecdsa.PublicKey, error) {
	b, e := hex.DecodeString(s)
	if e != nil || len(b) != 65 || s != strings.ToLower(s) {
		return nil, errors.New("public_key")
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), b)
	if x == nil {
		return nil, errors.New("public_key")
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, nil
}
func InstanceID(s string) (string, error) {
	if _, e := ParsePublic(s); e != nil {
		return "", e
	}
	b, _ := hex.DecodeString(s)
	h := sha256.Sum256(b)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(h[:])), nil
}
func Sign(k *ecdsa.PrivateKey, label string, fields ...string) (string, error) {
	h := sha256.Sum256(Transcript(label, fields...))
	r, s, e := ecdsa.Sign(rand.Reader, k, h[:])
	if e != nil {
		return "", e
	}
	b := make([]byte, 64)
	r.FillBytes(b[:32])
	s.FillBytes(b[32:])
	return hex.EncodeToString(b), nil
}
func Verify(public, signature, label string, fields ...string) bool {
	k, e := ParsePublic(public)
	if e != nil {
		return false
	}
	b, e := hex.DecodeString(signature)
	if e != nil || len(b) != 64 || signature != strings.ToLower(signature) {
		return false
	}
	h := sha256.Sum256(Transcript(label, fields...))
	return ecdsa.Verify(k, h[:], new(big.Int).SetBytes(b[:32]), new(big.Int).SetBytes(b[32:]))
}
func randomHex(n int) string {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
