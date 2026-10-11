//go:build windows

package windowsbackup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TEST ONLY. Endpoint canonical checks are NOT atomic namespace authorization:
// rename-out-and-back plus restored metadata remains unproved. No production
// Capture uses this bridge, and these tests cannot make any root/channel ready.
type ntPrototypeCanonical struct{ DOS, GUID string }
type ntPrototypeBinding struct {
	root          windows.Handle
	original      windows.Handle
	rootState     stableReadObjectState
	rootNames     ntPrototypeCanonical
	originalState stableReadObjectState
	originalNames ntPrototypeCanonical
}

func ntPrototypeCanonicalNames(handle windows.Handle) (ntPrototypeCanonical, error) {
	var result ntPrototypeCanonical
	for _, flags := range []uint32{0, 1} {
		var name [32768]uint16
		n, err := windows.GetFinalPathNameByHandle(handle, &name[0], uint32(len(name)), flags)
		if err != nil || n == 0 || n >= uint32(len(name)) {
			return result, fmt.Errorf("prototype actual canonical query flags=%d win32=%d length=%d", flags, win32Code(err), n)
		}
		value := windows.UTF16ToString(name[:n])
		if flags == 0 {
			result.DOS = value
		} else {
			result.GUID = value
		}
	}
	return result, nil
}

func ntPrototypeOrdinary(handle windows.Handle) error {
	if _, err := validateOrdinary(handle); err != nil {
		return err
	}
	var tags struct{ Attributes, ReparseTag uint32 }
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileAttributeTagInfo, (*byte)(unsafe.Pointer(&tags)), uint32(unsafe.Sizeof(tags))); err != nil {
		return fmt.Errorf("prototype tag query win32=%d", win32Code(err))
	}
	if tags.Attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || tags.ReparseTag != 0 {
		return fmt.Errorf("prototype nonreparse ordinary file required")
	}
	return nil
}

func newNTPrototypeBinding(root, original windows.Handle) (*ntPrototypeBinding, error) {
	rootState, err := inspectStableReadObject(root)
	if err != nil {
		return nil, err
	}
	rootNames, err := ntPrototypeCanonicalNames(root)
	if err != nil {
		return nil, err
	}
	originalState, err := inspectStableReadObject(original)
	if err != nil {
		return nil, err
	}
	originalNames, err := ntPrototypeCanonicalNames(original)
	if err != nil {
		return nil, err
	}
	b := &ntPrototypeBinding{root, original, rootState, rootNames, originalState, originalNames}
	if err := b.checkBase(); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *ntPrototypeBinding) checkBase() error {
	root, err := inspectStableReadObject(b.root)
	if err != nil {
		return err
	}
	names, err := ntPrototypeCanonicalNames(b.root)
	if err != nil {
		return err
	}
	if root.ID != b.rootState.ID || root.Basic.Creation != b.rootState.Basic.Creation || names != b.rootNames || root.Basic.Attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || root.Basic.Attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("prototype authenticated root changed")
	}
	original, err := inspectStableReadObject(b.original)
	if err != nil {
		return err
	}
	actual, err := ntPrototypeCanonicalNames(b.original)
	if err != nil {
		return err
	}
	if original != b.originalState || actual != b.originalNames || original.ID.Volume != root.ID.Volume || filepath.Dir(actual.DOS) != names.DOS || filepath.Dir(actual.GUID) != names.GUID {
		return fmt.Errorf("prototype original identity/basic/canonical parent changed")
	}
	return ntPrototypeOrdinary(b.original)
}

func (b *ntPrototypeBinding) checkSameObject(other windows.Handle) error {
	if err := b.checkBase(); err != nil {
		return err
	}
	if err := ntPrototypeOrdinary(other); err != nil {
		return err
	}
	state, err := inspectStableReadObject(other)
	if err != nil {
		return err
	}
	if state != b.originalState {
		return fmt.Errorf("prototype different physical object/basic metadata")
	}
	// Only the original live handle supplies CURRENT normalized 0/1 names.
	// This physical match does not use other-handle opened names as authority.
	return b.checkBase()
}

func ntPrototypeFixture(t *testing.T, ads ...[]byte) (*os.File, *os.File, string) {
	t.Helper()
	parent := t.TempDir()
	rootPath := filepath.Join(parent, "allowed-root")
	if err := os.Mkdir(rootPath, 0700); err != nil {
		t.Fatalf("fixture directory create win32=%d", win32Code(err))
	}
	// Finish ALL fixture writers before opening any DELETE-bearing root/base
	// handle. Go os.WriteFile on ADS does not share DELETE with a live base fd.
	// This is construction only: no pre-read, timestamp repair, or weakened fd.
	path := filepath.Join(rootPath, "original.txt")
	if err := os.WriteFile(path, []byte("same ordinary bytes"), 0600); err != nil {
		t.Fatalf("fixture file create win32=%d", win32Code(err))
	}
	if len(ads) > 1 {
		t.Fatal("fixture supports one explicit ADS")
	}
	if len(ads) == 1 {
		if err := os.WriteFile(path+":Zone.Identifier", ads[0], 0600); err != nil {
			t.Fatalf("fixture ADS create before DELETE handles win32=%d", win32Code(err))
		}
	}
	root, err := openOrdinary(rootPath, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.DELETE)
	if err != nil {
		t.Fatalf("fixture root open win32=%d", win32Code(err))
	}
	t.Cleanup(func() { root.Close() })
	file, err := OpenMutation(path)
	if err != nil {
		t.Fatalf("fixture file open win32=%d", win32Code(err))
	}
	t.Cleanup(func() { file.Close() })
	return root, file, path
}

// Fixture-only rename through an already ordinarily authorized DELETE handle.
// Keep every tested original handle alive; never reopen a source by its name.
func ntPrototypeRenameFixtureHandle(handle windows.Handle, destination string) error {
	wide, err := windows.UTF16FromString(destination)
	if err != nil {
		return fmt.Errorf("fixture destination UTF16 invalid")
	}
	wide = wide[:len(wide)-1]
	if len(wide) == 0 || len(wide) >= 32768 {
		return fmt.Errorf("fixture rename name budget")
	}
	type renameInfo struct {
		Replace uint32
		Root    windows.Handle
		Length  uint32
		Name    uint16
	}
	offset := int(unsafe.Offsetof(renameInfo{}.Name))
	buffer := make([]byte, offset+len(wide)*2)
	info := (*renameInfo)(unsafe.Pointer(&buffer[0]))
	info.Length = uint32(len(wide) * 2)
	copy(unsafe.Slice((*uint16)(unsafe.Pointer(&buffer[offset])), len(wide)), wide)
	return windows.SetFileInformationByHandle(handle, windows.FileRenameInfo, &buffer[0], uint32(len(buffer)))
}

func ntPrototypeReplaceFixtureRoot(t *testing.T, root, original, security windows.Handle, path string, binding *ntPrototypeBinding) {
	t.Helper()
	rootPath := filepath.Dir(path)
	parent := filepath.Dir(rootPath)
	movedRoot := filepath.Join(parent, "old-root")
	firstErr := ntPrototypeRenameFixtureHandle(root, movedRoot)
	t.Logf("fixture pinned root rename direct success=%t win32=%d", firstErr == nil, win32Code(firstErr))
	if firstErr != nil {
		// Some filesystems cannot move a directory with live children. Move the
		// SAME live file object outside first, not close/reopen or copy its bytes.
		if err := ntPrototypeRenameFixtureHandle(original, filepath.Join(parent, "retained-live-child.txt")); err != nil {
			t.Fatalf("fixture live-child pinned move failed win32=%d (root direct win32=%d)", win32Code(err), win32Code(firstErr))
		}
		t.Log("fixture staged same live child outside root; original/security handles retained")
		if err := ntPrototypeRenameFixtureHandle(root, movedRoot); err != nil {
			t.Fatalf("fixture empty-root pinned rename failed win32=%d (direct root win32=%d); attack NOT constructed", win32Code(err), win32Code(firstErr))
		}
	}
	if err := os.Mkdir(rootPath, 0700); err != nil {
		t.Fatalf("fixture replacement root create failed win32=%d; attack NOT constructed", win32Code(err))
	}
	// This new handle verifies the adversary's replacement only. It is NEVER
	// substituted for binding.root or either tested file handle.
	replacement, err := openOrdinary(rootPath, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
	if err != nil {
		t.Fatalf("fixture replacement root verification open win32=%d", win32Code(err))
	}
	defer replacement.Close()
	newRoot, newErr := inspectStableReadObject(windows.Handle(replacement.Fd()))
	oldRoot, oldErr := inspectStableReadObject(root)
	oldFile, fileErr := inspectStableReadObject(original)
	oldSecurity, securityErr := inspectStableReadObject(security)
	if newErr != nil || oldErr != nil || fileErr != nil || securityErr != nil {
		t.Fatalf("fixture live identities query failed newRoot=%d oldRoot=%d original=%d security=%d", win32Code(newErr), win32Code(oldErr), win32Code(fileErr), win32Code(securityErr))
	}
	if newRoot.ID == binding.rootState.ID || oldRoot.ID != binding.rootState.ID || oldRoot.Basic.Creation != binding.rootState.Basic.Creation || oldFile.ID != binding.originalState.ID || oldSecurity.ID != binding.originalState.ID || oldFile.Basic.Creation != binding.originalState.Basic.Creation || oldSecurity.Basic.Creation != binding.originalState.Basic.Creation {
		t.Fatal("fixture failed to replace root while preserving all tested live native identities")
	}
	actual, err := ntPrototypeCanonicalNames(windows.Handle(replacement.Fd()))
	if err != nil || actual != binding.rootNames {
		t.Fatal("replacement root did not occupy the original actual canonical slot")
	}
	t.Log("fixture attack constructed=true replacementRootIDChanged=true originalRootAndBothFileHandlesLive=true; no original handle replaced")
}

func TestNativeWindowsCanonicalBridgePrototype(t *testing.T) {
	requirePreparedScratch(t)
	for _, kind := range []string{"unchanged", "rename-same-id", "rename-basic-reset", "foreign-id", "replace-same-bytes", "hardlink", "reparse", "deny-hole-move", "outside-root-move", "root-replacement"} {
		t.Run(kind, func(t *testing.T) {
			root, file, path := ntPrototypeFixture(t)
			original := windows.Handle(file.Fd())
			binding, err := newNTPrototypeBinding(windows.Handle(root.Fd()), original)
			if err != nil {
				t.Fatal(err)
			}
			expected, err := inspectStableRead(original)
			if err != nil {
				t.Fatal(err)
			}
			var security windows.Handle
			defer func() {
				if security != 0 {
					if err := windows.CloseHandle(security); err != nil {
						t.Errorf("prototype close win32=%d", win32Code(err))
					}
				}
			}()
			if err := Privileged(context.Background(), []string{"SeSecurityPrivilege", "SeBackupPrivilege"}, func() error {
				var err error
				security, err = reopenStableRead(original, windows.GENERIC_READ|windows.READ_CONTROL|windows.ACCESS_SYSTEM_SECURITY, expected)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			candidate := security
			switch kind {
			case "rename-same-id", "rename-basic-reset":
				if err := os.Rename(path, filepath.Join(filepath.Dir(path), "renamed.txt")); err != nil {
					t.Fatalf("fixture rename win32=%d", win32Code(err))
				}
				if kind == "rename-basic-reset" {
					// Deliberate attacker countertest on scratch, NEVER read repair.
					basic := binding.originalState.Basic
					resetErr := windows.SetFileInformationByHandle(original, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic)))
					after, queryErr := inspectStableReadObject(original)
					t.Logf("attacker ordinary basic-reset succeeded=%t win32=%d allBasicRestored=%t; current renamed canonical must still reject", resetErr == nil, win32Code(resetErr), queryErr == nil && after.Basic == basic)
				}
				actual, err := inspectStableReadObject(original)
				if err != nil || actual.ID != binding.originalState.ID {
					t.Fatal("fixture did not retain original file ID")
				}
			case "foreign-id":
				otherPath := filepath.Join(filepath.Dir(path), "foreign.txt")
				if err := os.WriteFile(otherPath, []byte("same ordinary bytes"), 0600); err != nil {
					t.Fatal("foreign fixture create failed")
				}
				other, err := OpenMutation(otherPath)
				if err != nil {
					t.Fatal("foreign fixture open failed")
				}
				defer other.Close()
				candidate = windows.Handle(other.Fd())
			case "replace-same-bytes":
				if err := os.Rename(path, filepath.Join(filepath.Dir(path), "retained.txt")); err != nil {
					t.Fatal("replacement fixture rename failed")
				}
				if err := os.WriteFile(path, []byte("same ordinary bytes"), 0600); err != nil {
					t.Fatal("replacement fixture create failed")
				}
				fresh, err := OpenMutation(path)
				if err != nil {
					t.Fatal("replacement fixture open failed")
				}
				defer fresh.Close()
				candidate = windows.Handle(fresh.Fd())
			case "hardlink":
				if err := os.Link(path, filepath.Join(filepath.Dir(path), "alias.txt")); err != nil {
					t.Fatalf("hardlink fixture unavailable win32=%d", win32Code(err))
				}
			case "reparse":
				link := filepath.Join(filepath.Dir(path), "link.txt")
				if err := os.Symlink(path, link); err != nil {
					t.Fatalf("reparse fixture unavailable without privilege changes win32=%d", win32Code(err))
				}
				linked, err := openOrdinary(link, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
				if err != nil {
					t.Fatal("reparse fixture open failed")
				}
				defer linked.Close()
				candidate = windows.Handle(linked.Fd())
			case "deny-hole-move":
				denied := filepath.Join(filepath.Dir(path), "denied")
				if err := os.Mkdir(denied, 0700); err != nil {
					t.Fatal("deny-hole fixture create failed")
				}
				if err := os.Rename(path, filepath.Join(denied, "original.txt")); err != nil {
					t.Fatal("deny-hole fixture move failed")
				}
			case "outside-root-move":
				outside := filepath.Join(filepath.Dir(filepath.Dir(path)), "outside.txt")
				if err := os.Rename(path, outside); err != nil {
					t.Fatal("outside-root fixture move failed")
				}
			case "root-replacement":
				ntPrototypeReplaceFixtureRoot(t, windows.Handle(root.Fd()), original, security, path, binding)
			}
			checkErr := binding.checkSameObject(candidate)
			if kind == "unchanged" {
				if checkErr != nil {
					t.Fatal("same-object endpoint bridge refused", checkErr)
				}
			} else if checkErr == nil {
				t.Fatal("unauthorized endpoint bridge accepted")
			}
			t.Log("TEST-ONLY endpoint result; transient rename-out-and-back/metadata-ABA is NOT proved; productionReady=false")
		})
	}
}
