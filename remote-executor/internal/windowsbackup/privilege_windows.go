//go:build windows

package windowsbackup

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	adjustPrivileges = windows.NewLazySystemDLL("advapi32.dll").NewProc("AdjustTokenPrivileges")
	reOpenFile       = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReOpenFile")
	metadataQueue    = make(chan struct{}, QueueSize)
	metadataWorkers  = make(chan struct{}, Workers)
)

// Privileged creates an isolated OS thread, duplicates the caller's legitimate
// effective token and enables only the exact requested privileges. It never
// modifies the process token. The caller waits for native completion, including
// after cancellation: cancellation is not proof that a native operation stopped.
func Privileged(ctx context.Context, privileges []string, fn func() error) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	select {
	case metadataQueue <- struct{}{}:
	default:
		return fmt.Errorf("metadata queue full")
	}
	defer func() { <-metadataQueue }()
	select {
	case metadataWorkers <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-metadataWorkers }()
	if err := ctx.Err(); err != nil {
		return err
	}
	var source windows.Token
	if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, true, &source); err != nil {
		if !errors.Is(err, windows.ERROR_NO_TOKEN) {
			return err
		}
		if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &source); err != nil {
			return err
		}
	}
	defer source.Close()
	var isolated windows.Token
	if err := windows.DuplicateTokenEx(source, windows.TOKEN_QUERY|windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_IMPERSONATE, nil, windows.SecurityImpersonation, windows.TokenImpersonation, &isolated); err != nil {
		return err
	}
	defer isolated.Close()
	// Even inherited enabled privileges are disabled on this isolated token.
	if ok, _, e := adjustPrivileges.Call(uintptr(isolated), 1, 0, 0, 0, 0); ok == 0 {
		return e
	}
	// Fixed maximum: a privilege scope is not a general token editing interface.
	if len(privileges) > 3 {
		return fmt.Errorf("privilege budget")
	}
	for _, name := range privileges {
		switch name {
		case "SeSecurityPrivilege", "SeBackupPrivilege", "SeRestorePrivilege":
		default:
			return fmt.Errorf("unapproved privilege")
		}
		wide, err := windows.UTF16PtrFromString(name)
		if err != nil {
			return err
		}
		var luid windows.LUID
		if err := windows.LookupPrivilegeValue(nil, wide, &luid); err != nil {
			return err
		}
		state := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}}}
		ok, _, e := adjustPrivileges.Call(uintptr(isolated), 0, uintptr(unsafe.Pointer(&state)), 0, 0, 0)
		// The Win32 wrapper only checks BOOL; TRUE + NOT_ALL_ASSIGNED is failure.
		if ok == 0 || errors.Is(e, windows.ERROR_NOT_ALL_ASSIGNED) {
			return fmt.Errorf("%w: %s: %v", ErrHelperRequired, name, e)
		}
	}
	done := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		// Do NOT UnlockOSThread. Go destroys this dedicated thread on exit even if
		// reverting impersonation failed; it can never re-enter the public pool.
		if err := windows.SetThreadToken(nil, isolated); err != nil {
			done <- err
			return
		}
		result := func() (err error) {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("native metadata panic")
				}
			}()
			if err := ctx.Err(); err != nil {
				return err
			}
			return fn()
		}()
		if err := windows.RevertToSelf(); err != nil {
			result = errors.Join(result, fmt.Errorf("revert isolated metadata worker: %w", err))
		}
		done <- result
	}()
	return <-done
}

// Reopen acquires rights on the already ordinarily authorized native object.
// A pathname is never reopened to reclaim it under backup privilege.
func Reopen(original windows.Handle, access uint32) (windows.Handle, error) {
	h, _, err := reOpenFile.Call(uintptr(original), uintptr(access), uintptr(windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE), uintptr(windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT))
	if windows.Handle(h) == windows.InvalidHandle {
		return 0, err
	}
	return windows.Handle(h), nil
}
