//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

func queryNativeEAPage(ctx context.Context, original windows.Handle, size int, restart bool) (uint32, []byte, error) {
	if err := ctx.Err(); err != nil {
		return 0, nil, err
	}
	if size < 16 || size > EABytes {
		return 0, nil, fmt.Errorf("native EA page budget")
	}
	if err := nativeQueryEA.Find(); err != nil {
		return 0, nil, err
	}
	buffer := make([]byte, size)
	var io nativeIOStatus
	var first uintptr
	if restart {
		first = 1
	}
	status, _, _ := nativeQueryEA.Call(uintptr(original), uintptr(unsafe.Pointer(&io)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(size), 0, 0, 0, 0, first)
	runtime.KeepAlive(buffer)
	code := uint32(status)
	if io.Information > uintptr(size) || code == 0 && uint32(io.Status) != 0 {
		return code, nil, fmt.Errorf("native EA query completion/length")
	}
	if err := ctx.Err(); err != nil {
		return code, nil, err
	}
	return code, bytes.Clone(buffer[:int(io.Information)]), nil
}
func nativeEASize(ctx context.Context, original windows.Handle) (uint32, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := nativeQueryFile.Find(); err != nil {
		return 0, err
	}
	var size uint32
	var io nativeIOStatus
	status, _, _ := nativeQueryFile.Call(uintptr(original), uintptr(unsafe.Pointer(&io)), uintptr(unsafe.Pointer(&size)), unsafe.Sizeof(size), 7)
	if uint32(status) != 0 {
		return 0, nativeStatusError("native FileEaInformation", status)
	}
	if uint32(io.Status) != 0 || io.Information != unsafe.Sizeof(size) {
		return 0, fmt.Errorf("native EA size reply incomplete")
	}
	return size, ctx.Err()
}

// Read in the entry caller's context, not the isolated backup/security worker.
// Return only the original full NT buffer whose raw representation was checked
// against BACKUP_EA_DATA, never a guessed re-encoding of paged records.
func readNativeEA(ctx context.Context, original windows.Handle, expected stableReadState) ([]byte, error) {
	granted, err := nativeGrantedAccess(original, ctx)
	if err != nil {
		return nil, err
	}
	if granted&windows.FILE_READ_EA == 0 {
		return nil, fmt.Errorf("ordinary READ_EA required: %w", windows.ERROR_ACCESS_DENIED)
	}
	pageSize := 4096
	for {
		var entries []nativeEARecord
		seen := map[string]bool{}
		encodedSize := 0
		grow := false
		for step := 0; step <= nativeEAMaxEntries; step++ {
			if err := verifyStableOriginal(original, expected, ctx); err != nil {
				return nil, err
			}
			status, raw, err := queryNativeEAPage(ctx, original, pageSize, step == 0)
			if err != nil {
				return nil, err
			}
			if err := verifyStableOriginal(original, expected, ctx); err != nil {
				return nil, err
			}
			outcome, err := nativeEAReply(status, len(raw), len(entries) > 0)
			if err != nil {
				return nil, err
			}
			switch outcome {
			case "grow":
				if pageSize == EABytes {
					return nil, fmt.Errorf("native EA cannot fit 64KiB")
				}
				pageSize *= 2
				if pageSize > EABytes {
					pageSize = EABytes
				}
				grow = true
			case "absent":
				size, err := nativeEASize(ctx, original)
				if err != nil {
					return nil, err
				}
				if size != 0 {
					return nil, fmt.Errorf("native EA absence contradicts size")
				}
				if err := verifyStableOriginal(original, expected, ctx); err != nil {
					return nil, err
				}
				return nil, nil
			case "done":
				status, fullRaw, err := queryNativeEAPage(ctx, original, EABytes, true)
				if err != nil {
					return nil, err
				}
				if status != nativeStatusSuccess {
					return nil, fmt.Errorf("native full EA cross-check incomplete NTSTATUS=0x%08x", status)
				}
				full, err := parseNativeEA(fullRaw)
				if err != nil {
					return nil, err
				}
				if !nativeEAEqual(entries, full) {
					return nil, fmt.Errorf("native EA paging/full mismatch")
				}
				if err := verifyStableOriginal(original, expected, ctx); err != nil {
					return nil, err
				}
				return fullRaw, nil
			case "page":
				page, err := parseNativeEA(raw)
				if err != nil {
					return nil, err
				}
				for _, entry := range page {
					key := nativeEANameKey(entry.Name)
					if seen[key] {
						return nil, fmt.Errorf("native EA duplicate across pages")
					}
					seen[key] = true
					encodedSize = (encodedSize + 3) &^ 3
					encodedSize += 8 + len(entry.Name) + 1 + len(entry.Value)
					if encodedSize > EABytes || len(entries) >= nativeEAMaxEntries {
						return nil, fmt.Errorf("native aggregate EA budget")
					}
					entries = append(entries, entry)
				}
			}
			if grow {
				break
			}
		}
		if !grow {
			return nil, fmt.Errorf("native EA completion not proved")
		}
	}
}
