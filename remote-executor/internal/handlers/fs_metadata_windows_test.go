//go:build windows

package handlers

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsConditionalStreamInfoAlignmentAndADSRefusal(t *testing.T) {
	root := nativePathFixture(t)
	path := filepath.Join(root, "stream-alignment.txt")
	if err := os.WriteFile(path, []byte("ordinary single unnamed stream"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := openConditionalWindowsFile(path, windows.GENERIC_READ|windows.READ_CONTROL)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	aligned := newConditionalStreamInfoBuffer()
	if uintptr(unsafe.Pointer(&aligned[0]))%8 != 0 {
		t.Fatal("production query buffer is not aligned")
	}
	if err := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileStreamInfo, &aligned[0], uint32(len(aligned))); err != nil {
		t.Fatal("aligned native stream enumeration failed", err)
	}
	// Diagnostic only: some OS implementations may tolerate a misaligned buffer.
	// The production call always satisfies the documented ABI, without retrying
	// any denied/error query or dropping streams from the preservation contract.
	misaligned := newConditionalStreamInfoBuffer()[1:]
	misalignedErr := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileStreamInfo, &misaligned[0], uint32(len(misaligned)))
	t.Logf("native stream query aligned=success misalignedAlignment=%d misalignedError=%v", uintptr(unsafe.Pointer(&misaligned[0]))%8, misalignedErr)
	if err := validateWindowsConditionalFile(file); err != nil {
		t.Fatal("ordinary stream matrix rejected", err)
	}
	if err := os.WriteFile(path+":hidden", []byte("must not be silently lost"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateWindowsConditionalFile(file); err == nil || !strings.Contains(err.Error(), "does not support alternate data streams") {
		t.Fatal("ADS was not rejected by the parsed stream matrix", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "ordinary single unnamed stream" {
		t.Fatal("stream preflight mutated content", err)
	}
}

func TestWindowsDACLStatesAndACEOrder(t *testing.T) {
	type fingerprint struct {
		control windows.SECURITY_DESCRIPTOR_CONTROL
		acl     []byte
	}
	states := make([]fingerprint, 0, 3)
	for _, sddl := range []string{"O:WD", "D:NO_ACCESS_CONTROL", "D:"} {
		sd, err := windows.SecurityDescriptorFromString(sddl)
		if err != nil {
			t.Fatal(err)
		}
		acl, err := descriptorACL(sd, false)
		if err != nil {
			t.Fatal(err)
		}
		control, _, err := sd.Control()
		if err != nil {
			t.Fatal(err)
		}
		states = append(states, fingerprint{control & daclControlMask, acl})
	}
	for i := range states {
		for j := i + 1; j < len(states); j++ {
			if states[i].control == states[j].control && bytes.Equal(states[i].acl, states[j].acl) {
				t.Fatalf("DACL states %d/%d collapsed", i, j)
			}
		}
	}
	a, err := windows.SecurityDescriptorFromString("D:(A;;FR;;;WD)(A;;FW;;;AU)")
	if err != nil {
		t.Fatal(err)
	}
	b, err := windows.SecurityDescriptorFromString("D:(A;;FW;;;AU)(A;;FR;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	aa, err := descriptorACL(a, false)
	if err != nil {
		t.Fatal(err)
	}
	bb, err := descriptorACL(b, false)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(aa, bb) {
		t.Fatal("ACE ordering silently canonicalized")
	}
}

func TestWindowsConditionalRejectsSpecialTargets(t *testing.T) {
	for _, kind := range []string{"hardlink", "ADS"} {
		t.Run(kind, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "target.txt")
			if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "hardlink" {
				if err := os.Link(target, target+".link"); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(target+":hidden", []byte("stream"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			f, err := os.Open(target)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if _, err := captureConditionalMetadata(f); err == nil {
				t.Fatalf("special target %s accepted", kind)
			}
			got, err := os.ReadFile(target)
			if err != nil || string(got) != "original" {
				t.Fatalf("original changed: %q %v", got, err)
			}
		})
	}
}

func TestWindowsConditionalPreparationDoesNotInstallDACL(t *testing.T) {
	target := filepath.Join(t.TempDir(), "target.txt")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	testSetWindowsDACL(t, target, "D:P(A;;FA;;;"+testWindowsUserSID(t)+")(A;;FR;;;WD)", true)
	source, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	metadata, err := captureConditionalMetadata(source)
	if err != nil {
		t.Fatal(err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".nf-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer tmp.Close()
	defer os.Remove(tmp.Name())
	before, err := captureWindowsMetadata(tmp, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := metadata.apply(tmp); err != nil {
		t.Fatal(err)
	}
	after, err := captureWindowsMetadata(tmp, false)
	if err != nil {
		t.Fatal(err)
	}
	if before.control&daclControlMask != after.control&daclControlMask || !bytes.Equal(before.dacl, after.dacl) {
		t.Fatal("preparation altered temporary DACL")
	}
	if err := metadata.matches(source); err != nil {
		t.Fatal(err)
	}
}
