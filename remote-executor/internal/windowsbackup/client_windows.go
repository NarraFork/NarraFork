//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"io"
	"os"
	"time"
)

type PipeClient struct {
	Name               string
	ServerPID          uint32
	ServerCreationTime uint64
	ServerSID          string
}

type firstPipeExchangeState struct{ Dispatched, Returned bool }

func (c *PipeClient) exchange(ctx context.Context, request PipeRequest, tracking ...*firstPipeExchangeState) (responseResult *PipeResponse, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var trace *firstPipeExchangeState
	if len(tracking) == 1 {
		trace = tracking[0]
		defer func() { trace.Returned = true }()
	}
	if c.ServerPID == 0 || c.ServerCreationTime == 0 || c.ServerSID == "" {
		return nil, fmt.Errorf("administrator-pinned helper process identity missing")
	}
	name, err := windows.UTF16PtrFromString(c.Name)
	if err != nil {
		return nil, err
	}
	// Identification SQOS prevents a malicious pipe server from impersonating
	// the client. No ticket, key or pipe handle is inheritable by Shell workers.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED|0x00100000|0x00010000, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		closeErr := windows.CloseHandle(handle)
		if trace != nil && closeErr != nil {
			responseResult = nil
			resultErr = errors.Join(resultErr, fmt.Errorf("helper pipe client close unknown: %w", closeErr))
		}
	}()
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(handle, &pid); err != nil || pid != c.ServerPID {
		return nil, fmt.Errorf("helper pipe process identity mismatch")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(process)
	var created, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exit, &kernel, &user); err != nil {
		return nil, err
	}
	if uint64(created.HighDateTime)<<32|uint64(created.LowDateTime) != c.ServerCreationTime {
		return nil, fmt.Errorf("helper PID creation identity changed")
	}
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	identity, err := token.GetTokenUser()
	if err != nil || identity.User.Sid.String() != c.ServerSID {
		return nil, fmt.Errorf("helper token identity mismatch")
	}
	data, err := json.Marshal(request)
	if err != nil || len(data) > PipeMessageBytes {
		return nil, fmt.Errorf("helper message budget")
	}
	var length [4]byte
	binary.LittleEndian.PutUint32(length[:], uint32(len(data)))
	if trace != nil {
		trace.Dispatched = true
	}
	if err := pipeTransfer(ctx, handle, length[:], true); err != nil {
		return nil, err
	}
	if err := pipeTransfer(ctx, handle, data, true); err != nil {
		return nil, err
	}
	if err := pipeTransfer(ctx, handle, length[:], false); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(length[:])
	if size == 0 || size > PipeMessageBytes {
		return nil, fmt.Errorf("helper response budget")
	}
	data = make([]byte, size)
	if err := pipeTransfer(ctx, handle, data, false); err != nil {
		return nil, err
	}
	if err := rejectDuplicateJSON(data); err != nil {
		return nil, err
	}
	var response PipeResponse
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("trailing helper response")
	}
	if response.Error != "" {
		return &response, fmt.Errorf("Windows backup helper refused or retained unknown outcome")
	}
	return &response, nil
}
func (c *PipeClient) Execute(ctx context.Context, envelope []byte, file *os.File, proof *CaptureProof) (*OperationResult, error) {
	var ticket SignedTicket
	if err := json.Unmarshal(envelope, &ticket); err != nil {
		return nil, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(ticket.Payload)
	if err != nil {
		return nil, err
	}
	var payload Ticket
	if err := strictJSON(raw, &payload); err != nil {
		return nil, err
	}
	handle := uint64(0)
	if file != nil {
		handle = uint64(file.Fd())
	}
	response, err := c.exchange(ctx, PipeRequest{Operation: "execute", Version: 1, Ticket: envelope, Challenge: payload.ChallengeNonce, OrdinaryHandle: handle, Proof: proof})
	if response == nil {
		return nil, err
	}
	return response.Result, err
}
func (c *PipeClient) Challenge(ctx context.Context, original ChallengeOrigin, request MetadataCallback, file *os.File) (*MetadataCallback, error) {
	handle := uint64(0)
	if file != nil {
		handle = uint64(file.Fd())
	} else if request.Action != "status_original" {
		return nil, fmt.Errorf("ordinary authorization handle required")
	}
	response, err := c.exchange(ctx, PipeRequest{Operation: "challenge", Version: 1, Origin: &original, Callback: &request, OrdinaryHandle: handle})
	if response == nil {
		return nil, err
	}
	return response.Callback, err
}
