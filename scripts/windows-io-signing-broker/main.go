// windows-io-signing-broker is an explicit, operator-installed Linux service.
// It never installs itself, enrolls callers, generates production keys or executes
// commands. CLI stdin/stdout is bounded; no secrets are accepted in env or argv.
// This software key service is OS-isolated, NOT a hardware/nonexportable key.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const maxMessage = 1024 * 1024
const maxPayload = 16 * 1024
const maxRecords = 4096
const ledgerVersion = 3 // private store only; ticket/probe/config wire versions remain 1.
const ledgerStageScheme = "native_object_slot_v1"
const timeout = 10 * time.Second

type descriptor struct {
	VolumeID     string `json:"volumeId"`
	FileID       string `json:"fileId"`
	CreationTime string `json:"creationTime"`
	PathKey      string `json:"pathKey"`
}
type allowedBinding struct {
	DeviceID         string     `json:"deviceId"`
	ExecutorSourceID string     `json:"executorSourceId"`
	HelperInstanceID string     `json:"helperInstanceId"`
	Root             descriptor `json:"root"`
}
type pin struct {
	Issuer    string `json:"issuer"`
	ServiceID string `json:"serviceId"`
	KeyEpoch  uint64 `json:"keyEpoch"`
	PublicKey string `json:"publicKey"`
}

// All fields are mandatory. Config and grants are root-owned regular files under
// root-owned non-writable ancestors; no TOFU or client self-registration exists.
// AuthProcess is enrolled by the independent administrator/control-plane service,
// not by this CLI. It must be replaced on auth-service restart (PID/starttime).
// Grants contains fresh exact-binding approvals published by that independent
// privileged control plane; no caller can write it, and a PID/image alone is never
// permission to sign. The current TS signer does not provision these grants.
type config struct {
	Version                             int               `json:"version"`
	BrokerServiceID                     string            `json:"brokerServiceId"`
	Pin                                 pin               `json:"pin"`
	BrokerUID                           uint32            `json:"brokerUid"`
	AuthUID                             uint32            `json:"authUid"`
	AuthGID                             uint32            `json:"authGid"`
	ToolWorkerUIDs                      []uint32          `json:"toolWorkerUids"`
	ToolWorkerProcesses                 []processIdentity `json:"toolWorkerProcesses"`
	AllowRegisteredAuthGrantPublication bool              `json:"allowRegisteredAuthGrantPublication"`
	DynamicGrantsFile                   string            `json:"dynamicGrantsFile"`
	Binary                              string            `json:"binary"`
	BinarySHA256                        string            `json:"binarySha256"`
	Socket                              string            `json:"socket"`
	PrivateDir                          string            `json:"privateDir"`
	KeyFile                             string            `json:"keyFile"`
	StateFile                           string            `json:"stateFile"`
	GrantsFile                          string            `json:"grantsFile"`
	AuthProcess                         processIdentity   `json:"authProcess"`
	BrokerProcess                       processIdentity   `json:"brokerProcess"`
	AuthCodeRoot                        string            `json:"authCodeRoot"`
	AuthEntry                           string            `json:"authEntry"`
	AllowedCustodyModels                []string          `json:"allowedCustodyModels"`
	AllowedRoots                        []descriptor      `json:"allowedRoots"`
	AllowedBindings                     []allowedBinding  `json:"allowedBindings"`
	AllowedActions                      []string          `json:"allowedActions"`
	// Independent administrator-preinstalled public v2 enrollment. Optional:
	// absence disables only first-capture public inspection, not legacy signing.
	FirstCaptureEnrollmentFile string `json:"firstCaptureEnrollmentFile,omitempty"`
}
type request struct {
	Version   int    `json:"version"`
	Method    string `json:"method"`
	Payload   string `json:"payload,omitempty"`
	Challenge string `json:"challenge,omitempty"`
	Phase     string `json:"phase,omitempty"`
}
type signatureResponse struct {
	Version   int    `json:"version"`
	Signature string `json:"signature"`
}
type grant struct {
	BindingHash string `json:"bindingHash"`
	NotBefore   int64  `json:"notBefore"`
	ExpiresAt   int64  `json:"expiresAt"`
}
type grantFile struct {
	Version      int     `json:"version"`
	ConfigDigest string  `json:"configDigest"`
	Grants       []grant `json:"grants"`
}
type dynamicGrant struct {
	BindingHash string `json:"bindingHash"`
	ExpiresAt   int64  `json:"expiresAt"`
}
type dynamicGrantFile struct {
	Version      int                     `json:"version"`
	ConfigDigest string                  `json:"configDigest"`
	Grants       map[string]dynamicGrant `json:"grants"`
}
type grantResponse struct {
	Version       int    `json:"version"`
	PayloadDigest string `json:"payloadDigest"`
	ExpiresAt     int64  `json:"expiresAt"`
}
type signedRecord struct {
	Digest    string `json:"digest"`
	Signature string `json:"signature"`
	Stage     string `json:"stage"`
}
type stageRecord struct {
	Master      string `json:"master"`
	BindingHash string `json:"bindingHash"`
}
type fenceRecord struct {
	Fence      uint64 `json:"fence"`
	Generation uint64 `json:"generation"`
	Session    string `json:"session"`
}
type durableState struct {
	Version      int                     `json:"version"`
	StageScheme  string                  `json:"stageScheme"`
	ConfigDigest string                  `json:"configDigest"`
	Operations   map[string]signedRecord `json:"operations"`
	Nonces       map[string]string       `json:"nonces"`
	Fences       map[string]fenceRecord  `json:"fences"`
	Masters      map[string]string       `json:"masters"`
	Stages       map[string]stageRecord  `json:"stages"`
}
type securityFacts struct {
	BrokerServiceID                    string   `json:"brokerServiceId"`
	BrokerPrincipal                    string   `json:"brokerPrincipal"`
	AuthServicePrincipal               string   `json:"authServicePrincipal"`
	ToolWorkerPrincipals               []string `json:"toolWorkerPrincipals"`
	CustodyModel                       string   `json:"custodyModel"`
	AllowedCustodyModels               []string `json:"allowedCustodyModels"`
	BrokerProcessBound                 bool     `json:"brokerProcessBound"`
	AuthServiceProcessBound            bool     `json:"authServiceProcessBound"`
	SigningContractValidated           bool     `json:"signingContractValidated"`
	SignerRestrictsRootAndAction       bool     `json:"signerRestrictsRootAndAction"`
	SingleActionGrantRequired          bool     `json:"singleActionGrantRequired"`
	DurableReplayProtection            bool     `json:"durableReplayProtection"`
	KeyNonExportable                   bool     `json:"keyNonExportable"`
	KeyACLAdminAndBrokerOnly           bool     `json:"keyAclAdminAndBrokerOnly"`
	ConfigACLAdminOnly                 bool     `json:"configAclAdminOnly"`
	CallerACLAuthServiceOnly           bool     `json:"callerAclAuthServiceOnly"`
	WorkerCannotImpersonateAuthService bool     `json:"workerCannotImpersonateAuthService"`
	PeerAuthenticatedByOS              bool     `json:"peerAuthenticatedByOs"`
	BrokerRestrictsWindowsIOContract   bool     `json:"brokerRestrictsWindowsIoContract"`
}
type probePayload struct {
	Version         int               `json:"version"`
	Domain          string            `json:"domain"`
	Challenge       string            `json:"challenge"`
	Phase           string            `json:"phase"`
	ConfigDigest    string            `json:"configDigest"`
	IssuedAt        int64             `json:"issuedAt"`
	Broker          processIdentity   `json:"broker"`
	Caller          processIdentity   `json:"caller"`
	AuthProcess     processIdentity   `json:"authProcess"`
	WorkerProcesses []processIdentity `json:"workerProcesses"`
	CustodyModel    string            `json:"custodyModel"`
	Facts           securityFacts     `json:"facts"`
}
type proofResponse struct {
	Version   int    `json:"version"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type broker struct {
	mu           sync.Mutex
	configPath   string
	configDigest string
	cfg          config
	key          ed25519.PrivateKey
}

func strictDecode(b []byte, v any) error {
	if !utf8.Valid(b) {
		return errors.New("invalid UTF8")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("trailing JSON")
	}
	// Duplicate keys are rejected recursively, even in nested objects.
	var walk func(*json.Decoder) error
	walk = func(d *json.Decoder) error {
		t, err := d.Token()
		if err != nil {
			return err
		}
		if delim, ok := t.(json.Delim); ok {
			if delim == '{' {
				seen := map[string]bool{}
				for d.More() {
					k, e := d.Token()
					if e != nil {
						return e
					}
					s, ok := k.(string)
					if !ok || seen[s] {
						return errors.New("duplicate key")
					}
					seen[s] = true
					if e = walk(d); e != nil {
						return e
					}
				}
			} else if delim == '[' {
				for d.More() {
					if e := walk(d); e != nil {
						return e
					}
				}
			} else {
				return errors.New("unexpected delimiter")
			}
			_, err = d.Token()
		}
		return err
	}
	return walk(json.NewDecoder(bytes.NewReader(b)))
}
func canonical(v any) ([]byte, error) {
	// All authority keys are ASCII. Map key sorting agrees with the TS contract.
	var buf bytes.Buffer
	e := json.NewEncoder(&buf)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	// Round-trip structs to maps to sort every level, without float64 conversion.
	var normalized any
	d := json.NewDecoder(bytes.NewReader(buf.Bytes()))
	d.UseNumber()
	if err := d.Decode(&normalized); err != nil {
		return nil, err
	}
	buf.Reset()
	if err := e.Encode(normalized); err != nil {
		return nil, err
	}
	b := bytes.TrimSuffix(buf.Bytes(), []byte{'\n'})
	// encoding/json escapes these valid JS string characters; JSON.stringify does not.
	b = bytes.ReplaceAll(b, []byte(`\u2028`), []byte("\u2028"))
	b = bytes.ReplaceAll(b, []byte(`\u2029`), []byte("\u2029"))
	return b, nil
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func decode64(s string, max int) ([]byte, error) {
	if len(s) > ((max*4+2)/3) || strings.ContainsAny(s, "=+/\r\n") {
		return nil, errors.New("encoding budget")
	}
	b, e := base64.RawURLEncoding.Strict().DecodeString(s)
	if e != nil || len(b) > max || base64.RawURLEncoding.EncodeToString(b) != s {
		return nil, errors.New("noncanonical encoding")
	}
	return b, nil
}
func readBounded(path string, limit int) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, int64(limit+1)))
	if len(b) > limit {
		return nil, errors.New("file too large")
	}
	return b, e
}
func validID(s string, max int) bool {
	if s == "" || len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func hashValid(s string) bool {
	b, e := hex.DecodeString(s)
	return e == nil && len(b) == 32 && strings.ToLower(s) == s
}
func uintClaim(v any) (uint64, error) {
	s, ok := v.(json.Number)
	if !ok {
		return 0, errors.New("integer required")
	}
	n, e := strconv.ParseUint(s.String(), 10, 64)
	if e != nil || n > 9007199254740991 {
		return 0, errors.New("unsafe integer")
	}
	return n, nil
}
func loadConfig(path string) (config, string, error) {
	var c config
	if !nativeSupported() {
		return c, "", errors.New("WINDOWS_IO_UNIX_CUSTODY_REQUIRES_LINUX_SO_PEERCRED")
	}
	if e := protectedPath(path, 0, false, false); e != nil {
		return c, "", e
	}
	b, e := readBounded(path, 64*1024)
	if e != nil {
		return c, "", e
	}
	if e = strictDecode(b, &c); e != nil {
		return c, "", e
	}
	if c.Version != 1 || !validID(c.BrokerServiceID, 256) || !validID(c.Pin.Issuer, 256) || !validID(c.Pin.ServiceID, 256) || c.Pin.KeyEpoch > 9007199254740991 || c.BrokerUID == 0 || c.AuthUID == 0 || c.BrokerUID == c.AuthUID || c.AuthGID == 0 || len(c.ToolWorkerUIDs) == 0 || len(c.ToolWorkerUIDs) > 64 || len(c.AllowedRoots) == 0 || len(c.AllowedRoots) > 64 || len(c.AllowedActions) == 0 {
		return c, "", errors.New("invalid isolation configuration")
	}
	seen := map[uint32]bool{}
	for _, u := range c.ToolWorkerUIDs {
		if u == 0 || u == c.BrokerUID || u == c.AuthUID || seen[u] {
			return c, "", errors.New("tool UID isolation unavailable")
		}
		seen[u] = true
	}
	if len(c.AllowedBindings) == 0 || len(c.AllowedBindings) > 64 {
		return c, "", errors.New("device/source/helper binding allowlist missing")
	}
	for _, binding := range c.AllowedBindings {
		if !validID(binding.DeviceID, 256) || !validID(binding.ExecutorSourceID, 256) || !validID(binding.HelperInstanceID, 256) || !validDescriptor(binding.Root) {
			return c, "", errors.New("invalid device/source/helper binding")
		}
	}
	for _, root := range c.AllowedRoots {
		if !validDescriptor(root) {
			return c, "", errors.New("invalid root descriptor")
		}
	}
	for _, a := range c.AllowedActions {
		if !isAction(a) {
			return c, "", errors.New("invalid action allowlist")
		}
	}
	pub, e := decode64(c.Pin.PublicKey, 32)
	if e != nil || len(pub) != 32 {
		return c, "", errors.New("invalid public pin")
	}
	if !hashValid(c.BinarySHA256) {
		return c, "", errors.New("invalid binary pin")
	}
	if e = protectedPath(c.Binary, 0, false, false); e != nil {
		return c, "", e
	}
	bin, e := readBounded(c.Binary, 64*1024*1024)
	if e != nil || digest(bin) != c.BinarySHA256 {
		return c, "", errors.New("binary pin mismatch")
	}
	if e = protectedPath(c.PrivateDir, c.BrokerUID, true, true); e != nil {
		return c, "", e
	}
	if filepath.Dir(c.KeyFile) != c.PrivateDir || filepath.Dir(c.StateFile) != c.PrivateDir || filepath.Dir(c.DynamicGrantsFile) != c.PrivateDir || c.KeyFile == c.StateFile || c.DynamicGrantsFile == c.KeyFile || c.DynamicGrantsFile == c.StateFile {
		return c, "", errors.New("invalid private storage")
	}
	// Auth UID deliberately cannot stat/read children of the 0700 service directory.
	// The broker checks actual leaf ownership and signs that native evidence.
	if uint32(os.Getuid()) == c.BrokerUID {
		if e = checkPrivateFile(c.KeyFile, c.PrivateDir, c.BrokerUID); e != nil {
			return c, "", e
		}
		if e = checkPrivateFile(c.StateFile, c.PrivateDir, c.BrokerUID); e != nil {
			return c, "", e
		}
		if e = checkPrivateFile(c.DynamicGrantsFile, c.PrivateDir, c.BrokerUID); e != nil {
			return c, "", e
		}
	}
	if e = protectedPath(c.GrantsFile, 0, false, false); e != nil {
		return c, "", e
	}
	if e = protectedPath(filepath.Dir(c.Socket), c.BrokerUID, true, false); e != nil {
		return c, "", e
	}
	if c.AuthProcess.PID <= 1 || c.AuthProcess.UID != c.AuthUID || !c.AuthProcess.NoNewPrivileges || !validID(c.AuthProcess.StartTime, 64) || !hashValid(c.AuthProcess.ExeSHA256) {
		return c, "", errors.New("auth service not enrolled")
	}
	if c.BrokerProcess.PID <= 1 || c.BrokerProcess.UID != c.BrokerUID || !c.BrokerProcess.NoNewPrivileges || c.BrokerProcess.Exe != c.Binary || c.BrokerProcess.ExeSHA256 != c.BinarySHA256 || !validID(c.BrokerProcess.StartTime, 64) {
		return c, "", errors.New("broker service not enrolled")
	}
	// Only the broker may be explicitly enrolled with CAP_SYS_PTRACE (bit 19)
	// for native cross-UID process inspection. Auth/tools must have zero caps.
	if (c.BrokerProcess.EffectiveCapabilities|c.BrokerProcess.PermittedCapabilities|c.BrokerProcess.AmbientCapabilities)&^(uint64(1)<<19) != 0 || (c.AuthProcess.EffectiveCapabilities|c.AuthProcess.PermittedCapabilities|c.AuthProcess.AmbientCapabilities) != 0 {
		return c, "", errors.New("service token capability isolation unavailable")
	}
	if len(c.AllowedCustodyModels) == 0 || len(c.AllowedCustodyModels) > 2 {
		return c, "", errors.New("custody policy missing")
	}
	for _, model := range c.AllowedCustodyModels {
		if model != "hardware_nonexportable" && model != "os_isolated_software" {
			return c, "", errors.New("unknown custody model")
		}
	}
	if e = protectedPath(c.AuthProcess.Exe, 0, false, false); e != nil {
		return c, "", e
	}
	if e = validateAuthCode(c); e != nil {
		return c, "", e
	}
	if len(c.ToolWorkerProcesses) != len(c.ToolWorkerUIDs) {
		return c, "", errors.New("ordinary worker domains not registered")
	}
	for i, worker := range c.ToolWorkerProcesses {
		if worker.UID != c.ToolWorkerUIDs[i] || !worker.NoNewPrivileges {
			return c, "", errors.New("worker uid/token domain mismatch")
		}
		if (worker.EffectiveCapabilities | worker.PermittedCapabilities | worker.AmbientCapabilities) != 0 {
			return c, "", errors.New("privileged tool worker forbidden")
		}
		if uint32(os.Getuid()) == c.BrokerUID {
			actual, e := inspectProcess(worker.PID)
			if e != nil || !equalProcess(actual, worker) {
				return c, "", errors.New("ordinary worker kernel process identity unavailable")
			}
		}
	}
	return c, digest(b), nil
}
func equalProcess(a, b processIdentity) bool { return a == b }
func (b *broker) current() error {
	c, d, e := loadConfig(b.configPath)
	if e != nil {
		return e
	}
	if d != b.configDigest || c.Pin != b.cfg.Pin {
		return errors.New("configuration changed: restart through operator")
	}
	return nil
}
func (b *broker) caller(p processIdentity) (processIdentity, error) {
	c := b.cfg
	if p.UID != c.AuthUID || !p.NoNewPrivileges || p.Exe != c.Binary || p.ExeSHA256 != c.BinarySHA256 || p.ParentPID != c.AuthProcess.PID {
		return processIdentity{}, errors.New("unregistered client")
	}
	parent, e := inspectProcess(p.ParentPID)
	if e != nil || !equalProcess(parent, c.AuthProcess) {
		return processIdentity{}, errors.New("auth service creation identity mismatch")
	}
	return parent, nil
}
func validDescriptor(d descriptor) bool {
	return validID(d.VolumeID, 256) && validID(d.FileID, 256) && validID(d.CreationTime, 256) && validID(d.PathKey, 4096)
}
func isAction(a string) bool {
	switch a {
	case "capture_exact", "prepare_owned", "restore_original", "seal_owned", "unseal_original", "cleanup_created", "status_original":
		return true
	}
	return false
}
func has(values []string, s string) bool {
	for _, v := range values {
		if v == s {
			return true
		}
	}
	return false
}

var payloadKeys = []string{"version", "issuer", "serviceId", "keyEpoch", "deviceId", "executorSourceId", "helperInstanceId", "challengeNonce", "connectionId", "sessionId", "runtimeGeneration", "actorSubjectKey", "narratorId", "projectId", "originRefHash", "action", "budgetClass", "scopeId", "root", "parent", "target", "operationId", "requestDigest", "leaseId", "fence", "expectedCurrentMetadataHash", "expectedCurrentContentHash", "captureProofId", "preparedObjectId", "recoveryOriginal", "issuedAt", "expiresAt", "nonce"}

func exactKeys(m map[string]any, keys []string) bool {
	if len(m) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return false
		}
	}
	return true
}
func stringClaim(m map[string]any, k string) string { s, _ := m[k].(string); return s }
func parsePayload(raw []byte, c config, now int64) (map[string]any, string, error) {
	if len(raw) == 0 || len(raw) > maxPayload || !utf8.Valid(raw) {
		return nil, "", errors.New("payload budget")
	}
	var m map[string]any
	if e := strictDecode(raw, &m); e != nil {
		return nil, "", e
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := d.Decode(&m); e != nil {
		return nil, "", e
	}
	if !exactKeys(m, payloadKeys) {
		return nil, "", errors.New("payload fields")
	}
	for _, k := range []string{"issuer", "serviceId", "deviceId", "executorSourceId", "helperInstanceId", "connectionId", "sessionId", "actorSubjectKey", "scopeId", "operationId", "leaseId"} {
		if !validID(stringClaim(m, k), 256) {
			return nil, "", errors.New("invalid identity")
		}
	}
	for _, k := range []string{"narratorId", "projectId", "captureProofId", "preparedObjectId"} {
		if m[k] != nil && !validID(stringClaim(m, k), 256) {
			return nil, "", errors.New("invalid nullable identity")
		}
	}
	for _, k := range []string{"version", "keyEpoch", "runtimeGeneration", "fence", "issuedAt", "expiresAt"} {
		if _, e := uintClaim(m[k]); e != nil {
			return nil, "", e
		}
	}
	v, _ := uintClaim(m["version"])
	epoch, _ := uintClaim(m["keyEpoch"])
	if v != 1 || epoch != c.Pin.KeyEpoch || stringClaim(m, "issuer") != c.Pin.Issuer || stringClaim(m, "serviceId") != c.Pin.ServiceID {
		return nil, "", errors.New("issuer epoch mismatch")
	}
	for _, k := range []string{"originRefHash", "requestDigest"} {
		if !hashValid(stringClaim(m, k)) {
			return nil, "", errors.New("digest required")
		}
	}
	for _, k := range []string{"expectedCurrentMetadataHash", "expectedCurrentContentHash"} {
		if m[k] != nil && !hashValid(stringClaim(m, k)) {
			return nil, "", errors.New("invalid expected hash")
		}
	}
	for _, k := range []string{"nonce", "challengeNonce"} {
		s := stringClaim(m, k)
		decoded, e := decode64(s, 96)
		if e != nil || len(s) < 32 || len(s) > 128 || len(decoded) < 24 {
			return nil, "", errors.New("invalid nonce")
		}
	}
	var root descriptor
	for _, k := range []string{"root", "parent", "target"} {
		obj, ok := m[k].(map[string]any)
		if !ok || !exactKeys(obj, []string{"volumeId", "fileId", "creationTime", "pathKey"}) {
			return nil, "", errors.New("descriptor fields")
		}
		data, _ := canonical(obj)
		var d descriptor
		if strictDecode(data, &d) != nil || !validDescriptor(d) {
			return nil, "", errors.New("descriptor invalid")
		}
		if k == "root" {
			root = d
		} else if d.VolumeID != root.VolumeID {
			return nil, "", errors.New("cross-volume descriptor")
		}
	}
	allowed := false
	for _, r := range c.AllowedRoots {
		if r == root {
			allowed = true
		}
	}
	if !allowed {
		return nil, "", errors.New("root not registered")
	}
	bound := false
	for _, binding := range c.AllowedBindings {
		if binding.Root == root && binding.DeviceID == stringClaim(m, "deviceId") && binding.ExecutorSourceID == stringClaim(m, "executorSourceId") && binding.HelperInstanceID == stringClaim(m, "helperInstanceId") {
			bound = true
		}
	}
	if !bound {
		return nil, "", errors.New("device/source/helper root binding not registered")
	}
	a := stringClaim(m, "action")
	if !isAction(a) || !has(c.AllowedActions, a) {
		return nil, "", errors.New("action denied")
	}
	if has([]string{"restore_original", "unseal_original", "seal_owned", "status_original"}, a) && m["captureProofId"] == nil {
		return nil, "", errors.New("original proof required")
	}
	if has([]string{"prepare_owned", "cleanup_created"}, a) && (m["preparedObjectId"] == nil || m["captureProofId"] != nil) {
		return nil, "", errors.New("owned proof required")
	}
	if a == "capture_exact" && (m["captureProofId"] != nil || m["preparedObjectId"] != nil || m["recoveryOriginal"] != nil) {
		return nil, "", errors.New("capture proof forbidden")
	}
	if m["recoveryOriginal"] != nil {
		r, ok := m["recoveryOriginal"].(map[string]any)
		if !ok || !exactKeys(r, []string{"operationId", "requestDigest", "leaseId", "fence"}) || !has([]string{"restore_original", "unseal_original", "status_original"}, a) || !validID(stringClaim(r, "operationId"), 256) || !validID(stringClaim(r, "leaseId"), 256) || !hashValid(stringClaim(r, "requestDigest")) {
			return nil, "", errors.New("recovery binding")
		}
		if _, e := uintClaim(r["fence"]); e != nil {
			return nil, "", e
		}
	}
	ttl := uint64(0)
	switch stringClaim(m, "budgetClass") {
	case "metadata":
		ttl = 30000
	case "operation":
		ttl = 120000
	case "attachment":
		ttl = 300000
	default:
		return nil, "", errors.New("unknown budget")
	}
	i, _ := uintClaim(m["issuedAt"])
	e, _ := uintClaim(m["expiresAt"])
	if i > uint64(now) || e <= uint64(now) || e <= i || e-i > ttl {
		return nil, "", errors.New("stale or excessive lifetime")
	}
	canon, err := canonical(m)
	if err != nil || !bytes.Equal(canon, raw) {
		return nil, "", errors.New("noncanonical ticket bytes")
	}
	binding := make(map[string]any, len(m))
	for k, v := range m {
		if k != "nonce" && k != "issuedAt" && k != "expiresAt" {
			binding[k] = v
		}
	}
	bindingBytes, _ := canonical(binding)
	return m, digest(bindingBytes), nil
}
func (b *broker) freshGrant(binding, payloadDigest string, now int64, expires uint64) error {
	if b.cfg.AllowRegisteredAuthGrantPublication {
		g, e := b.readDynamicGrants()
		if e != nil {
			return e
		}
		r, ok := g.Grants[payloadDigest]
		if !ok || r.BindingHash != binding || r.ExpiresAt <= now || r.ExpiresAt != int64(expires) {
			return errors.New("fresh exact authenticated-service grant required")
		}
		return nil
	}
	if e := protectedPath(b.cfg.GrantsFile, 0, false, false); e != nil {
		return e
	}
	data, e := readBounded(b.cfg.GrantsFile, maxMessage)
	if e != nil {
		return e
	}
	var g grantFile
	if e = strictDecode(data, &g); e != nil {
		return e
	}
	if g.Version != 1 || g.ConfigDigest != b.configDigest || len(g.Grants) > 2048 {
		return errors.New("grant trust root mismatch")
	}
	for _, r := range g.Grants {
		if r.BindingHash == binding && r.NotBefore <= now && r.ExpiresAt > now && r.ExpiresAt >= int64(expires) && r.ExpiresAt-r.NotBefore <= 300000 {
			return nil
		}
	}
	return errors.New("fresh exact control-plane grant required")
}
func (b *broker) readDynamicGrants() (dynamicGrantFile, error) {
	var g dynamicGrantFile
	if e := checkPrivateFile(b.cfg.DynamicGrantsFile, b.cfg.PrivateDir, b.cfg.BrokerUID); e != nil {
		return g, e
	}
	data, e := readBounded(b.cfg.DynamicGrantsFile, maxMessage)
	if e != nil {
		return g, e
	}
	if e = strictDecode(data, &g); e != nil {
		return g, e
	}
	if g.Version != 1 || g.ConfigDigest != b.configDigest || g.Grants == nil || len(g.Grants) > 2048 {
		return g, errors.New("dynamic grant store unavailable")
	}
	for payload, r := range g.Grants {
		if !hashValid(payload) || !hashValid(r.BindingHash) || r.ExpiresAt < 0 || r.ExpiresAt > 9007199254740991 {
			return g, errors.New("invalid dynamic grant")
		}
	}
	return g, nil
}
func (b *broker) persistPrivateJSON(path string, out []byte) error {
	if len(out) > maxMessage {
		return errors.New("private store budget exceeded")
	}
	if e := checkPrivateFile(path, b.cfg.PrivateDir, b.cfg.BrokerUID); e != nil {
		return e
	}
	tmp, e := os.CreateTemp(b.cfg.PrivateDir, ".grant-intent-")
	if e != nil {
		return e
	}
	name := tmp.Name()
	defer os.Remove(name)
	if e = tmp.Chmod(0600); e == nil {
		_, e = tmp.Write(out)
	}
	if e == nil {
		e = tmp.Sync()
	}
	closeErr := tmp.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	if e = os.Rename(name, path); e != nil {
		return e
	}
	dir, e := os.Open(b.cfg.PrivateDir)
	if e != nil {
		return e
	}
	e = dir.Sync()
	dir.Close()
	return e
}

// A fresh grant can be published only by the OS-authenticated, administrator
// enrolled, immutable authorization service (not a tool worker or a client PID
// claim). This role is disabled by default and explicitly delegated in root
// policy. Upstream service MUST check authentic actor/ACL/original tuple first.
// We validate the exact Windows IO contract again; no arbitrary-byte signing or
// generic grant surface exists. The entire original ticket (including nonce and
// expiry) is approved, persisted and required by the later signature request.
func (b *broker) publishGrant(raw []byte, now int64) (grantResponse, error) {
	if !b.cfg.AllowRegisteredAuthGrantPublication || !has(b.cfg.AllowedCustodyModels, "os_isolated_software") {
		return grantResponse{}, errors.New("authorization publication role not delegated")
	}
	m, binding, e := parsePayload(raw, b.cfg, now)
	if e != nil {
		return grantResponse{}, e
	}
	g, e := b.readDynamicGrants()
	if e != nil {
		return grantResponse{}, e
	}
	for d, r := range g.Grants {
		if r.ExpiresAt <= now {
			delete(g.Grants, d)
		}
	}
	pd := digest(raw)
	if _, exists := g.Grants[pd]; !exists && len(g.Grants) >= 2048 {
		return grantResponse{}, errors.New("dynamic grant queue full")
	}
	expires, _ := uintClaim(m["expiresAt"])
	g.Grants[pd] = dynamicGrant{binding, int64(expires)}
	out, e := canonical(g)
	if e != nil {
		return grantResponse{}, e
	}
	if e = b.persistPrivateJSON(b.cfg.DynamicGrantsFile, out); e != nil {
		return grantResponse{}, e
	}
	return grantResponse{1, pd, int64(expires)}, nil
}
func (b *broker) sign(raw []byte, now int64) (signatureResponse, error) {
	if !has(b.cfg.AllowedCustodyModels, "os_isolated_software") {
		return signatureResponse{}, errors.New("software custody not administrator-allowed")
	}
	m, binding, e := parsePayload(raw, b.cfg, now)
	if e != nil {
		return signatureResponse{}, e
	}
	expires, _ := uintClaim(m["expiresAt"])
	if e = b.freshGrant(binding, digest(raw), now, expires); e != nil {
		return signatureResponse{}, e
	}
	if e = checkPrivateFile(b.cfg.StateFile, b.cfg.PrivateDir, b.cfg.BrokerUID); e != nil {
		return signatureResponse{}, e
	}
	data, e := readBounded(b.cfg.StateFile, maxMessage)
	if e != nil {
		return signatureResponse{}, e
	}
	var s durableState
	if e = strictDecode(data, &s); e != nil {
		return signatureResponse{}, e
	}
	response, e := b.authorizeState(&s, m, raw)
	if e != nil {
		return signatureResponse{}, e
	}
	out, e := canonical(s)
	if e != nil || len(out) > maxMessage {
		return signatureResponse{}, errors.New("state budget exceeded")
	}
	// Persist signature before returning it. Exact retries return prior bytes; crashes
	// cannot consume a nonce without preserving the corresponding original signature.
	tmp, e := os.CreateTemp(b.cfg.PrivateDir, ".intent-")
	if e != nil {
		return signatureResponse{}, e
	}
	name := tmp.Name()
	defer os.Remove(name)
	if e = tmp.Chmod(0600); e == nil {
		_, e = tmp.Write(out)
	}
	if e == nil {
		e = tmp.Sync()
	}
	closeErr := tmp.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return signatureResponse{}, e
	}
	if e = os.Rename(name, b.cfg.StateFile); e != nil {
		return signatureResponse{}, e
	}
	dir, e := os.Open(b.cfg.PrivateDir)
	if e != nil {
		return signatureResponse{}, e
	}
	e = dir.Sync()
	dir.Close()
	if e != nil {
		return signatureResponse{}, e
	}
	return response, nil
}

// Pure state transition, called only after the OS caller and fresh exact grant
// have been checked. Unit tests exercise this without claiming native readiness.
func (b *broker) authorizeState(s *durableState, m map[string]any, raw []byte) (signatureResponse, error) {
	if s.Version != ledgerVersion || s.StageScheme != ledgerStageScheme || s.ConfigDigest != b.configDigest || s.Operations == nil || s.Nonces == nil || s.Fences == nil || s.Masters == nil || s.Stages == nil {
		return signatureResponse{}, errors.New("state epoch/schema mismatch: operator upgrade required")
	}
	parts := []string{stringClaim(m, "deviceId"), stringClaim(m, "executorSourceId"), stringClaim(m, "scopeId"), stringClaim(m, "operationId")}
	masterBytes, _ := canonical(parts)
	master := digest(masterBytes)
	masterContext := map[string]any{}
	for _, k := range []string{"version", "issuer", "serviceId", "keyEpoch", "deviceId", "executorSourceId", "helperInstanceId", "connectionId", "sessionId", "runtimeGeneration", "actorSubjectKey", "narratorId", "projectId", "originRefHash", "scopeId", "root", "operationId", "requestDigest", "leaseId", "fence", "recoveryOriginal"} {
		masterContext[k] = m[k]
	}
	masterRaw, _ := canonical(masterContext)
	masterBinding := digest(masterRaw)
	if prior, exists := s.Masters[master]; exists && prior != masterBinding {
		return signatureResponse{}, errors.New("master original-operation equivocation")
	}
	// Mutation stage identity is physical root/parent/target object plus slot and
	// action under the original master. Proof IDs, creation times and expected
	// metadata are NOT selectors: swapping any of them must hit the SAME stage
	// and fail its strict intent binding, never mint another mutation stage.
	// This also rejects a reclaimed FileID at the same slot with new creation.
	stageIdentity := map[string]any{"master": master, "action": m["action"]}
	for _, name := range []string{"root", "parent", "target"} {
		d := m[name].(map[string]any)
		stageIdentity[name] = map[string]any{"volumeId": d["volumeId"], "fileId": d["fileId"], "pathKey": d["pathKey"]}
	}
	if stringClaim(m, "action") == "capture_exact" || stringClaim(m, "action") == "status_original" {
		// Observation challenges MUST first have passed the protected helper
		// registry/signature check in the authentic service's fresh exact grant.
		// A random nonce is never authority to register a new observation.
		stageIdentity["registeredObservationChallenge"] = m["challengeNonce"]
	}
	stageRaw, _ := canonical(stageIdentity)
	stage := digest(stageRaw)
	stageContext := map[string]any{"masterBinding": masterBinding}
	for _, k := range []string{"action", "budgetClass", "parent", "target", "captureProofId", "preparedObjectId", "expectedCurrentMetadataHash", "expectedCurrentContentHash"} {
		stageContext[k] = m[k]
	}
	stageBindingRaw, _ := canonical(stageContext)
	stageBinding := digest(stageBindingRaw)
	if prior, exists := s.Stages[stage]; exists && (prior.Master != master || prior.BindingHash != stageBinding) {
		return signatureResponse{}, errors.New("registered stage binding equivocation")
	}
	scopeBytes, _ := canonical(parts[:3])
	scope := digest(scopeBytes)
	fence, _ := uintClaim(m["fence"])
	generation, _ := uintClaim(m["runtimeGeneration"])
	session := stringClaim(m, "sessionId")
	if prev, ok := s.Fences[scope]; ok {
		if fence < prev.Fence || generation < prev.Generation || (session != prev.Session && (fence <= prev.Fence || generation <= prev.Generation)) {
			return signatureResponse{}, errors.New("stale fence/session")
		}
	}
	payloadDigest := digest(raw)
	if prior, exists := s.Operations[payloadDigest]; exists {
		if prior.Digest != payloadDigest || prior.Stage != stage {
			return signatureResponse{}, errors.New("ticket record equivocation")
		}
		sig, e := decode64(prior.Signature, 64)
		if e != nil || !ed25519.Verify(b.key.Public().(ed25519.PublicKey), raw, sig) {
			return signatureResponse{}, errors.New("corrupt persisted signature")
		}
		return signatureResponse{1, prior.Signature}, nil
	}
	nonce := stringClaim(m, "nonce")
	if _, used := s.Nonces[nonce]; used {
		return signatureResponse{}, errors.New("nonce replay")
	}
	if len(s.Operations) >= maxRecords || len(s.Nonces) >= maxRecords || len(s.Fences) >= maxRecords || len(s.Masters) >= maxRecords || len(s.Stages) >= maxRecords {
		return signatureResponse{}, errors.New("durable authorization budget exhausted: operator rotation required")
	}
	sig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(b.key, raw))
	s.Masters[master] = masterBinding
	s.Stages[stage] = stageRecord{master, stageBinding}
	s.Operations[payloadDigest] = signedRecord{payloadDigest, sig, stage}
	s.Nonces[nonce] = payloadDigest
	s.Fences[scope] = fenceRecord{fence, generation, session}
	return signatureResponse{1, sig}, nil
}
func (b *broker) validateStore() error {
	data, e := readBounded(b.cfg.StateFile, maxMessage)
	if e != nil {
		return e
	}
	var s durableState
	if e = strictDecode(data, &s); e != nil {
		return e
	}
	if s.Version != ledgerVersion || s.StageScheme != ledgerStageScheme || s.ConfigDigest != b.configDigest || s.Operations == nil || s.Nonces == nil || s.Fences == nil || s.Masters == nil || s.Stages == nil || len(s.Operations) > maxRecords || len(s.Nonces) != len(s.Operations) || len(s.Fences) > maxRecords || len(s.Masters) > maxRecords || len(s.Stages) > maxRecords {
		return errors.New("durable store unavailable")
	}
	for master, binding := range s.Masters {
		if !hashValid(master) || !hashValid(binding) {
			return errors.New("corrupt master binding")
		}
	}
	for stage, record := range s.Stages {
		if !hashValid(stage) || !hashValid(record.BindingHash) {
			return errors.New("corrupt stage binding")
		}
		if _, exists := s.Masters[record.Master]; !exists {
			return errors.New("orphan registered stage")
		}
	}
	for op, record := range s.Operations {
		sig, e := decode64(record.Signature, 64)
		if _, exists := s.Stages[record.Stage]; !exists {
			return errors.New("orphan ticket signature")
		}
		if !hashValid(op) || record.Digest != op || e != nil || len(sig) != 64 {
			return errors.New("corrupt durable record")
		}
	}
	for nonce, op := range s.Nonces {
		decoded, e := decode64(nonce, 96)
		if e != nil || len(decoded) < 24 {
			return errors.New("corrupt durable nonce")
		}
		if _, ok := s.Operations[op]; !ok {
			return errors.New("orphan nonce")
		}
	}
	for scope, f := range s.Fences {
		if !hashValid(scope) || f.Fence > 9007199254740991 || f.Generation > 9007199254740991 || !validID(f.Session, 256) {
			return errors.New("corrupt durable fence")
		}
	}
	data, e = readBounded(b.cfg.GrantsFile, maxMessage)
	if e != nil {
		return e
	}
	var g grantFile
	if e = strictDecode(data, &g); e != nil {
		return e
	}
	if g.Version != 1 || g.ConfigDigest != b.configDigest || len(g.Grants) > 2048 {
		return errors.New("control-plane grants unavailable")
	}
	for _, grant := range g.Grants {
		if !hashValid(grant.BindingHash) || grant.NotBefore < 0 || grant.ExpiresAt <= grant.NotBefore || grant.ExpiresAt-grant.NotBefore > 300000 {
			return errors.New("invalid control-plane grant")
		}
	}
	if _, e := b.readDynamicGrants(); e != nil {
		return e
	}
	// Confirm required durability APIs work on the operator-provisioned store.
	f, e := os.OpenFile(b.cfg.StateFile, os.O_RDWR, 0)
	if e != nil {
		return e
	}
	e = f.Sync()
	f.Close()
	if e != nil {
		return e
	}
	dir, e := os.Open(b.cfg.PrivateDir)
	if e != nil {
		return e
	}
	e = dir.Sync()
	dir.Close()
	return e
}
func (b *broker) probe(req request, caller, parent processIdentity) (proofResponse, error) {
	if (req.Phase != "before" && req.Phase != "after") || req.Payload != "" {
		return proofResponse{}, errors.New("invalid probe")
	}
	challenge, e := decode64(req.Challenge, 32)
	if e != nil || len(challenge) != 32 {
		return proofResponse{}, errors.New("challenge required")
	}
	self, e := inspectBrokerProcess(os.Getpid())
	if e != nil || !equalProcess(self, b.cfg.BrokerProcess) {
		return proofResponse{}, errors.New("broker executable identity changed")
	}
	if e := b.validateStore(); e != nil {
		return proofResponse{}, e
	}
	workers := []string{}
	for _, u := range b.cfg.ToolWorkerUIDs {
		workers = append(workers, fmt.Sprintf("uid:%d", u))
	}
	sort.Strings(workers)
	facts := securityFacts{BrokerServiceID: b.cfg.BrokerServiceID, BrokerPrincipal: fmt.Sprintf("uid:%d", b.cfg.BrokerUID), AuthServicePrincipal: fmt.Sprintf("uid:%d", b.cfg.AuthUID), ToolWorkerPrincipals: workers, CustodyModel: "os_isolated_software", AllowedCustodyModels: b.cfg.AllowedCustodyModels, BrokerProcessBound: true, AuthServiceProcessBound: true, SigningContractValidated: true, SignerRestrictsRootAndAction: true, SingleActionGrantRequired: true, DurableReplayProtection: true, KeyNonExportable: false, KeyACLAdminAndBrokerOnly: true, ConfigACLAdminOnly: true, CallerACLAuthServiceOnly: true, WorkerCannotImpersonateAuthService: true, PeerAuthenticatedByOS: true, BrokerRestrictsWindowsIOContract: true}
	p := probePayload{1, "windows_io_broker_security_probe_v1", req.Challenge, req.Phase, b.configDigest, time.Now().UnixMilli(), self, caller, parent, b.cfg.ToolWorkerProcesses, "os_isolated_software", facts}
	// Separate signed domain; not a generic caller-selected signing endpoint.
	raw, e := canonical(p)
	if e != nil {
		return proofResponse{}, e
	}
	return proofResponse{1, base64.RawURLEncoding.EncodeToString(raw), base64.RawURLEncoding.EncodeToString(ed25519.Sign(b.key, raw))}, nil
}
func (b *broker) dispatch(raw []byte, p processIdentity) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if e := b.current(); e != nil {
		return nil, e
	}
	parent, e := b.caller(p)
	if e != nil {
		return nil, e
	}
	var r request
	if e = strictDecode(raw, &r); e != nil || r.Version != 1 {
		return nil, errors.New("invalid broker request")
	}
	var result any
	switch r.Method {
	case "inspect_windows_io_security":
		result, e = b.probe(r, p, parent)
	case firstCaptureInspectionMethod:
		result, e = b.firstCaptureInspection(raw)
	case "authorize_windows_io_operation":
		if r.Challenge != "" || r.Phase != "" {
			return nil, errors.New("grant fields forbidden")
		}
		var payload []byte
		payload, e = decode64(r.Payload, maxPayload)
		if e == nil {
			result, e = b.publishGrant(payload, time.Now().UnixMilli())
		}
	case "sign_windows_io_authorization":
		if r.Challenge != "" || r.Phase != "" {
			return nil, errors.New("sign fields forbidden")
		}
		var payload []byte
		payload, e = decode64(r.Payload, maxPayload)
		if e == nil {
			result, e = b.sign(payload, time.Now().UnixMilli())
		}
	default:
		return nil, errors.New("method denied")
	}
	if e != nil {
		return nil, e
	}
	return json.Marshal(result)
}
func readFrame(conn net.Conn, limit int) ([]byte, error) {
	var size [4]byte
	if _, e := io.ReadFull(conn, size[:]); e != nil {
		return nil, e
	}
	n := binary.BigEndian.Uint32(size[:])
	if n == 0 || n > uint32(limit) {
		return nil, errors.New("frame budget exceeded")
	}
	b := make([]byte, n)
	_, e := io.ReadFull(conn, b)
	return b, e
}
func writeFrame(conn net.Conn, b []byte) error {
	if len(b) == 0 || len(b) > maxMessage {
		return errors.New("frame budget exceeded")
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(b)))
	if _, e := io.Copy(conn, bytes.NewReader(size[:])); e != nil {
		return e
	}
	_, e := io.Copy(conn, bytes.NewReader(b))
	return e
}
func client(configPath string, raw []byte) ([]byte, error) {
	c, configDigest, e := loadConfig(configPath)
	if e != nil {
		return nil, e
	}
	if uint32(os.Getuid()) != c.AuthUID {
		return nil, errors.New("caller UID mismatch")
	}
	self, e := inspectProcess(os.Getpid())
	if e != nil || self.Exe != c.Binary || self.ExeSHA256 != c.BinarySHA256 || self.ParentPID != c.AuthProcess.PID {
		return nil, errors.New("client executable or auth parent mismatch")
	}
	parent, e := inspectProcess(self.ParentPID)
	if e != nil || !equalProcess(parent, c.AuthProcess) {
		return nil, errors.New("auth service identity mismatch")
	}
	if e = verifySocket(c.Socket, c); e != nil {
		return nil, e
	}
	conn, e := net.DialTimeout("unix", c.Socket, timeout)
	if e != nil {
		return nil, e
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))
	peer, e := verifyBrokerPeer(conn.(*net.UnixConn), c)
	if e != nil {
		return nil, errors.New("server OS peer mismatch")
	}
	if e = writeFrame(conn, raw); e != nil {
		return nil, e
	}
	out, e := readFrame(conn, maxMessage)
	if e != nil {
		return nil, e
	}
	after, e := verifyBrokerPeer(conn.(*net.UnixConn), c)
	if e != nil || after != peer {
		return nil, errors.New("server creation identity changed")
	}
	_, currentDigest, e := loadConfig(configPath)
	if e != nil || currentDigest != configDigest {
		return nil, errors.New("configuration changed during IPC")
	}
	return out, nil
}
func serve(path string) error {
	c, d, e := loadConfig(path)
	if e != nil {
		return e
	}
	if uint32(os.Getuid()) != c.BrokerUID {
		return errors.New("daemon must run as isolated broker UID")
	}
	self, e := inspectBrokerProcess(os.Getpid())
	if e != nil || !equalProcess(self, c.BrokerProcess) {
		return errors.New("daemon creation identity mismatch")
	}
	// Seed is provisioned only by operators. It is never emitted or generated here.
	seed, e := readBounded(c.KeyFile, 32)
	if e != nil || len(seed) != 32 {
		return errors.New("invalid protected key seed")
	}
	key := ed25519.NewKeyFromSeed(seed)
	for i := range seed {
		seed[i] = 0
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	pub, _ := decode64(c.Pin.PublicKey, 32)
	if !bytes.Equal(pub, key.Public().(ed25519.PublicKey)) {
		return errors.New("administrator public pin mismatch")
	}
	b := &broker{configPath: path, configDigest: d, cfg: c, key: key}
	// Never unlink an existing socket (a running service or crash evidence).
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: c.Socket, Net: "unix"})
	if e != nil {
		return e
	}
	listener.SetUnlinkOnClose(false)
	defer listener.Close()
	if e = os.Chmod(c.Socket, 0660); e != nil {
		return e
	}
	if e = os.Chown(c.Socket, int(c.BrokerUID), int(c.AuthGID)); e != nil {
		return e
	}
	if e = verifySocket(c.Socket, c); e != nil {
		return e
	}
	slots := make(chan struct{}, 64)
	for {
		conn, e := listener.AcceptUnix()
		if e != nil {
			return e
		}
		select {
		case slots <- struct{}{}:
		default:
			conn.Close()
			continue
		}
		go func() {
			defer func() { <-slots; conn.Close() }()
			conn.SetDeadline(time.Now().Add(timeout))
			p, e := peerIdentity(conn)
			if e != nil {
				return
			}
			raw, e := readFrame(conn, maxMessage)
			if e != nil {
				return
			}
			out, e := b.dispatch(raw, p)
			if e != nil {
				return
			}
			after, e := peerIdentity(conn)
			if e != nil || !equalProcess(p, after) {
				return
			}
			_ = writeFrame(conn, out)
		}()
	}
}
func run() error {
	configPath := flag.String("config", "", "absolute administrator-owned configuration path")
	clientMode := flag.Bool("client", false, "one bounded request from stdin through OS-authenticated Unix socket")
	serveMode := flag.Bool("serve", false, "isolated daemon; requires operator provisioning")
	checkMode := flag.Bool("check", false, "client security probe; challenge/phase JSON comes from stdin")
	flag.Parse()
	if flag.NArg() != 0 || *configPath == "" || (*serveMode && (*clientMode || *checkMode)) || (!*serveMode && !*clientMode && !*checkMode) {
		return errors.New("usage: broker --serve --config PATH | broker --client [--check] --config PATH")
	}
	if *serveMode {
		return serve(*configPath)
	}
	// The entire CLI lifetime, including malicious never-EOF stdin and stdout
	// backpressure, is bounded. On timeout main exits and closes all child-only
	// handles; no signing daemon/service is stopped or restarted.
	result := make(chan error, 1)
	go func() { result <- runClientRequest(*configPath, *checkMode) }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case e := <-result:
		return e
	case <-timer.C:
		_ = os.Stdin.Close()
		return errors.New("bounded signing client timed out")
	}
}
func runClientRequest(configPath string, checkMode bool) error {
	raw, e := io.ReadAll(io.LimitReader(os.Stdin, maxMessage+1))
	if e != nil || len(raw) > maxMessage {
		return errors.New("stdin request budget exceeded")
	}
	if checkMode {
		var r request
		if strictDecode(raw, &r) != nil || r.Method != "inspect_windows_io_security" {
			return errors.New("check requires a bounded security challenge")
		}
	}
	out, e := client(configPath, raw)
	if e != nil {
		return e
	}
	_, e = os.Stdout.Write(out)
	return e
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "WINDOWS_IO_BROKER_UNREADY")
		os.Exit(1)
	}
}
