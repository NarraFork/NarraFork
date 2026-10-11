//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const PipeMessageBytes = 1 << 20

type PipeConfig struct {
	Name, ClientServiceSID string
	FirstCaptureOnly       bool
}
type PipeRequest struct {
	Operation         string                          `json:"operation"`
	Origin            *ChallengeOrigin                `json:"origin"`
	Callback          *MetadataCallback               `json:"callback"`
	Version           int                             `json:"version"`
	Ticket            json.RawMessage                 `json:"ticket"`
	Challenge         string                          `json:"challenge"`
	OrdinaryHandle    uint64                          `json:"ordinaryHandle"`
	Proof             *CaptureProof                   `json:"proof"`
	FirstOrigin       *FirstCaptureOrigin             `json:"firstCaptureOrigin,omitempty"`
	FirstPreauthorize *FirstCapturePreauthorizeParams `json:"firstPreauthorize,omitempty"`
	FirstCapture      *FirstCaptureParams             `json:"firstCapture,omitempty"`
	FirstTokenDigest  string                          `json:"firstTokenDigest,omitempty"`
	FirstExpiry       uint64                          `json:"firstExpiry,omitempty"`
}
type PipeResponse struct {
	Result                 *OperationResult      `json:"result"`
	Callback               *MetadataCallback     `json:"callback"`
	Error                  string                `json:"error"`
	FirstAttestation       *FirstCaptureEnvelope `json:"firstAttestation,omitempty"`
	FirstNativeTerminal    bool                  `json:"firstNativeTerminal,omitempty"`
	FirstResourcesTerminal bool                  `json:"firstResourcesTerminal,omitempty"`
}

// ServeBackupHelper is an explicit native entry point for Main's helper mode.
// It never installs a service, elevates an account or enrolls an unknown client.
// The administrator must provision Helper/Verifier session, pins, roots and ACLs.
func ServeBackupHelper(ctx context.Context, c PipeConfig, helper *Helper) error {
	if helper == nil || !strings.HasPrefix(c.Name, `\\.\pipe\NarraFork.Backup.`) || len(c.Name) > 256 || strings.ContainsAny(c.Name[len(`\\.\pipe\`):], `\/`) || c.ClientServiceSID != helper.Verifier.Session.Peer.ServiceSID || !strings.HasPrefix(c.ClientServiceSID, "S-1-5-80-") {
		return fmt.Errorf("backup helper native transport configuration not ready")
	}
	if _, err := windows.StringToSid(c.ClientServiceSID); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;" + c.ClientServiceSID + ")")
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(c.Name)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	handles := make([]windows.Handle, Workers)
	for i := range handles {
		flags := uint32(windows.PIPE_ACCESS_DUPLEX | windows.FILE_FLAG_OVERLAPPED)
		if i == 0 {
			flags |= windows.FILE_FLAG_FIRST_PIPE_INSTANCE
		}
		handles[i], err = windows.CreateNamedPipe(name, flags, windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, Workers, 64<<10, 64<<10, 10000, &sa)
		if err != nil {
			for _, h := range handles[:i] {
				windows.CloseHandle(h)
			}
			return err
		}
	}
	cleanupCtx, stopCleanup := context.WithCancel(ctx)
	cleanupDone := make(chan struct{})
	defer func() { stopCleanup(); <-cleanupDone }()
	go func() {
		defer close(cleanupDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-cleanupCtx.Done():
				return
			case <-ticker.C:
				_ = helper.firstCaptureHandles.expire()
			}
		}
	}()
	var wg sync.WaitGroup
	failures := make(chan error, Workers)
	for _, handle := range handles {
		wg.Add(1)
		go func(h windows.Handle) {
			defer wg.Done()
			defer windows.CloseHandle(h)
			for ctx.Err() == nil {
				if err := connectHelperPipe(ctx, h); err != nil {
					if ctx.Err() == nil {
						failures <- err
					}
					return
				}
				// One bounded message per authenticated native connection. Ordinary shell
				// workers inherit neither a pipe handle nor any helper ticket credentials.
				helperPipeExchange(ctx, h, c, helper)
				windows.DisconnectNamedPipe(h)
			}
		}(handle)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		return err
	}
	return ctx.Err()
}
func connectHelperPipe(ctx context.Context, handle windows.Handle) error {
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(event)
	overlapped := windows.Overlapped{HEvent: event}
	var pin runtime.Pinner
	pin.Pin(&overlapped)
	defer pin.Unpin()
	cancelDone := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { defer close(cancelDone); windows.CancelIoEx(handle, &overlapped) })
	defer func() {
		if !stop() {
			<-cancelDone
		}
	}()
	err = windows.ConnectNamedPipe(handle, &overlapped)
	if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		return nil
	}
	if !errors.Is(err, windows.ERROR_IO_PENDING) {
		return err
	}
	var used uint32
	err = windows.GetOverlappedResult(handle, &overlapped, &used, true)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
func pipeTransfer(ctx context.Context, handle windows.Handle, data []byte, write bool) error {
	for offset := 0; offset < len(data); {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := offset + (64 << 10)
		if end > len(data) {
			end = len(data)
		}
		event, err := windows.CreateEvent(nil, 1, 0, nil)
		if err != nil {
			return err
		}
		overlapped := windows.Overlapped{HEvent: event}
		var used uint32
		var pin runtime.Pinner
		pin.Pin(&overlapped)
		pin.Pin(&data[offset])
		pin.Pin(&used)
		cancelDone := make(chan struct{})
		stop := context.AfterFunc(ctx, func() { defer close(cancelDone); windows.CancelIoEx(handle, &overlapped) })
		if write {
			err = windows.WriteFile(handle, data[offset:end], &used, &overlapped)
		} else {
			err = windows.ReadFile(handle, data[offset:end], &used, &overlapped)
		}
		if errors.Is(err, windows.ERROR_IO_PENDING) {
			err = windows.GetOverlappedResult(handle, &overlapped, &used, true)
		}
		if !stop() {
			<-cancelDone
		}
		runtime.KeepAlive(data)
		pin.Unpin()
		if closeErr := windows.CloseHandle(event); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
		if err != nil {
			return err
		}
		if used == 0 {
			return io.ErrUnexpectedEOF
		}
		offset += int(used)
	}
	return nil
}
func actualPipePeer(pipe windows.Handle, expected PeerIdentity) (PeerIdentity, windows.Handle, error) {
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(pipe, &pid); err != nil {
		return PeerIdentity{}, 0, err
	}
	if pid == 0 || pid != expected.PID {
		return PeerIdentity{}, 0, fmt.Errorf("unregistered pipe peer PID")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_DUP_HANDLE, false, pid)
	if err != nil {
		return PeerIdentity{}, 0, err
	}
	failure := func(err error) (PeerIdentity, windows.Handle, error) {
		windows.CloseHandle(process)
		return PeerIdentity{}, 0, err
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return failure(err)
	}
	creation := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	if creation != expected.CreationTime {
		return failure(fmt.Errorf("pipe PID creation identity changed"))
	}
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return failure(err)
	}
	defer token.Close()
	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return failure(err)
	}
	if tokenUser.User.Sid.String() != expected.SID {
		return failure(fmt.Errorf("pipe token SID changed"))
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return failure(err)
	}
	enrolledService := false
	for _, g := range groups.AllGroups() {
		if g.Sid.String() == expected.ServiceSID && g.Attributes&windows.SE_GROUP_ENABLED != 0 && g.Attributes&windows.SE_GROUP_USE_FOR_DENY_ONLY == 0 {
			enrolledService = true
		}
	}
	if !enrolledService {
		return failure(fmt.Errorf("actual pipe token lacks dedicated registered service SID"))
	}
	return PeerIdentity{PID: pid, CreationTime: creation, SID: expected.SID, ServiceSID: expected.ServiceSID, ExecutorInstance: expected.ExecutorInstance}, process, nil
}
func helperPipeExchange(parent context.Context, pipe windows.Handle, c PipeConfig, helper *Helper) {
	ctx, cancel := context.WithTimeout(parent, 10_000_000_000)
	defer cancel()
	peer, process, err := actualPipePeer(pipe, helper.Verifier.Session.Peer)
	if err != nil {
		return
	}
	defer func() {
		if process != 0 {
			windows.CloseHandle(process)
		}
	}()
	var length [4]byte
	if pipeTransfer(ctx, pipe, length[:], false) != nil {
		return
	}
	size := binary.LittleEndian.Uint32(length[:])
	if size == 0 || size > PipeMessageBytes {
		return
	}
	raw := make([]byte, size)
	if pipeTransfer(ctx, pipe, raw, false) != nil {
		return
	}
	var request PipeRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.Version != 1 || request.OrdinaryHandle > 9007199254740991 || (request.Operation == "execute" || request.Operation == "" || request.Operation == "first_capture") && !validNonce(request.Challenge) {
		return
	}
	if rejectDuplicateJSON(raw) != nil {
		return
	}
	firstOperation := request.Operation == "first_preauthorize" || request.Operation == "first_capture_challenge" || request.Operation == "first_capture"
	if c.FirstCaptureOnly && !firstOperation {
		return
	}
	var firstAdmission *firstPipeAdmission
	if firstOperation {
		if request.FirstOrigin == nil || request.Origin != nil || request.Proof != nil || request.OrdinaryHandle == 0 {
			return
		}
		var admitErr error
		ctx, firstAdmission, admitErr = helper.admitFirstPipe(ctx, peer, request.Operation, *request.FirstOrigin, request.FirstPreauthorize, request.FirstCapture, request.FirstTokenDigest, request.FirstExpiry)
		if admitErr != nil {
			return
		}
		defer func() { _ = firstAdmission.finish(ctx) }()
	}
	var file *os.File
	fileOwned := false
	defer func() {
		if file != nil && !fileOwned {
			file.Close()
		}
	}()
	if request.OrdinaryHandle != 0 {
		var duplicate windows.Handle
		if err := windows.DuplicateHandle(process, windows.Handle(request.OrdinaryHandle), windows.CurrentProcess(), &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return
		}
		file = os.NewFile(uintptr(duplicate), "")
		if firstAdmission != nil {
			firstAdmission.attachDuplicate(file)
			fileOwned = true
		}
	}
	response := PipeResponse{}
	if firstOperation {
		if request.FirstOrigin == nil || file == nil || request.Origin != nil || request.Proof != nil {
			return
		}
		// The peer process pin is no longer needed after same-access duplication.
		// Close it before any completed-domain signature can be issued.
		if err := windows.CloseHandle(process); err != nil {
			return
		}
		process = 0
		switch request.Operation {
		case "first_preauthorize":
			if request.FirstPreauthorize == nil || request.FirstCapture != nil || request.Callback != nil || len(request.Ticket) != 0 {
				return
			}
			var result FirstCaptureEnvelope
			result, _, err = helper.preauthorizeFirstCapture(ctx, peer, *request.FirstOrigin, *request.FirstPreauthorize, request.FirstTokenDigest, request.FirstExpiry, file)
			if err == nil {
				response.FirstAttestation = &result
				response.FirstNativeTerminal = true
			}
		case "first_capture_challenge":
			if request.FirstCapture == nil || request.FirstPreauthorize != nil || request.Callback == nil || len(request.Ticket) != 0 {
				return
			}
			response.Callback, err = helper.challengeFirstCapture(ctx, peer, *request.FirstOrigin, *request.FirstCapture, *request.Callback, file)
		case "first_capture":
			if request.FirstCapture == nil || request.FirstPreauthorize != nil || request.Callback != nil || len(request.Ticket) == 0 {
				return
			}
			var result FirstCaptureEnvelope
			result, _, response.FirstNativeTerminal, response.FirstResourcesTerminal, err = helper.executeFirstCapture(ctx, peer, *request.FirstOrigin, *request.FirstCapture, request.Ticket, file)
			if err == nil {
				response.FirstAttestation = &result
			}
		}
		if finishErr := firstAdmission.finish(ctx); finishErr != nil {
			err = errors.Join(err, finishErr)
			response.FirstAttestation = nil
			response.Callback = nil
			response.FirstResourcesTerminal = false
		}
		// Every first-capture duplicate belongs to the already-reserved lease;
		// no unaccounted descriptor is closed only after a completed response.
		if !fileOwned {
			closeErr := file.Close()
			fileOwned = true
			if closeErr != nil {
				err = errors.Join(err, closeErr)
				response.FirstAttestation = nil
				response.FirstResourcesTerminal = false
			}
		}
	} else if request.FirstOrigin != nil || request.FirstPreauthorize != nil || request.FirstCapture != nil || request.FirstTokenDigest != "" || request.FirstExpiry != 0 {
		return
	} else if request.Operation == "challenge" {
		if request.Origin == nil || request.Callback == nil || request.Proof != nil || len(request.Ticket) != 0 {
			return
		}
		response.Callback, err = helper.Challenge(ctx, peer, *request.Origin, *request.Callback, file)
	} else if request.Operation == "execute" || request.Operation == "" {
		if request.Origin != nil || request.Callback != nil {
			return
		}
		response.Result, err = helper.Execute(ctx, request.Ticket, peer, request.Challenge, file, request.Proof)
	} else {
		return
	}
	if err != nil {
		response.Error = "WINDOWS_BACKUP_HELPER_REJECTED_OR_UNKNOWN"
	}
	output, err := json.Marshal(response)
	if err != nil || len(output) > PipeMessageBytes {
		return
	}
	binary.LittleEndian.PutUint32(length[:], uint32(len(output)))
	if pipeTransfer(ctx, pipe, length[:], true) != nil {
		return
	}
	_ = pipeTransfer(ctx, pipe, output, true)
}
