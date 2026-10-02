//go:build darwin

package handlers

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"

	"golang.org/x/sys/unix"
)

const darwinMaxMetadataBytes = 256 * 1024

type darwinMetadataSnapshot struct {
	UID, GID uint32
	Mode     uint16
	Attrs    map[string][]byte
	ACL      []byte
}

type darwinConditionalMetadata struct {
	ctx      context.Context
	snapshot darwinMetadataSnapshot
	source   unix.Stat_t
}

func captureConditionalMetadata(f *os.File, contexts ...context.Context) (conditionalMetadata, error) {
	return darwinCaptureMetadata(conditionalMetadataContext(contexts), f)
}

func darwinCaptureMetadata(ctx context.Context, f *os.File) (conditionalMetadata, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	api, err := loadDarwinACL()
	if err != nil {
		return nil, err
	}
	first, source, err := darwinCaptureOnce(ctx, f, api)
	if err != nil {
		return nil, err
	}
	second, after, err := darwinCaptureOnce(ctx, f, api)
	if err != nil {
		return nil, err
	}
	if !darwinSameSource(source, after) || !reflect.DeepEqual(first, second) {
		return nil, errConditionalMetadataChanged
	}
	return &darwinConditionalMetadata{ctx: ctx, snapshot: first, source: source}, nil
}

func darwinSameSource(a, b unix.Stat_t) bool {
	// Reading can change atime; inode identity, size, mtime and ctime must stay
	// stable. A replacement inode deliberately has different times/identity.
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size &&
		a.Mtim == b.Mtim && a.Ctim == b.Ctim && a.Uid == b.Uid &&
		a.Gid == b.Gid && a.Mode == b.Mode && a.Nlink == b.Nlink && a.Flags == b.Flags
}

func darwinValidateFile(fd int, stat *unix.Stat_t) error {
	if err := unix.Fstat(fd, stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 {
		return fmt.Errorf("conditional replacement requires a regular file without hard links")
	}
	if stat.Mode&07000 != 0 || stat.Flags != 0 {
		return fmt.Errorf("conditional replacement refuses special permission bits or macOS file flags")
	}
	var fs unix.Statfs_t
	if err := unix.Fstatfs(fd, &fs); err != nil {
		return fmt.Errorf("cannot verify macOS filesystem: %w", err)
	}
	var fsname []byte
	for _, c := range fs.Fstypename {
		if c == 0 {
			break
		}
		fsname = append(fsname, byte(c))
	}
	if string(fsname) != "apfs" && string(fsname) != "hfs" {
		return fmt.Errorf("conditional replacement does not support macOS filesystem %q", fsname)
	}
	return nil
}

func darwinCaptureOnce(ctx context.Context, f *os.File, api *darwinACLNative) (darwinMetadataSnapshot, unix.Stat_t, error) {
	var snapshot darwinMetadataSnapshot
	var before, after unix.Stat_t
	if err := ctx.Err(); err != nil {
		return snapshot, before, err
	}
	fd := int(f.Fd())
	if err := darwinValidateFile(fd, &before); err != nil {
		return snapshot, before, err
	}
	acl, err := api.read(fd)
	if err != nil {
		return snapshot, before, err
	}
	if err := ctx.Err(); err != nil {
		return snapshot, before, err
	}
	attrs, err := darwinConditionalXattrs(ctx, fd, len(acl))
	if err != nil {
		return snapshot, before, err
	}
	if err := unix.Fstat(fd, &after); err != nil {
		return snapshot, before, err
	}
	if !darwinSameSource(before, after) {
		return snapshot, before, errConditionalMetadataChanged
	}
	snapshot = darwinMetadataSnapshot{UID: before.Uid, GID: before.Gid, Mode: before.Mode & 0777, ACL: acl, Attrs: attrs}
	return snapshot, before, ctx.Err()
}

func darwinConditionalXattrs(ctx context.Context, fd, aclBytes int) (map[string][]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Fixed buffers bound allocations and syscall output. ERANGE fails closed,
	// not an unbounded retry. Include names and ACL in the total budget.
	buf := make([]byte, 64*1024)
	n, err := unix.Flistxattr(fd, buf)
	if err != nil {
		return nil, fmt.Errorf("cannot enumerate macOS metadata: %w", err)
	}
	names := string(buf[:n])
	if n > 0 && buf[n-1] != 0 {
		return nil, fmt.Errorf("invalid macOS xattr name list")
	}
	attrs := make(map[string][]byte)
	total := n + aclBytes
	for _, name := range strings.Split(names, "\x00") {
		if name == "" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if name == "com.apple.ResourceFork" || name == "com.apple.decmpfs" {
			return nil, fmt.Errorf("conditional replacement refuses content-bound macOS metadata %q", name)
		}
		if len(attrs) >= 256 {
			return nil, fmt.Errorf("macOS metadata exceeds conditional write attribute budget")
		}
		n, err := unix.Fgetxattr(fd, name, buf)
		if err != nil {
			return nil, fmt.Errorf("cannot read macOS metadata %q: %w", name, err)
		}
		total += n
		if total > darwinMaxMetadataBytes {
			return nil, fmt.Errorf("macOS metadata exceeds conditional write byte budget")
		}
		attrs[name] = bytes.Clone(buf[:n])
	}
	return attrs, ctx.Err()
}

func (m *darwinConditionalMetadata) apply(f *os.File) error {
	if err := m.ctx.Err(); err != nil {
		return err
	}
	api, err := loadDarwinACL()
	if err != nil {
		return err
	}
	fd := int(f.Fd())
	var stat unix.Stat_t
	if err := darwinValidateFile(fd, &stat); err != nil {
		return err
	}
	if stat.Dev == m.source.Dev && stat.Ino == m.source.Ino {
		return fmt.Errorf("cannot apply replacement metadata to original inode")
	}
	if stat.Uid != m.snapshot.UID || stat.Gid != m.snapshot.GID {
		if err := f.Chown(int(m.snapshot.UID), int(m.snapshot.GID)); err != nil {
			return fmt.Errorf("cannot preserve macOS owner/group: %w", err)
		}
	}
	if err := m.ctx.Err(); err != nil {
		return err
	}
	if err := f.Chmod(os.FileMode(m.snapshot.Mode)); err != nil {
		return err
	}
	if err := m.ctx.Err(); err != nil {
		return err
	}
	if err := api.write(fd, m.snapshot.ACL); err != nil {
		return err
	}
	inherited, err := darwinConditionalXattrs(m.ctx, fd, len(m.snapshot.ACL))
	if err != nil {
		return err
	}
	for name := range inherited {
		if err := m.ctx.Err(); err != nil {
			return err
		}
		if _, exists := m.snapshot.Attrs[name]; !exists {
			if err := unix.Fremovexattr(fd, name); err != nil {
				return fmt.Errorf("cannot remove inherited macOS metadata %q: %w", name, err)
			}
		}
	}
	for name, value := range m.snapshot.Attrs {
		if err := m.ctx.Err(); err != nil {
			return err
		}
		if err := unix.Fsetxattr(fd, name, value, 0); err != nil {
			return fmt.Errorf("cannot preserve macOS metadata %q: %w", name, err)
		}
	}
	return m.matches(f)
}

func (m *darwinConditionalMetadata) matches(f *os.File) error {
	current, err := captureConditionalMetadata(f, m.ctx)
	if err != nil {
		return err
	}
	now := current.(*darwinConditionalMetadata)
	if !reflect.DeepEqual(m.snapshot, now.snapshot) {
		return errConditionalMetadataChanged
	}
	// Rechecking the source is stricter than checking the new target inode.
	if now.source.Dev == m.source.Dev && now.source.Ino == m.source.Ino && !darwinSameSource(m.source, now.source) {
		return errConditionalMetadataChanged
	}
	return nil
}
