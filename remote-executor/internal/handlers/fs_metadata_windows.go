//go:build windows

package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Audit SACL is deliberately optional: ACCESS_SYSTEM_SECURITY is not required
// for an ordinary edit. An unreadable audit SACL is UNKNOWN, never empty.
type windowsConditionalMetadata struct {
	sd, label, audit *windows.SECURITY_DESCRIPTOR
	owner, group     *windows.SID
	dacl, labelACL   []byte
	control          windows.SECURITY_DESCRIPTOR_CONTROL
	auditACL         []byte
	auditControl     windows.SECURITY_DESCRIPTOR_CONTROL
}

func aclBytes(acl *windows.ACL) []byte {
	if acl == nil {
		return nil
	}
	size := *(*uint16)(unsafe.Add(unsafe.Pointer(acl), 2))
	return bytes.Clone(unsafe.Slice((*byte)(unsafe.Pointer(acl)), int(size)))
}

func descriptorACL(sd *windows.SECURITY_DESCRIPTOR, sacl bool) ([]byte, error) {
	var acl *windows.ACL
	var err error
	if sacl {
		acl, _, err = sd.SACL()
	} else {
		acl, _, err = sd.DACL()
	}
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return aclBytes(acl), nil
}

const daclControlMask = windows.SE_DACL_PRESENT | windows.SE_DACL_PROTECTED | windows.SE_DACL_AUTO_INHERITED | windows.SE_DACL_AUTO_INHERIT_REQ | windows.SE_DACL_DEFAULTED
const saclControlMask = windows.SE_SACL_PRESENT | windows.SE_SACL_PROTECTED | windows.SE_SACL_AUTO_INHERITED | windows.SE_SACL_AUTO_INHERIT_REQ | windows.SE_SACL_DEFAULTED

func captureWindowsMetadata(f *os.File, readAudit bool) (*windowsConditionalMetadata, error) {
	h := windows.Handle(f.Fd())
	if err := validateWindowsConditionalFile(f); err != nil {
		return nil, err
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return nil, fmt.Errorf("read file access control: %w", err)
	}
	m := &windowsConditionalMetadata{sd: sd}
	if m.owner, _, err = sd.Owner(); err != nil {
		return nil, err
	}
	if m.group, _, err = sd.Group(); err != nil {
		return nil, err
	}
	if m.control, _, err = sd.Control(); err != nil {
		return nil, err
	}
	if m.dacl, err = descriptorACL(sd, false); err != nil {
		return nil, err
	}
	m.label, err = windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.LABEL_SECURITY_INFORMATION)
	if err != nil {
		return nil, fmt.Errorf("read mandatory label: %w", err)
	}
	if m.labelACL, err = descriptorACL(m.label, true); err != nil {
		return nil, err
	}
	// Central access policy/resource attributes are outside this contract.
	extra, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.ATTRIBUTE_SECURITY_INFORMATION|windows.SCOPE_SECURITY_INFORMATION)
	if err != nil {
		return nil, fmt.Errorf("check special access control: %w", err)
	}
	extraACL, err := descriptorACL(extra, true)
	if err != nil {
		return nil, err
	}
	if len(extraACL) > 8 {
		return nil, fmt.Errorf("conditional replacement does not support resource attributes or central access policies")
	}
	if readAudit {
		m.audit, err = windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.SACL_SECURITY_INFORMATION)
		if err != nil && !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
			return nil, err
		}
		if err == nil {
			if m.auditACL, err = descriptorACL(m.audit, true); err != nil {
				return nil, err
			}
			if m.auditControl, _, err = m.audit.Control(); err != nil {
				return nil, err
			}
		}
	}
	return m, nil
}

func captureConditionalMetadata(f *os.File, contexts ...context.Context) (conditionalMetadata, error) {
	ctx := conditionalMetadataContext(contexts)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	metadata, err := captureWindowsMetadata(f, true)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return metadata, nil
}

func (m *windowsConditionalMetadata) apply(f *os.File) error {
	current, err := captureWindowsMetadata(f, false)
	if err != nil {
		return err
	}
	mask := windows.SECURITY_INFORMATION(0)
	if !m.owner.Equals(current.owner) {
		mask |= windows.OWNER_SECURITY_INFORMATION
	}
	if !m.group.Equals(current.group) {
		mask |= windows.GROUP_SECURITY_INFORMATION
	}
	securityFile := f
	if mask != 0 || !bytes.Equal(m.labelACL, current.labelACL) {
		// Generic-write creation handles do not include WRITE_OWNER. Request it
		// only when owner/group/label actually need changing (ordinary users
		// commonly need no security write at all).
		securityFile, err = openConditionalWindowsFile(f.Name(), windows.WRITE_OWNER|windows.READ_CONTROL)
		if err != nil {
			return fmt.Errorf("open replacement for required security preparation: %w", err)
		}
		defer securityFile.Close()
		before, e := f.Stat()
		after, e2 := securityFile.Stat()
		if e != nil || e2 != nil || !os.SameFile(before, after) {
			return errConditionalMetadataChanged
		}
	}
	if mask != 0 {
		if err := windows.SetSecurityInfo(windows.Handle(securityFile.Fd()), windows.SE_FILE_OBJECT, mask, m.owner, m.group, nil, nil); err != nil {
			return fmt.Errorf("prepare replacement owner/group: %w", err)
		}
	}
	if !bytes.Equal(m.labelACL, current.labelACL) {
		acl, _, err := m.label.SACL()
		if err != nil && !errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
			return err
		}
		if err := windows.SetSecurityInfo(windows.Handle(securityFile.Fd()), windows.SE_FILE_OBJECT, windows.LABEL_SECURITY_INFORMATION, nil, nil, nil, acl); err != nil {
			return fmt.Errorf("prepare replacement mandatory label: %w", err)
		}
	}
	current, err = captureWindowsMetadata(f, false)
	if err != nil {
		return err
	}
	if !m.owner.Equals(current.owner) || !m.group.Equals(current.group) || !bytes.Equal(m.labelACL, current.labelACL) {
		return errConditionalMetadataChanged
	}
	// DACL is merged by ReplaceFileW, not installed on the preparation inode.
	return nil
}

func (m *windowsConditionalMetadata) matches(f *os.File) error {
	current, err := captureWindowsMetadata(f, m.audit != nil)
	if err != nil {
		return err
	}
	if !m.owner.Equals(current.owner) || !m.group.Equals(current.group) || m.control&daclControlMask != current.control&daclControlMask || !bytes.Equal(m.dacl, current.dacl) || (m.dacl == nil) != (current.dacl == nil) || !bytes.Equal(m.labelACL, current.labelACL) {
		return errConditionalMetadataChanged
	}
	if m.audit != nil && (current.audit == nil || !bytes.Equal(m.auditACL, current.auditACL) || m.auditControl&saclControlMask != current.auditControl&saclControlMask) {
		return errConditionalMetadataChanged
	}
	return nil
}

func validateWindowsConditionalFile(f *os.File) error {
	h := windows.Handle(f.Fd())
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return err
	}
	const unsupported = windows.FILE_ATTRIBUTE_DIRECTORY | windows.FILE_ATTRIBUTE_REPARSE_POINT | windows.FILE_ATTRIBUTE_ENCRYPTED | windows.FILE_ATTRIBUTE_OFFLINE | windows.FILE_ATTRIBUTE_SPARSE_FILE | windows.FILE_ATTRIBUTE_COMPRESSED
	if info.NumberOfLinks != 1 || info.FileAttributes&unsupported != 0 {
		return fmt.Errorf("conditional replacement requires an ordinary single-link file without EFS/reparse/sparse/compression")
	}
	var fs [32]uint16
	if err := windows.GetVolumeInformationByHandle(h, nil, 0, nil, nil, nil, &fs[0], uint32(len(fs))); err != nil {
		return err
	}
	if !strings.EqualFold(windows.UTF16ToString(fs[:]), "NTFS") {
		return fmt.Errorf("conditional replacement requires local NTFS")
	}
	var root [windows.MAX_PATH + 1]uint16
	path, err := windows.UTF16PtrFromString(f.Name())
	if err != nil {
		return err
	}
	if err := windows.GetVolumePathName(path, &root[0], uint32(len(root))); err != nil {
		return err
	}
	drive := windows.GetDriveType(&root[0])
	if drive != windows.DRIVE_FIXED && drive != windows.DRIVE_REMOVABLE {
		return fmt.Errorf("conditional replacement requires local NTFS")
	}
	// Fixed budget: refuse rather than allocate indefinitely for hostile streams.
	var streams [65536]byte
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStreamInfo, &streams[0], uint32(len(streams))); err != nil {
		return fmt.Errorf("enumerate file streams: %w", err)
	}
	next := *(*uint32)(unsafe.Pointer(&streams[0]))
	n := *(*uint32)(unsafe.Pointer(&streams[4]))
	if next != 0 || n != 14 || windows.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&streams[24])), int(n/2))) != "::$DATA" {
		return fmt.Errorf("conditional replacement does not support alternate data streams")
	}
	return nil
}
