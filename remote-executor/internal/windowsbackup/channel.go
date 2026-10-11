package windowsbackup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
)

// Descriptor is public proof/projection only. It NEVER contains a security
// descriptor, EA data or stream bytes. The helper's original protected capture
// record is the only authority for privileged installation.
type Descriptor struct {
	Version        int               `json:"version"`
	Platform       string            `json:"platform"`
	Matrix         string            `json:"matrix"`
	Coverage       string            `json:"coverage"`
	Proof          CaptureProof      `json:"proof"`
	Root           NativeDescriptor  `json:"root"`
	Parent         NativeDescriptor  `json:"parent"`
	Target         NativeDescriptor  `json:"target"`
	MetadataDigest string            `json:"metadataDigest"`
	ContentDigest  string            `json:"contentDigest"`
	Attributes     uint32            `json:"attributes"`
	Fields         map[string]string `json:"fields"`
}

func (d *Descriptor) Validate() error {
	if d.Version != 2 || d.Platform != "windows" || d.Matrix != "ordinary-file-v2" || d.Coverage != "complete" || !validHash(d.MetadataDigest) || !validHash(d.ContentDigest) || d.Proof.Version != 1 || !validID(d.Proof.RecordID, 256) || !validHash(d.Proof.RecordDigest) || !validNonce(d.Proof.RecordNonce) {
		return ErrIncomplete
	}
	if len(d.Fields) != len(requiredFields) {
		return ErrIncomplete
	}
	for _, name := range requiredFields {
		state := d.Fields[name]
		if state != "captured_exact" && state != "known_absent" {
			return ErrIncomplete
		}
	}
	for _, name := range []string{"owner", "group", "dacl", "sacl", "label", "times", "attributes", "singleLink", "ordinaryFile"} {
		if d.Fields[name] != "captured_exact" {
			return ErrIncomplete
		}
	}
	if d.Fields["specialSecurity"] != "known_absent" {
		return ErrIncomplete
	}
	for _, native := range []NativeDescriptor{d.Root, d.Parent, d.Target} {
		if !validID(native.VolumeID, 256) || !validID(native.FileID, 256) || !validID(native.CreationTime, 256) || !validID(native.PathKey, 4096) {
			return ErrIncomplete
		}
	}
	return nil
}
func EncodeDescriptor(d *Descriptor) ([]byte, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(d)
	if len(raw) > MetadataBytes {
		return nil, ErrIncomplete
	}
	return raw, err
}
func DecodeDescriptor(raw []byte) (*Descriptor, error) {
	if len(raw) > MetadataBytes {
		return nil, ErrIncomplete
	}
	if err := rejectDuplicateJSON(raw); err != nil {
		return nil, err
	}
	var d Descriptor
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&d); err != nil {
		return nil, err
	}
	return &d, d.Validate()
}

// MetadataChannel is injected by trusted runtime setup. Ordinary executors use
// the administrator-authorized pipe transport; legitimate-token channels use the
// SAME verifier/protected-record contract. There is no default self-signing key.
func descriptorFromSnapshot(t Ticket, s *Snapshot, content string, proof CaptureProof) (*Descriptor, error) {
	metadata, err := SnapshotFingerprint(s)
	if err != nil {
		return nil, err
	}
	fields := make(map[string]string, len(s.Manifest))
	for k, v := range s.Manifest {
		fields[k] = v
	}
	d := &Descriptor{Version: 2, Platform: "windows", Matrix: s.Matrix, Coverage: "complete", Proof: proof, Root: t.Root, Parent: t.Parent, Target: t.Target, MetadataDigest: metadata, ContentDigest: content, Attributes: s.Attributes, Fields: fields}
	return d, d.Validate()
}

type MetadataChannel interface {
	Capture(context.Context, *os.File) (*Descriptor, error)
	ApplyOriginal(context.Context, *os.File, *Descriptor) error
	MatchesOriginal(context.Context, *os.File, *Descriptor) error
	ValidateOriginal(context.Context, *Descriptor) error
}
type channelKey struct{}

func WithMetadataChannel(ctx context.Context, channel MetadataChannel) context.Context {
	return context.WithValue(ctx, channelKey{}, channel)
}
func Channel(ctx context.Context) (MetadataChannel, error) {
	channel, _ := ctx.Value(channelKey{}).(MetadataChannel)
	if channel == nil {
		return nil, ErrHelperRequired
	}
	return channel, nil
}

type MetadataAuthorizationRequest struct {
	Action   string
	File     *os.File // ordinary authorized handle, never serialized as a path claim
	Original *Descriptor
	Prepared *Descriptor
}
type MetadataTicketIssuer interface {
	IssueMetadataTicket(context.Context, MetadataAuthorizationRequest) ([]byte, error)
}
type HelperTransport interface {
	Execute(context.Context, []byte, *os.File, *CaptureProof) (*OperationResult, error)
}
type AuthorizedChannel struct {
	Issuer           MetadataTicketIssuer
	Transport        HelperTransport
	HelperInstanceID string
	HelperKeyEpoch   uint64
	HelperPublicKey  []byte
}

func (c *AuthorizedChannel) invoke(ctx context.Context, action string, file *os.File, original, prepared *Descriptor) (*OperationResult, error) {
	if c.Issuer == nil || c.Transport == nil || len(c.HelperPublicKey) != 32 {
		return nil, fmt.Errorf("Windows full metadata authority/channel not ready")
	}
	ticket, err := c.Issuer.IssueMetadataTicket(ctx, MetadataAuthorizationRequest{action, file, original, prepared})
	if err != nil {
		return nil, err
	}
	var proof *CaptureProof
	if original != nil {
		proof = &original.Proof
	} else if prepared != nil {
		proof = &prepared.Proof
	}
	result, err := c.Transport.Execute(ctx, ticket, file, proof)
	if err != nil {
		return result, err
	}
	if result == nil || result.State == "unknown" || result.State == "dispatched" || result.State == "intent" || result.State == "rejected" {
		return result, fmt.Errorf("Windows helper action did not prove completion")
	}
	return result, nil
}
func (c *AuthorizedChannel) Capture(ctx context.Context, file *os.File) (*Descriptor, error) {
	result, err := c.invoke(ctx, "capture_exact", file, nil, nil)
	if err != nil {
		return nil, err
	}
	d := result.Descriptor
	if d == nil {
		return nil, ErrIncomplete
	}
	if err := d.Validate(); err != nil {
		return nil, err
	}
	if d.Proof.HelperInstanceID != c.HelperInstanceID || d.Proof.KeyEpoch != c.HelperKeyEpoch {
		return nil, fmt.Errorf("capture helper binding")
	}
	if err := VerifyProof(d.Proof, c.HelperPublicKey); err != nil {
		return nil, err
	}
	return d, nil
}
func (c *AuthorizedChannel) validateOriginal(ctx context.Context, file *os.File, original *Descriptor) error {
	if err := original.Validate(); err != nil {
		return err
	}
	if err := VerifyProof(original.Proof, c.HelperPublicKey); err != nil {
		return err
	}
	result, err := c.invoke(ctx, "status_original", file, original, nil)
	if err != nil {
		return err
	}
	if result.Descriptor == nil {
		return ErrIncomplete
	}
	supplied, err := EncodeDescriptor(original)
	if err != nil {
		return err
	}
	stored, err := EncodeDescriptor(result.Descriptor)
	if err != nil {
		return err
	}
	if !bytes.Equal(supplied, stored) {
		return fmt.Errorf("client metadata descriptor differs from helper original record")
	}
	return nil
}
func (c *AuthorizedChannel) ApplyOriginal(ctx context.Context, file *os.File, original *Descriptor) error {
	// Authenticate the historical projection independently of the new ordinary
	// handle. A current descriptor must never masquerade as the old record.
	if err := c.validateOriginal(ctx, nil, original); err != nil {
		return err
	}
	prepared, err := c.Capture(ctx, file)
	if err != nil {
		return err
	}
	if _, err := c.invoke(ctx, "prepare_owned", file, nil, prepared); err != nil {
		return err
	}
	if _, err := c.invoke(ctx, "restore_original", file, original, prepared); err != nil {
		return err
	}
	return c.MatchesOriginal(ctx, file, original)
}
func (c *AuthorizedChannel) ValidateOriginal(ctx context.Context, original *Descriptor) error {
	return c.validateOriginal(ctx, nil, original)
}
func (c *AuthorizedChannel) MatchesOriginal(ctx context.Context, file *os.File, original *Descriptor) error {
	if err := c.validateOriginal(ctx, file, original); err != nil {
		return err
	}
	current, err := c.Capture(ctx, file)
	if err != nil {
		return err
	}
	if current.MetadataDigest != original.MetadataDigest {
		return fmt.Errorf("native_metadata_changed")
	}
	return nil
}
