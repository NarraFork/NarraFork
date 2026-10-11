//go:build windows

package windowsbackup

import (
	"context"
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

func nativeStreamListsEqual(a, b []nativeStreamRecord) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Called only in the entry caller context, after the elevated worker has joined.
// Each named-stream handle is acquired relative to the actual ordinary granted
// file handle with a subset of its granted rights, never by a client path.
func readNativeStream(ctx context.Context, original windows.Handle, expected stableReadState, stream nativeStreamRecord) (result Stream, resultErr error) {
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if stream.Size < 0 || stream.Size > StreamBytes {
		return result, fmt.Errorf("native stream byte budget")
	}
	if err := verifyStableOriginal(original, expected, ctx); err != nil {
		return result, err
	}
	h, err := openNativeStream(ctx, original, stream.Name)
	if err != nil {
		return result, err
	}
	defer func() {
		if err := windows.CloseHandle(h); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("native stream close: %w", err))
		}
		resultErr = errors.Join(resultErr, verifyStableOriginal(original, expected, ctx), ctx.Err())
		if resultErr != nil {
			result = Stream{}
		}
	}()
	granted, err := nativeGrantedAccess(h, ctx)
	if err != nil {
		return result, err
	}
	if granted&nativeStreamReadAccess != nativeStreamReadAccess {
		return result, fmt.Errorf("native stream missing ordinary granted rights")
	}
	if err := verifyStableReadCompletion(original, h, expected, ctx); err != nil {
		return result, err
	}
	if err := preserveReadAccess(h, ctx); err != nil {
		return result, err
	}
	if err := verifyStableReadCompletion(original, h, expected, ctx); err != nil {
		return result, err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return result, err
	}
	if int64(uint64(info.FileSizeHigh)<<32|uint64(info.FileSizeLow)) != stream.Size {
		return result, fmt.Errorf("native named stream size changed")
	}
	data := make([]byte, int(stream.Size)+1)
	offset := 0
	for {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if offset >= len(data) {
			return result, fmt.Errorf("native named stream grew")
		}
		end := offset + (64 << 10)
		if end > len(data) {
			end = len(data)
		}
		var n uint32
		err := windows.ReadFile(h, data[offset:end], &n, nil)
		if contextErr := ctx.Err(); contextErr != nil {
			return result, contextErr
		}
		if n > uint32(end-offset) {
			return result, fmt.Errorf("native stream read length")
		}
		if err != nil && !errors.Is(err, windows.ERROR_HANDLE_EOF) {
			return result, fmt.Errorf("native named stream read: %w", err)
		}
		offset += int(n)
		if int64(offset) > stream.Size {
			return result, fmt.Errorf("native named stream grew")
		}
		if n == 0 || err != nil {
			break
		}
	}
	if int64(offset) != stream.Size {
		return result, fmt.Errorf("native named stream truncated")
	}
	if err := verifyStableReadCompletion(original, h, expected, ctx); err != nil {
		return result, err
	}
	store := blobs(ctx)
	if store == nil {
		return result, fmt.Errorf("native stream CAS not configured")
	}
	payload := data[:offset]
	if err := ctx.Err(); err != nil {
		return result, err
	}
	digest, err := store.Put(ctx, payload)
	if err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if digest != Digest(payload) {
		return result, fmt.Errorf("native stream CAS digest changed")
	}
	if err := verifyStableReadCompletion(original, h, expected, ctx); err != nil {
		return result, err
	}
	return Stream{Name: stream.Name, Size: stream.Size, Digest: digest}, nil
}

func readNativeStreams(ctx context.Context, original windows.Handle, expected stableReadState, mainSize int64, inventory []nativeStreamRecord) ([]Stream, error) {
	if err := requireNativeReadRights(original, ctx); err != nil {
		return nil, err
	}
	listed, err := readNativeStreamInfo(ctx, original, mainSize)
	if err != nil {
		return nil, err
	}
	if !nativeStreamListsEqual(listed, inventory) {
		return nil, fmt.Errorf("native stream enumeration/header inventory mismatch")
	}
	if err := verifyStableOriginal(original, expected, ctx); err != nil {
		return nil, err
	}
	streams := make([]Stream, 0, len(listed))
	var total int64
	for _, record := range listed {
		if record.Size > StreamBytes-total {
			return nil, fmt.Errorf("native total stream budget")
		}
		total += record.Size
		stream, err := readNativeStream(ctx, original, expected, record)
		if err != nil {
			return nil, err
		}
		streams = append(streams, stream)
	}
	after, err := readNativeStreamInfo(ctx, original, mainSize)
	if err != nil {
		return nil, err
	}
	if !nativeStreamListsEqual(listed, after) {
		return nil, fmt.Errorf("native stream enumeration changed during capture")
	}
	if err := verifyStableOriginal(original, expected, ctx); err != nil {
		return nil, err
	}
	return streams, nil
}
