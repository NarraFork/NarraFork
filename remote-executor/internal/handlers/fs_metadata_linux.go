//go:build linux

package handlers

import (
	"bytes"
	"fmt"
	"os"
	"reflect"
	"strings"

	"golang.org/x/sys/unix"
)

const maxConditionalMetadataBytes = 256 * 1024

// Linux POSIX ACLs are system.posix_acl_access xattrs. Copy all visible xattrs,
// including ACLs, and reject any unreadable/unwritable attribute. Content-bound
// integrity/capability attributes cannot safely be attached to different bytes.
type linuxConditionalMetadata struct {
	UID, GID uint32
	Mode     os.FileMode
	Attrs    map[string][]byte
}

func captureConditionalMetadata(f *os.File) (conditionalMetadata, error) {
	fd := int(f.Fd())
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	if stat.Nlink != 1 {
		return nil, fmt.Errorf("conditional replacement cannot preserve hard links")
	}
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return nil, fmt.Errorf("conditional replacement refuses special permission bits")
	}
	// Preserve semantics rather than dropping immutable/append/project flags.
	// EXTENTS is an allocation detail, not a user-visible permission/ACL flag.
	flags, err := unix.IoctlGetInt(fd, unix.FS_IOC_GETFLAGS)
	if err != nil {
		return nil, fmt.Errorf("cannot verify inode flags: %w", err)
	}
	if flags & ^0x80000 != 0 {
		return nil, fmt.Errorf("conditional replacement refuses unsupported inode flags %#x", flags)
	}
	attrs, err := conditionalXattrs(fd)
	if err != nil {
		return nil, err
	}
	return &linuxConditionalMetadata{UID: stat.Uid, GID: stat.Gid, Mode: info.Mode().Perm(), Attrs: attrs}, nil
}

func conditionalXattrs(fd int) (map[string][]byte, error) {
	// Fixed buffers bound both kernel output and Go allocations; ERANGE rejects
	// large metadata instead of retrying/growing without a budget.
	buf := make([]byte, 64*1024)
	n, err := unix.Flistxattr(fd, buf)
	if err != nil {
		return nil, fmt.Errorf("cannot enumerate file metadata: %w", err)
	}
	attrs := make(map[string][]byte)
	total := n
	for _, name := range strings.Split(string(buf[:n]), "\x00") {
		if name == "" {
			continue
		}
		if strings.HasPrefix(name, "security.") && name != "security.selinux" {
			return nil, fmt.Errorf("conditional replacement refuses content-bound security metadata %q", name)
		}
		n, err := unix.Fgetxattr(fd, name, buf)
		if err != nil {
			return nil, fmt.Errorf("cannot read metadata %q: %w", name, err)
		}
		total += n
		if total > maxConditionalMetadataBytes || len(attrs) >= 256 {
			return nil, fmt.Errorf("file metadata exceeds conditional write budget")
		}
		attrs[name] = bytes.Clone(buf[:n])
	}
	return attrs, nil
}

func (m *linuxConditionalMetadata) apply(f *os.File) error {
	fd := int(f.Fd())
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Uid != m.UID || stat.Gid != m.GID {
		if err := f.Chown(int(m.UID), int(m.GID)); err != nil {
			return fmt.Errorf("cannot preserve file owner/group: %w", err)
		}
	}
	if err := f.Chmod(m.Mode); err != nil {
		return err
	}
	inherited, err := conditionalXattrs(fd)
	if err != nil {
		return err
	}
	for name := range inherited {
		if _, exists := m.Attrs[name]; !exists {
			if err := unix.Fremovexattr(fd, name); err != nil {
				return fmt.Errorf("cannot remove inherited metadata %q: %w", name, err)
			}
		}
	}
	for name, value := range m.Attrs {
		if err := unix.Fsetxattr(fd, name, value, 0); err != nil {
			return fmt.Errorf("cannot preserve metadata %q: %w", name, err)
		}
	}
	return m.matches(f)
}

func (m *linuxConditionalMetadata) matches(f *os.File) error {
	current, err := captureConditionalMetadata(f)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(m, current) {
		return errConditionalMetadataChanged
	}
	return nil
}
