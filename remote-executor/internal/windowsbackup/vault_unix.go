//go:build !windows

package windowsbackup

import (
	"context"
	"fmt"
	"os"
)

func nativeObjectIdentity(file *os.File) (string, error) { return protectedIdentity(file.Name()) }
func validateVaultVolume(path, volumeID, guid string) error {
	return fmt.Errorf("native Windows volume vault not available on this platform")
}
func allocatedBytes(file *os.File) (int64, error) {
	return 0, fmt.Errorf("Windows allocated-space evidence unavailable")
}
func vaultAvailable(path string, required int64) error {
	return fmt.Errorf("Windows volume evidence unavailable")
}
func moveVaultOriginal(ctx context.Context, file *os.File, destination, serviceSID string) error {
	return fmt.Errorf("Windows native vault unavailable")
}
func verifyVaultLocation(file *os.File, wanted string) error {
	return fmt.Errorf("Windows native vault unavailable")
}
func restoreVaultOriginal(ctx context.Context, file *os.File, snapshot *Snapshot, target, serviceSID string) error {
	return fmt.Errorf("Windows native vault unavailable")
}
func captureVaultFingerprint(ctx context.Context, file *os.File) (string, error) {
	return "", fmt.Errorf("Windows full metadata unavailable")
}
