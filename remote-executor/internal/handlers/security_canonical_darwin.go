//go:build darwin

package handlers

import (
	"bytes"
	"fmt"
	"path/filepath"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

// EvalSymlinks alone preserves caller casing on case-insensitive APFS/HFS+.
// Resolve through the opened vnode instead, as Apple's descriptor realpath_np /
// better-realpath does with F_GETPATH. The kernel supplies filesystem spelling;
// there is deliberately no global case folding (APFS can be case-sensitive).
func canonicalGuardPath(path string) (string, error) {
	// Event-only opens do not read contents or block on a FIFO/device's data.
	fd, err := unix.Open(path, unix.O_EVTONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	defer unix.Close(fd)
	buffer := new([unix.PathMax]byte)
	// FcntlInt's third argument is integer-typed. Pin this buffer while its
	// pointer crosses that wrapper, rather than relying on a movable Go stack.
	var pin runtime.Pinner
	pin.Pin(buffer)
	defer pin.Unpin()
	_, err = unix.FcntlInt(uintptr(fd), unix.F_GETPATH, int(uintptr(unsafe.Pointer(&buffer[0]))))
	runtime.KeepAlive(buffer)
	if err != nil {
		return "", err
	}
	end := bytes.IndexByte(buffer[:], 0)
	if end <= 0 {
		return "", fmt.Errorf("Darwin canonical path exceeds native path budget")
	}
	canonical := filepath.Clean(string(buffer[:end]))
	if !filepath.IsAbs(canonical) {
		return "", fmt.Errorf("Darwin canonical path is not absolute")
	}
	// F_GETPATH is handle-bound; also reject a stale namespace after a rename.
	var opened, current unix.Stat_t
	if err = unix.Fstat(fd, &opened); err != nil {
		return "", err
	}
	if err = unix.Stat(canonical, &current); err != nil {
		return "", err
	}
	if opened.Dev != current.Dev || opened.Ino != current.Ino {
		return "", fmt.Errorf("Darwin canonical path identity changed")
	}
	return canonical, nil
}
