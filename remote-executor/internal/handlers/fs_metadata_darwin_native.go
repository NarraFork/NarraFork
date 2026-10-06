//go:build darwin

package handlers

import (
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

const darwinMaxACLBytes = 64 * 1024

// Opaque libc handles: never map Apple's private ACL/filesec structures. Native
// memory is copied before release and no native pointer escapes a locked call.
type darwinACLNative struct {
	getFD       func(int32) uintptr
	size        func(uintptr) int64
	copyExt     func(unsafe.Pointer, uintptr, int64) int64
	copyInt     func(unsafe.Pointer) uintptr
	setFD       func(int32, uintptr) int32
	free        func(uintptr) int32
	filesecInit func() uintptr
	filesecSet  func(uintptr, int32, uintptr) int32
	filesecFree func(uintptr)
	chmodx      func(int32, uintptr) int32
	errno       func() *int32
}

var darwinACLLoader struct {
	sync.Once
	api *darwinACLNative
	err error
}

func loadDarwinACL() (*darwinACLNative, error) {
	darwinACLLoader.Do(func() {
		// Symbol registration can panic. Turn missing APIs into a per-target
		// failure rather than crashing process startup or silently losing ACLs.
		defer func() {
			if p := recover(); p != nil {
				darwinACLLoader.api = nil
				darwinACLLoader.err = fmt.Errorf("macOS ACL bindings unavailable: %v", p)
			}
		}()
		handle, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			darwinACLLoader.err = fmt.Errorf("cannot load macOS ACL library: %w", err)
			return
		}
		// Keep this handle alive for the process lifetime, as registered functions
		// retain code addresses. Close it only if binding fails.
		bound := false
		defer func() {
			if !bound {
				_ = purego.Dlclose(handle)
			}
		}()
		api := &darwinACLNative{}
		for _, binding := range []struct {
			fn   any
			name string
		}{
			{&api.getFD, "acl_get_fd"}, {&api.size, "acl_size"},
			{&api.copyExt, "acl_copy_ext"}, {&api.copyInt, "acl_copy_int"},
			{&api.setFD, "acl_set_fd"}, {&api.free, "acl_free"},
			{&api.filesecInit, "filesec_init"}, {&api.filesecSet, "filesec_set_property"},
			{&api.filesecFree, "filesec_free"}, {&api.chmodx, "fchmodx_np"},
			{&api.errno, "__error"},
		} {
			purego.RegisterLibFunc(binding.fn, handle, binding.name)
		}
		bound = true
		darwinACLLoader.api = api
	})
	return darwinACLLoader.api, darwinACLLoader.err
}

func darwinNativeError(operation string, errno *int32) error {
	e := unix.Errno(*errno)
	if e == 0 {
		e = unix.EIO
	}
	return fmt.Errorf("%s: %w", operation, e)
}

// nil means absent ACL; non-nil external bytes mean a present (possibly empty)
// ACL. Only ENOENT from acl_get_fd means absent, never ENOTSUP or EACCES.
func (a *darwinACLNative) read(fd int) (data []byte, err error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	errno := a.errno()
	*errno = 0
	acl := a.getFD(int32(fd))
	if acl == 0 {
		if unix.Errno(*errno) == unix.ENOENT {
			return nil, nil
		}
		return nil, darwinNativeError("acl_get_fd", errno)
	}
	defer func() {
		*errno = 0
		if a.free(acl) != 0 && err == nil {
			data = nil
			err = darwinNativeError("acl_free", errno)
		}
	}()
	*errno = 0
	n := a.size(acl)
	if n < 0 {
		return nil, darwinNativeError("acl_size", errno)
	}
	if n == 0 || n > darwinMaxACLBytes {
		return nil, fmt.Errorf("macOS ACL exceeds conditional write budget or has invalid size: %d", n)
	}
	data = make([]byte, int(n))
	*errno = 0
	written := a.copyExt(unsafe.Pointer(&data[0]), acl, n)
	runtime.KeepAlive(data)
	if written < 0 {
		return nil, darwinNativeError("acl_copy_ext", errno)
	}
	if written != n {
		return nil, fmt.Errorf("acl_copy_ext returned inconsistent size: %d != %d", written, n)
	}
	return data, nil
}

func (a *darwinACLNative) write(fd int, data []byte) (err error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	errno := a.errno()
	if data == nil {
		*errno = 0
		sec := a.filesecInit()
		if sec == 0 {
			return darwinNativeError("filesec_init", errno)
		}
		defer a.filesecFree(sec)
		// FILESEC_ACL=5; FILESEC_REMOVE_ACL=(void*)1. Passing NULL would
		// leave the temporary file's inherited ACL untouched.
		*errno = 0
		if a.filesecSet(sec, 5, 1) != 0 {
			return darwinNativeError("filesec_set_property(remove ACL)", errno)
		}
		*errno = 0
		if a.chmodx(int32(fd), sec) != 0 {
			return darwinNativeError("fchmodx_np(remove ACL)", errno)
		}
		return nil
	}
	if len(data) == 0 || len(data) > darwinMaxACLBytes {
		return fmt.Errorf("invalid macOS ACL snapshot size")
	}
	*errno = 0
	acl := a.copyInt(unsafe.Pointer(&data[0]))
	runtime.KeepAlive(data)
	if acl == 0 {
		return darwinNativeError("acl_copy_int", errno)
	}
	defer func() {
		*errno = 0
		if a.free(acl) != 0 && err == nil {
			err = darwinNativeError("acl_free", errno)
		}
	}()
	*errno = 0
	if a.setFD(int32(fd), acl) != 0 {
		return darwinNativeError("acl_set_fd", errno)
	}
	return nil
}
