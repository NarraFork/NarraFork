//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// TEST ONLY. Four fresh controls eliminate Capture/Restore/backup/ADS data reads
// from the experiment. Drift is a failure observation, never attribution to a
// service, a filesystem behavior, or sibling fsync without source-IO evidence.
func TestNativeWindowsMetadataOnlyCausalControls(t *testing.T) {
	requirePreparedScratch(t)
	for _, ads := range []bool{false, true} {
		for _, exclusive := range []bool{false, true} {
			label := fmt.Sprintf("%s/%s", map[bool]string{false: "main", true: "ads"}[ads], map[bool]string{false: "share-all", true: "share-zero"}[exclusive])
			t.Run(label, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				parent := t.TempDir()
				sourceDir := filepath.Join(parent, "source")
				if err := os.Mkdir(sourceDir, 0700); err != nil {
					t.Fatalf("metadata-control fixture mkdir win32=%d", win32Code(err))
				}
				path := filepath.Join(sourceDir, "unread.txt")
				// All writers are completely closed before the first source handle or
				// baseline query. No SDK Capture, reads or metadata repair follow.
				if err := os.WriteFile(path, []byte("metadata-only source fixture"), 0600); err != nil {
					t.Fatalf("metadata-control main writer win32=%d", win32Code(err))
				}
				if ads {
					if err := os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0600); err != nil {
						t.Fatalf("metadata-control ADS writer win32=%d", win32Code(err))
					}
				}
				name, err := windows.UTF16PtrFromString(path)
				if err != nil {
					t.Fatal("fixture path encoding")
				}
				access := uint32(windows.FILE_READ_ATTRIBUTES | windows.READ_CONTROL | windows.FILE_WRITE_ATTRIBUTES | windows.SYNCHRONIZE)
				share := uint32(windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE)
				if exclusive {
					share = 0
				}
				h, err := windows.CreateFile(name, access, share, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
				if err != nil {
					t.Fatalf("metadata-control exact ordinary open failed share=%d requested=0x%08x win32=%d; control NOT executed", share, access, win32Code(err))
				}
				defer func() {
					if err := windows.CloseHandle(h); err != nil {
						t.Errorf("metadata-control source handle close win32=%d", win32Code(err))
					}
				}()
				// The very first native observation, not a later warmed baseline.
				initial, err := inspectStableReadObject(h)
				if err != nil {
					t.Fatal("metadata-control first baseline", err)
				}
				granted, err := nativeGrantedAccess(h)
				if err != nil {
					t.Fatal(err)
				}
				forbidden := uint32(windows.FILE_READ_DATA | windows.FILE_READ_EA | windows.DELETE)
				if granted&access != access || granted&forbidden != 0 {
					t.Fatalf("metadata-only actual GrantedAccess mismatch requested=0x%08x actual=0x%08x", access, granted)
				}
				t.Logf("metadata-control fresh ads=%t share=%d actualGranted=0x%08x READ_DATA=false READ_EA=false DELETE=false sourceWritersClosed=true CaptureCalls=0 RestoreCalls=0", ads, share, granted)
				privileges := nativeTokenPrivileges(t)
				trace := &restoreCausalTrace{t: t, target: h, started: time.Now(), expected: &initial, last: &initial}
				oldObserver := backupSDKObserver
				backupSDKObserver = trace.sdk
				defer func() { backupSDKObserver = oldObserver }()
				trace.checkpoint("metadata-only-first-baseline-before-sentinel", true)
				if err := preserveReadAccess(h); err != nil {
					t.Fatalf("metadata-control sentinel failed win32=%d", win32Code(err))
				}
				afterSentinel, err := inspectStableReadObject(h)
				if err != nil || afterSentinel != initial {
					t.Fatal("metadata-control sentinel changed FIRST baseline; no replacement allowed")
				}
				trace.checkpoint("metadata-only-after-sentinel", true)
				ticker := time.NewTicker(20 * time.Millisecond)
				defer ticker.Stop()
				for i := 0; i < 10; i++ {
					select {
					case <-ticker.C:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					trace.checkpoint(fmt.Sprintf("metadata-only-%02d", i), i == 0 || i == 9)
				}
				siblingDir := filepath.Join(parent, "private-causal-io")
				if err := os.Mkdir(siblingDir, 0700); err != nil {
					t.Fatal("metadata-control private sibling directory create failed")
				}
				payload := bytes.Repeat([]byte{0x4e}, 4096)
				for i := 0; i < 64; i++ {
					select {
					case <-ticker.C:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					f, err := os.OpenFile(filepath.Join(siblingDir, fmt.Sprintf("record-%02d", i)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
					if err != nil {
						t.Fatalf("metadata-control sibling open win32=%d", win32Code(err))
					}
					for pass := 0; pass < 2; pass++ {
						trace.checkpoint(fmt.Sprintf("sibling-%02d-%d-before-write", i, pass), false)
						if n, err := f.Write(payload); err != nil || n != len(payload) {
							f.Close()
							t.Fatal("metadata-control sibling write failed")
						}
						trace.checkpoint(fmt.Sprintf("sibling-%02d-%d-after-write-before-fsync", i, pass), false)
						if err := f.Sync(); err != nil {
							f.Close()
							t.Fatal("metadata-control sibling fsync failed")
						}
						trace.checkpoint(fmt.Sprintf("sibling-%02d-%d-after-fsync", i, pass), false)
					}
					if err := f.Close(); err != nil {
						t.Fatal("metadata-control sibling close failed")
					}
					trace.checkpoint(fmt.Sprintf("sibling-%02d-after-close", i), i == 63)
				}
				trace.checkpoint("metadata-only-end-original-handle-still-live", true)
				trace.mu.Lock()
				first := trace.firstDrift
				queryErr := trace.queryErr
				events := trace.sdkEvents
				reads, writes, seeks, aborts := trace.readCalls, trace.writeCalls, trace.seekCalls, trace.abortCalls
				trace.mu.Unlock()
				unchangedPrivileges := bytes.Equal(privileges, nativeTokenPrivileges(t))
				t.Logf("metadata-control SUMMARY ads=%t share=%d CaptureCalls=0 RestoreCalls=0 sourceReadFileCalls=0 SDKpayload=0 backupEvents=%d backupRead=%d backupWrite=%d backupSeek=%d backupAbort=%d privateWrites=128 privateFsync=128 privateCloses=64 firstDrift=%q processPrivilegesUnchanged=%t", ads, share, events, reads, writes, seeks, aborts, first, unchangedPrivileges)
				if queryErr != nil {
					t.Fatal("metadata-control native observation failure", queryErr)
				}
				if events != 0 {
					t.Fatal("metadata-only control unexpectedly called a backup SDK primitive")
				}
				if !unchangedPrivileges {
					t.Fatal("metadata-only control changed process privileges")
				}
				if first != "" {
					t.Fatalf("metadata-only historical basic drift reproduced at %s with Capture=0/Restore=0/sourceDataRead=0; external/OS causes remain unproven candidates", first)
				}
			})
		}
	}
}
