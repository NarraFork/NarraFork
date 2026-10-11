package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"time"
)

// Frozen shared/windows-first-capture.ts public-only contract. This method does
// not capture, enroll a root, publish a grant, sign an arbitrary payload, or expose
// any secret. Existing ticket/probe/config wire v1 and private ledger v3 remain.
const firstCaptureInspectionMethod = "inspect_windows_first_capture_enrollment"
const firstCaptureInspectionDomain = "windows_metadata_public_enrollment_inspection_v1"
const firstCapturePublicBytes = 64 * 1024
const firstCaptureInspectionRequestBytes = 16 * 1024
const firstCaptureEnrollmentPolicy = "capture_only_existing_ordinary_v2"
const firstCaptureEnrollmentMatrix = "ordinary-file-v2"

// CreationTime deliberately stays a decimal string: Windows FILETIME can exceed
// JS MAX_SAFE_INTEGER. All JSON number fields stay in the safe integer range.
type firstCapturePipePeer struct {
	Name         string `json:"name"`
	ProcessID    uint32 `json:"processId"`
	CreationTime string `json:"creationTime"`
	SID          string `json:"sid"`
}
type firstCaptureSession struct {
	ConnectionID      string `json:"connectionId"`
	SessionID         string `json:"sessionId"`
	RuntimeGeneration uint64 `json:"runtimeGeneration"`
}
type firstCaptureEnrollment struct {
	Version          int                  `json:"version"`
	EnrollmentID     string               `json:"enrollmentId"`
	Revision         uint64               `json:"revision"`
	Matrix           string               `json:"matrix"`
	DeviceID         string               `json:"deviceId"`
	ExecutorSourceID string               `json:"executorSourceId"`
	Root             descriptor           `json:"root"`
	HelperInstanceID string               `json:"helperInstanceId"`
	HelperPublicKey  string               `json:"helperPublicKey"`
	HelperKeyEpoch   uint64               `json:"helperKeyEpoch"`
	PipePeer         firstCapturePipePeer `json:"pipePeer"`
	Session          firstCaptureSession  `json:"session"`
	Policy           string               `json:"policy"`
}
type firstCaptureInspectionPayload struct {
	Domain               string                 `json:"domain"`
	Version              int                    `json:"version"`
	Challenge            string                 `json:"challenge"`
	IssuedAt             int64                  `json:"issuedAt"`
	BrokerServiceID      string                 `json:"brokerServiceId"`
	ConfigDigest         string                 `json:"configDigest"`
	EnrollmentFileDigest string                 `json:"enrollmentFileDigest"`
	Enrollment           firstCaptureEnrollment `json:"enrollment"`
}

func parseFirstCaptureEnrollment(raw []byte, c config) (firstCaptureEnrollment, error) {
	var e firstCaptureEnrollment
	if len(raw) == 0 || len(raw) > firstCapturePublicBytes {
		return e, errors.New("public enrollment budget exceeded")
	}
	if err := strictDecode(raw, &e); err != nil {
		return e, err
	}
	if e.Version != 2 || e.Matrix != firstCaptureEnrollmentMatrix || e.Policy != firstCaptureEnrollmentPolicy || e.Revision > 9007199254740991 || e.HelperKeyEpoch > 9007199254740991 || e.Session.RuntimeGeneration > 9007199254740991 {
		return e, errors.New("public enrollment version/matrix/policy mismatch")
	}
	for _, id := range []string{e.EnrollmentID, e.DeviceID, e.ExecutorSourceID, e.HelperInstanceID, e.PipePeer.SID, e.Session.ConnectionID, e.Session.SessionID} {
		if !validID(id, 256) {
			return e, errors.New("invalid public enrollment identity")
		}
	}
	if !validDescriptor(e.Root) || !validID(e.PipePeer.Name, 256) || e.PipePeer.ProcessID == 0 {
		return e, errors.New("invalid enrolled root/pipe peer")
	}
	created, err := strconv.ParseUint(e.PipePeer.CreationTime, 10, 64)
	if err != nil || created == 0 || strconv.FormatUint(created, 10) != e.PipePeer.CreationTime {
		return e, errors.New("invalid enrolled helper creation time")
	}
	pub, err := decode64(e.HelperPublicKey, ed25519.PublicKeySize)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return e, errors.New("invalid enrolled helper public pin")
	}
	// A public enrollment cannot self-register roots/devices/helper instances.
	// Match an already administrator-allowed exact tuple and root descriptor.
	rootAllowed := false
	for _, root := range c.AllowedRoots {
		if root == e.Root {
			rootAllowed = true
		}
	}
	bindingAllowed := false
	for _, binding := range c.AllowedBindings {
		if binding.Root == e.Root && binding.DeviceID == e.DeviceID && binding.ExecutorSourceID == e.ExecutorSourceID && binding.HelperInstanceID == e.HelperInstanceID {
			bindingAllowed = true
		}
	}
	if !rootAllowed || !bindingAllowed {
		return e, errors.New("public enrollment is not in protected root/source/helper allowlist")
	}
	canon, err := canonical(e)
	if err != nil || !bytes.Equal(canon, raw) {
		return e, errors.New("public enrollment must be original canonical UTF8 bytes")
	}
	return e, nil
}
func readFirstCaptureEnrollment(path string, c config) (firstCaptureEnrollment, []byte, error) {
	var e firstCaptureEnrollment
	if path == "" {
		return e, nil, errors.New("WINDOWS_FIRST_CAPTURE_PUBLIC_ENROLLMENT_NOT_CONFIGURED")
	}
	if err := protectedPath(path, 0, false, false); err != nil {
		return e, nil, err
	}
	raw, err := readBounded(path, firstCapturePublicBytes)
	if err != nil {
		return e, nil, err
	}
	if err = protectedPath(path, 0, false, false); err != nil {
		return e, nil, err
	}
	e, err = parseFirstCaptureEnrollment(raw, c)
	return e, raw, err
}
func parseFirstCaptureInspectionRequest(raw []byte) (request, error) {
	var r request
	if len(raw) == 0 || len(raw) > firstCaptureInspectionRequestBytes {
		return r, errors.New("public inspection request budget exceeded")
	}
	// Dedicated shape: empty-but-present payload/phase is also not permitted.
	var fields map[string]json.RawMessage
	if err := strictDecode(raw, &fields); err != nil {
		return r, err
	}
	if len(fields) != 3 || fields["version"] == nil || fields["method"] == nil || fields["challenge"] == nil {
		return r, errors.New("public inspection requires exact fields")
	}
	if err := strictDecode(raw, &r); err != nil {
		return r, err
	}
	if r.Version != 1 || r.Method != firstCaptureInspectionMethod {
		return r, errors.New("public inspection method/version mismatch")
	}
	nonce, err := decode64(r.Challenge, 96)
	if err != nil || len(r.Challenge) < 32 || len(r.Challenge) > 128 || len(nonce) < 24 {
		return r, errors.New("public inspection challenge required")
	}
	return r, nil
}

// Pure bounded public attestation formatter. Production invokes it only after
// the existing OS caller/code/process/ledger checks; unit tests are not readiness.
func encodeFirstCaptureInspection(c config, configDigest string, enrollment firstCaptureEnrollment, enrollmentRaw []byte, challenge string, now int64, key ed25519.PrivateKey) (proofResponse, error) {
	if now < 0 || now > 9007199254740991 || !validID(c.BrokerServiceID, 256) || !hashValid(configDigest) || len(key) != ed25519.PrivateKeySize {
		return proofResponse{}, errors.New("invalid public inspection context")
	}
	p := firstCaptureInspectionPayload{firstCaptureInspectionDomain, 1, challenge, now, c.BrokerServiceID, configDigest, digest(enrollmentRaw), enrollment}
	raw, err := canonical(p)
	if err != nil {
		return proofResponse{}, err
	}
	// Base64 expands raw JSON; enforce the FULL signed envelope limit, not only
	// its payload. No truncation, pagination surprise, or generic signing surface.
	proof := proofResponse{1, base64.RawURLEncoding.EncodeToString(raw), base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, raw))}
	out, err := json.Marshal(proof)
	if err != nil || len(out) > firstCapturePublicBytes {
		return proofResponse{}, errors.New("public inspection response budget exceeded")
	}
	return proof, nil
}
func (b *broker) firstCaptureInspection(rawRequest []byte) (proofResponse, error) {
	r, err := parseFirstCaptureInspectionRequest(rawRequest)
	if err != nil {
		return proofResponse{}, err
	}
	// dispatch already ran current()/caller() under the existing mutex. Preserve
	// the real self executable identity and private store readiness before issuing
	// this separate public domain. No new root/grant/nonce/stage is written here.
	self, err := inspectBrokerProcess(os.Getpid())
	if err != nil || !equalProcess(self, b.cfg.BrokerProcess) {
		return proofResponse{}, errors.New("broker executable identity changed")
	}
	if err = b.validateStore(); err != nil {
		return proofResponse{}, err
	}
	e, raw, err := readFirstCaptureEnrollment(b.cfg.FirstCaptureEnrollmentFile, b.cfg)
	if err != nil {
		return proofResponse{}, err
	}
	if !has(b.cfg.AllowedActions, "capture_exact") {
		return proofResponse{}, errors.New("capture-only primitive not administrator allowlisted")
	}
	proof, err := encodeFirstCaptureInspection(b.cfg, b.configDigest, e, raw, r.Challenge, time.Now().UnixMilli(), b.key)
	if err != nil {
		return proofResponse{}, err
	}
	// Bind a stable immutable configuration snapshot across asynchronous IPC.
	if err = b.current(); err != nil {
		return proofResponse{}, err
	}
	_, after, err := readFirstCaptureEnrollment(b.cfg.FirstCaptureEnrollmentFile, b.cfg)
	if err != nil || !bytes.Equal(raw, after) {
		return proofResponse{}, errors.New("public enrollment changed during inspection")
	}
	return proof, nil
}
