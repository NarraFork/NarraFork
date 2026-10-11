package windowsbackup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type VaultReference struct {
	Version               int    `json:"version"`
	VolumeGUID            string `json:"volumeGuid"`
	VolumeID              string `json:"volumeId"`
	VaultIdentity         string `json:"vaultIdentity"`
	SourceID              string `json:"sourceId"`
	ScopeID               string `json:"scopeId"`
	OperationID           string `json:"operationId"`
	RequestDigest         string `json:"requestDigest"`
	Fence                 uint64 `json:"fence"`
	OriginalIdentity      string `json:"originalIdentity"`
	HistoricalFingerprint string `json:"historicalFingerprint"`
	SealedFingerprint     string `json:"sealedFingerprint"`
	AllocatedBytes        int64  `json:"allocatedBytes"`
	RecordID              string `json:"recordId"`
	State                 string `json:"state"`
}

// Vaults are administrator-configured on the actual original object volume,
// outside all public workspace roots. Journal/CAS may remain on another volume.
type VaultConfig struct {
	Store                StoreConfig
	VolumeID, VolumeGUID string
	PublicRoots          []string
}
type Vault struct {
	config VaultConfig
	store  *ProtectedStore
	mu     sync.Mutex
}

func OpenVault(c VaultConfig) (*Vault, error) {
	if !validID(c.VolumeID, 256) || !validID(c.VolumeGUID, 256) || len(c.PublicRoots) == 0 || len(c.PublicRoots) > 64 {
		return nil, fmt.Errorf("vault volume/public-root config")
	}
	for _, root := range c.PublicRoots {
		if !filepath.IsAbs(root) {
			return nil, fmt.Errorf("public root must be absolute")
		}
		if withinDirectory(root, c.Store.Directory) || withinDirectory(c.Store.Directory, root) {
			return nil, fmt.Errorf("vault must be outside public workspaces")
		}
	}
	store, err := NewProtectedStore(c.Store)
	if err != nil {
		return nil, err
	}
	if err := validateVaultVolume(c.Store.Directory, c.VolumeID, c.VolumeGUID); err != nil {
		return nil, err
	}
	return &Vault{config: c, store: store}, nil
}
func withinDirectory(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && (rel == "." || rel != ".." && len(rel) > 0 && rel[:1] != "." && !filepath.IsAbs(rel))
}
func (v *Vault) Directory() string      { return v.config.Store.Directory }
func (v *Vault) PrivatePaths() []string { return []string{v.config.Store.Directory} }
func (v *Vault) originalReference(t Ticket, original *CaptureRecord) (*VaultReference, error) {
	if original == nil || original.ID == "" {
		return nil, fmt.Errorf("original helper record required")
	}
	raw, err := v.store.read("vault-"+original.ID+".json", MetadataBytes+64<<10)
	if err != nil {
		return nil, err
	}
	var saved struct {
		Reference *VaultReference
		Original  *CaptureRecord
	}
	if err := json.Unmarshal(raw, &saved); err != nil {
		return nil, err
	}
	ref := saved.Reference
	if ref == nil || saved.Original == nil || ref.Version != 2 || ref.RecordID != original.ID || ref.SourceID != t.ExecutorSourceID || ref.ScopeID != t.ScopeID || ref.VolumeID != t.Root.VolumeID || ref.VaultIdentity != v.store.identity || ref.OperationID != original.Ticket.OperationID || ref.RequestDigest != original.Ticket.RequestDigest || ref.Fence != original.Ticket.Fence {
		return nil, fmt.Errorf("original vault tuple mismatch")
	}
	data, err := Encode(original.Snapshot)
	if err != nil {
		return nil, err
	}
	if Digest(data) != ref.HistoricalFingerprint {
		return nil, fmt.Errorf("historical vault matrix changed")
	}
	return ref, nil
}
func (v *Vault) VerifySealed(ctx context.Context, t *VerifiedTicket, file *os.File, original *CaptureRecord) error {
	if t == nil {
		return fmt.Errorf("verified vault action required")
	}
	ref, err := v.originalReference(t.ticket, original)
	if err != nil {
		return err
	}
	if ref.State != "sealed" || ref.SealedFingerprint == "" {
		return fmt.Errorf("vault seal not proven")
	}
	actual, err := nativeObjectIdentity(file)
	if err != nil || actual != ref.OriginalIdentity {
		return fmt.Errorf("vault original native identity changed")
	}
	fingerprint, err := captureVaultFingerprint(ctx, file)
	if err != nil {
		return err
	}
	if fingerprint != ref.SealedFingerprint {
		return fmt.Errorf("vault sealed fingerprint changed")
	}
	return verifyVaultLocation(file, filepath.Join(v.config.Store.Directory, "original-"+original.ID))
}
func (v *Vault) Unseal(ctx context.Context, t *VerifiedTicket, file *os.File, original *CaptureRecord) error {
	if t == nil || t.ticket.Action != "unseal_original" {
		return fmt.Errorf("fresh original unseal authorization required")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.VerifySealed(ctx, t, file, original); err != nil {
		return err
	}
	if original.TargetPath == "" {
		return fmt.Errorf("original native path slot was not recorded")
	}
	// Restore only helper's own original snapshot on the registered original inode.
	if err := restoreVaultOriginal(ctx, file, original.Snapshot, original.TargetPath, v.config.Store.ServiceSID); err != nil {
		return err
	}
	ref, err := v.originalReference(t.ticket, original)
	if err != nil {
		return err
	}
	ref.State = "unsealed"
	v.store.mu.Lock()
	defer v.store.mu.Unlock()
	return v.store.write("vault-"+original.ID+".json", struct {
		Reference *VaultReference
		Original  *CaptureRecord
	}{ref, original})
}
func (v *Vault) Preflight(ctx context.Context, file *os.File, t Ticket) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if t.Root.VolumeID != v.config.VolumeID || t.Target.VolumeID != v.config.VolumeID {
		return 0, fmt.Errorf("original target/vault volume mismatch")
	}
	if err := validateVaultVolume(v.config.Store.Directory, v.config.VolumeID, v.config.VolumeGUID); err != nil {
		return 0, err
	}
	identity, err := pinnedProtectedIdentity(v.store.root)
	if err != nil || identity != v.store.identity {
		return 0, fmt.Errorf("vault identity changed")
	}
	allocated, err := allocatedBytes(file)
	if err != nil {
		return 0, err
	}
	v.store.mu.Lock()
	defer v.store.mu.Unlock()
	if allocated < 0 || allocated > v.store.config.Quota-v.store.used {
		return 0, fmt.Errorf("vault allocated-space quota")
	}
	if err := vaultAvailable(v.config.Store.Directory, allocated+MetadataBytes); err != nil {
		return 0, err
	}
	return allocated, nil
}

// Preserve moves the actual original inode, then seals the original object's own
// DACL. Full historical metadata is durably recorded BEFORE any move or ACL IO.
// This API requires fresh signed seal authorization and helper-owned capture.
func (v *Vault) Preserve(ctx context.Context, verified *VerifiedTicket, file *os.File, original *CaptureRecord) (*VaultReference, error) {
	if verified == nil || verified.ticket.Action != "seal_owned" || original == nil || original.Snapshot == nil {
		return nil, fmt.Errorf("signed original seal required")
	}
	t := verified.ticket
	if t.CaptureProofID == nil || *t.CaptureProofID != original.ID || t.Root != original.Ticket.Root || t.Target != original.Ticket.Target || t.ActorSubjectKey != original.Ticket.ActorSubjectKey {
		return nil, fmt.Errorf("seal original binding")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	allocated, err := v.Preflight(ctx, file, t)
	if err != nil {
		return nil, err
	}
	originalID, err := nativeObjectIdentity(file)
	if err != nil {
		return nil, err
	}
	snapshot, err := Encode(original.Snapshot)
	if err != nil {
		return nil, err
	}
	if Digest(snapshot) != original.HistoricalFingerprint {
		return nil, fmt.Errorf("historical fingerprint changed")
	}
	ref := &VaultReference{Version: 2, VolumeGUID: v.config.VolumeGUID, VolumeID: v.config.VolumeID, VaultIdentity: v.store.identity, SourceID: t.ExecutorSourceID, ScopeID: t.ScopeID, OperationID: original.Ticket.OperationID, RequestDigest: original.Ticket.RequestDigest, Fence: original.Ticket.Fence, OriginalIdentity: originalID, HistoricalFingerprint: Digest(snapshot), AllocatedBytes: allocated, RecordID: original.ID, State: "intent"}
	v.store.mu.Lock()
	err = v.store.charge(allocated+int64(len(snapshot))+32<<10, true)
	if err == nil {
		err = v.store.write("vault-"+original.ID+".json", struct {
			Reference *VaultReference
			Original  *CaptureRecord
		}{ref, original})
	}
	v.store.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	destination := filepath.Join(v.config.Store.Directory, "original-"+original.ID)
	if err := moveVaultOriginal(ctx, file, destination, v.config.Store.ServiceSID); err != nil {
		return ref, err
	}
	afterID, err := nativeObjectIdentity(file)
	if err != nil || afterID != originalID {
		return ref, fmt.Errorf("vault original identity changed; recovery required")
	}
	sealed, err := captureVaultFingerprint(ctx, file)
	if err != nil {
		return ref, err
	}
	ref.SealedFingerprint = sealed
	ref.State = "sealed"
	v.store.mu.Lock()
	err = v.store.write("vault-"+original.ID+".json", struct {
		Reference *VaultReference
		Original  *CaptureRecord
	}{ref, original})
	v.store.mu.Unlock()
	if err != nil {
		return ref, err
	}
	return ref, nil
}
