package windowsbackup

import (
	"context"
	"fmt"
)

// ValidatedFingerprint is never derived from a caller's standalone hash. It
// resolves the opaque proof through the current authenticated channel and the
// helper's own protected original record before returning matrix semantics.
func ValidatedFingerprint(ctx context.Context, data []byte) (string, error) {
	descriptor, err := DecodeDescriptor(data)
	if err != nil {
		return "", err
	}
	channel, err := Channel(ctx)
	if err != nil {
		return "", err
	}
	if err := channel.ValidateOriginal(ctx, descriptor); err != nil {
		return "", err
	}
	return descriptor.MetadataDigest, nil
}

// AttachmentPublication is handler-frozen evidence, not decoded caller authority.
// Only the exact prepared slot -> final slot transition is admitted. Cleanup,
// private-root quarantine and recovery are deliberately outside this purpose.
type AttachmentPublication struct {
	Root, Parent, Prepared, Final NativeDescriptor
	ContentDigest                 string
}

func VerifyAttachmentPublication(ctx context.Context, a, b []byte, frozen AttachmentPublication) error {
	left, err := DecodeDescriptor(a)
	if err != nil {
		return err
	}
	right, err := DecodeDescriptor(b)
	if err != nil {
		return err
	}
	channel, err := Channel(ctx)
	if err != nil {
		return err
	}
	// ValidateOriginal uses nil handles: authenticates each signed proof and the
	// helper's own full private snapshot plus original operation/actor binding.
	if err := channel.ValidateOriginal(ctx, left); err != nil {
		return err
	}
	if err := channel.ValidateOriginal(ctx, right); err != nil {
		return err
	}
	if !validHash(frozen.ContentDigest) || frozen.Prepared.PathKey == "" || frozen.Final.PathKey == "" ||
		left.Root != frozen.Root || right.Root != frozen.Root ||
		left.Parent != frozen.Parent || right.Parent != frozen.Parent ||
		left.Target != frozen.Prepared || right.Target != frozen.Final ||
		left.Target.VolumeID != right.Target.VolumeID || left.Target.FileID != right.Target.FileID || left.Target.CreationTime != right.Target.CreationTime {
		return fmt.Errorf("attachment publication frozen namespace/object/slot changed")
	}
	if left.MetadataDigest != right.MetadataDigest || left.ContentDigest != frozen.ContentDigest || right.ContentDigest != frozen.ContentDigest {
		return fmt.Errorf("attachment publication full metadata/content changed")
	}
	return nil
}

func EquivalentMetadata(ctx context.Context, a, b []byte) (bool, error) {
	left, err := DecodeDescriptor(a)
	if err != nil {
		return false, err
	}
	right, err := DecodeDescriptor(b)
	if err != nil {
		return false, err
	}
	lf, err := ValidatedFingerprint(ctx, a)
	if err != nil {
		return false, err
	}
	rf, err := ValidatedFingerprint(ctx, b)
	if err != nil {
		return false, err
	}
	if left.Root != right.Root || left.Parent != right.Parent || left.Target != right.Target {
		return false, fmt.Errorf("native metadata original namespace/object changed")
	}
	return lf == rf, nil
}
