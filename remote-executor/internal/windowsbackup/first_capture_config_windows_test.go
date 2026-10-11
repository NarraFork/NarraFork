//go:build windows

package windowsbackup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeWindowsFirstCaptureConfigurationRejectsUnprotectedOrMissingMaterial(t *testing.T) {
	requirePreparedScratch(t)
	if _, _, err := LoadFirstCaptureEnrollment(context.Background(), ""); err == nil {
		t.Fatal("missing enrollment unexpectedly ready")
	}
	if _, _, _, err := LoadFirstCaptureHelperConfiguration(context.Background(), ""); err == nil {
		t.Fatal("missing helper/private signing material unexpectedly ready")
	}
	path := filepath.Join(t.TempDir(), "untrusted-public-enrollment.json")
	if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
		t.Fatal("fixture write failed")
	}
	if _, pin, err := LoadFirstCaptureEnrollment(context.Background(), path); err == nil {
		if pin != nil {
			pin.Close()
		}
		t.Fatal("unprotected/missing-fields enrollment accepted")
	}
	if _, files, key, err := LoadFirstCaptureHelperConfiguration(context.Background(), path); err == nil {
		for _, file := range files {
			file.Close()
		}
		_ = key
		t.Fatal("unprotected/missing-fields helper config accepted")
	}
	t.Log("missing/unprotected/unknown-typed administrator material stays unavailable; no key generation/helper startup/fallback")
}
