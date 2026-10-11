//go:build windows

package windowsbackup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type nativeInventory struct {
	MainSeen, EASeen bool
	MainSize, EASize uint64
	Streams          []nativeStreamRecord
}
type nativeInventoryReader struct {
	handle        windows.Handle
	state         uintptr
	metadataBytes int
}

func (r *nativeInventoryReader) read(ctx context.Context, dst []byte) error {
	for offset := 0; offset < len(dst); {
		if err := ctx.Err(); err != nil {
			return err
		}
		var n uint32
		ok, _, callErr := backupRead.Call(uintptr(r.handle), uintptr(unsafe.Pointer(&dst[offset])), uintptr(len(dst)-offset), uintptr(unsafe.Pointer(&n)), 0, 0, uintptr(unsafe.Pointer(&r.state)))
		if err := ctx.Err(); err != nil {
			return err
		}
		if n > uint32(len(dst)-offset) {
			return fmt.Errorf("native inventory metadata length")
		}
		offset += int(n)
		r.metadataBytes += int(n)
		if r.metadataBytes > MetadataBytes+20*(StreamCount+8) {
			return fmt.Errorf("native inventory metadata budget")
		}
		if ok == 0 {
			return fmt.Errorf("native inventory BackupRead: %w", callErr)
		}
		if n == 0 {
			if offset == 0 {
				return io.EOF
			}
			return io.ErrUnexpectedEOF
		}
	}
	return nil
}
func (r *nativeInventoryReader) skip(ctx context.Context, size uint64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if size == 0 {
		return nil
	}
	var lo, hi uint32
	ok, _, callErr := backupSeek.Call(uintptr(r.handle), uintptr(uint32(size)), uintptr(uint32(size>>32)), uintptr(unsafe.Pointer(&lo)), uintptr(unsafe.Pointer(&hi)), uintptr(unsafe.Pointer(&r.state)))
	if ok == 0 {
		return fmt.Errorf("native inventory BackupSeek: %w", callErr)
	}
	if uint64(hi)<<32|uint64(lo) != size {
		return fmt.Errorf("native inventory partial payload seek")
	}
	return ctx.Err()
}
func (r *nativeInventoryReader) abort() error {
	if r.state == 0 {
		return nil
	}
	var n uint32
	ok, _, callErr := backupRead.Call(uintptr(r.handle), 0, 0, uintptr(unsafe.Pointer(&n)), 1, 0, uintptr(unsafe.Pointer(&r.state)))
	if ok == 0 {
		return fmt.Errorf("native inventory abort: %w", callErr)
	}
	r.state = 0
	if n != 0 {
		return fmt.Errorf("native inventory abort delivered bytes")
	}
	return nil
}

// Headers/names only: every payload is skipped, never read under the elevated
// security scope. This preserves the old unknown-record refusal independently
// of the bounded NT readers, which cannot enumerate all backup record classes.
func readNativeInventory(ctx context.Context, original, security windows.Handle, expected stableReadObjectState, mainSize int64) (inventory nativeInventory, resultErr error) {
	r := nativeInventoryReader{handle: security}
	check := func() error {
		if err := verifyStablePhysical(original, expected, ctx); err != nil {
			return err
		}
		return verifyStablePhysical(security, expected, ctx)
	}
	defer func() {
		resultErr = errors.Join(resultErr, r.abort(), check(), ctx.Err())
		if resultErr != nil {
			inventory = nativeInventory{}
		}
	}()
	if mainSize < 0 {
		return inventory, fmt.Errorf("native inventory main size")
	}
	if err := check(); err != nil {
		return inventory, err
	}
	var total uint64
	for count := 0; count < StreamCount+8; count++ {
		var raw [20]byte
		err := r.read(ctx, raw[:])
		if err == io.EOF {
			if mainSize > 0 && !inventory.MainSeen {
				return inventory, fmt.Errorf("native inventory missing main")
			}
			sort.Slice(inventory.Streams, func(i, j int) bool { return inventory.Streams[i].Name < inventory.Streams[j].Name })
			return inventory, nil
		}
		if err != nil {
			return inventory, err
		}
		header, err := parseNativeBackupHeader(raw[:])
		if err != nil {
			return inventory, err
		}
		if err := check(); err != nil {
			return inventory, err
		}
		name := make([]byte, header.NameBytes)
		if len(name) > 0 {
			if err := r.read(ctx, name); err != nil {
				return inventory, err
			}
		}
		switch header.ID {
		case 1:
			if inventory.MainSeen || header.Size != uint64(mainSize) {
				return inventory, fmt.Errorf("native inventory main mismatch")
			}
			inventory.MainSeen = true
			inventory.MainSize = header.Size
		case 2:
			if inventory.EASeen || header.Size == 0 {
				return inventory, fmt.Errorf("native inventory duplicate/empty EA record")
			}
			inventory.EASeen = true
			inventory.EASize = header.Size
		case 4:
			streamName, err := nativeUTF16Name(name)
			if err != nil {
				return inventory, err
			}
			if !nativeStreamName(streamName) {
				return inventory, fmt.Errorf("native inventory stream name")
			}
			if len(inventory.Streams) >= StreamCount || header.Size > StreamBytes-total {
				return inventory, fmt.Errorf("native inventory stream budget")
			}
			for _, stream := range inventory.Streams {
				if strings.EqualFold(stream.Name, streamName) {
					return inventory, fmt.Errorf("native inventory duplicate stream")
				}
			}
			inventory.Streams = append(inventory.Streams, nativeStreamRecord{streamName, int64(header.Size)})
			total += header.Size
		}
		if err := check(); err != nil {
			return inventory, err
		}
		if err := r.skip(ctx, header.Size); err != nil {
			return inventory, err
		}
		if err := check(); err != nil {
			return inventory, err
		}
	}
	return inventory, fmt.Errorf("native inventory record count budget")
}
