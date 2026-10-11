//go:build windows

package winpty

import (
	"io"
	"runtime"
	"sync"

	"golang.org/x/sys/windows"
)

// synchronousPipe deliberately uses ReadFile/WriteFile with nil OVERLAPPED.
// ConPTY requires synchronous pipe ends; do not put these handles into Go's
// overlapped IOCP registration implicitly through an os.File adapter.
type synchronousPipe struct {
	handle windows.Handle
	once   sync.Once
}

func (p *synchronousPipe) Read(data []byte) (int, error) {
	var count uint32
	err := windows.ReadFile(p.handle, data, &count, nil)
	runtime.KeepAlive(data)
	if err == windows.ERROR_BROKEN_PIPE || err == windows.ERROR_NO_DATA {
		return int(count), io.EOF
	}
	if err == nil && count == 0 {
		return 0, io.EOF
	}
	return int(count), err
}
func (p *synchronousPipe) Write(data []byte) (int, error) {
	var count uint32
	err := windows.WriteFile(p.handle, data, &count, nil)
	runtime.KeepAlive(data)
	return int(count), err
}
func (p *synchronousPipe) Close() error {
	var err error
	p.once.Do(func() { _ = windows.CancelIoEx(p.handle, nil); err = windows.CloseHandle(p.handle) })
	return err
}
