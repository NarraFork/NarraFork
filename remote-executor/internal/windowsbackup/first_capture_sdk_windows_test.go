//go:build windows

package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Real ordinary Windows handles/same-access duplication/SDK matrix and private
// signatures; fixture control-plane keys, NOT production SID/custody enrollment.
type firstCaptureSDKNative struct {
	*preparedScratchNative
	pinCalls int
}

func (n *firstCaptureSDKNative) InspectFirstCaptureOrdinary(ctx context.Context, root NativeDescriptor, file *os.File) (FirstCapturePinnedOrdinary, error) {
	r := FirstCapturePinnedOrdinary{Terminal: true}
	grant, err := InspectFirstCaptureOrdinaryHandle(ctx, file)
	if err != nil {
		return r, err
	}
	r.GrantedAccess = grant
	r.Observation, err = n.DescribeOrdinary(ctx, root, file)
	return r, err
}
func (n *firstCaptureSDKNative) PinOrdinary(ctx context.Context, root NativeDescriptor, file *os.File) (FirstCapturePinnedOrdinary, error) {
	n.pinCalls++
	r, err := n.InspectFirstCaptureOrdinary(ctx, root, file)
	if err != nil {
		return r, err
	}
	pin, err := openOrdinary(n.rootFile.Name(), windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
	if err != nil {
		return r, err
	}
	r.Pins = []io.Closer{pin}
	return r, nil
}
func TestNativeWindowsFirstCaptureCompletedPrivateRecord(t *testing.T) {
	requirePreparedScratch(t)
	for _, ads := range []bool{false, true} {
		t.Run(map[bool]string{false: "main", true: "ads"}[ads], func(t *testing.T) {
			h := newPreparedHarness(t)
			rootPath := t.TempDir()
			path := filepath.Join(rootPath, "original-first.txt")
			if err := os.WriteFile(path, []byte("first ordinary capture"), 0600); err != nil {
				t.Fatal("fixture main create")
			}
			if ads {
				if err := os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0600); err != nil {
					t.Fatal("fixture ADS create")
				}
			}
			root, err := openOrdinary(rootPath, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			rd, err := preparedNativeDescriptor(root)
			if err != nil {
				t.Fatal(err)
			}
			native := &firstCaptureSDKNative{preparedScratchNative: &preparedScratchNative{rootFile: root, root: rd}}
			h.base.Root = rd
			h.base.Parent = rd
			h.helper.Verifier.Roots = []NativeDescriptor{rd}
			h.helper.Native = native
			raw, err := openFirstCaptureRaw(h.ctx, path)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			before, err := inspectStableReadObject(windows.Handle(raw.file.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			var predup, capturedup windows.Handle
			if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(raw.file.Fd()), windows.CurrentProcess(), &predup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
				t.Fatal(err)
			}
			preFile := os.NewFile(uintptr(predup), path)
			o := FirstCaptureOrigin{Version: 1, DeviceID: h.base.DeviceID, ExecutorSourceID: h.base.ExecutorSourceID, ScopeID: h.base.ScopeID, Root: rd, HelperInstanceID: h.base.HelperInstanceID, HelperKeyEpoch: h.store.config.KeyEpoch, OperationID: h.base.OperationID, RequestDigest: h.base.RequestDigest, LeaseID: h.base.LeaseID, Fence: h.base.Fence, ConnectionID: h.base.ConnectionID, SessionID: h.base.SessionID, RuntimeGeneration: h.base.RuntimeGeneration, Action: "capture_exact", Phase: "preauthorize", OuterRPCID: "preauth-rpc"}
			params := FirstCapturePreauthorizeParams{1, path, strings.Repeat("A", 32)}
			var tokenBytes [32]byte
			if _, err := rand.Read(tokenBytes[:]); err != nil {
				t.Fatal(err)
			}
			token := base64.RawURLEncoding.EncodeToString(tokenBytes[:])
			tokenDigest, err := FirstCaptureTokenDigest(token)
			if err != nil {
				t.Fatal(err)
			}
			pre, owned, err := h.helper.preauthorizeFirstCapture(h.ctx, h.peer, o, params, tokenDigest, uint64(time.Now().Add(20*time.Second).UnixMilli()), preFile)
			if err != nil || !owned {
				t.Fatal("pure ordinary preauthorization", err)
			}
			if native.restores != 0 || native.observes != 0 || native.captures != 0 || native.outcomes != 0 {
				t.Fatal("preauthorization called old capture/observe/restore")
			}
			afterPre, err := inspectStableReadObject(windows.Handle(raw.file.Fd()))
			if err != nil || afterPre != before {
				t.Fatal("preauthorization changed original native/basic fields")
			}
			var preauth FirstCapturePreauthorization
			if verifyFirstCaptureEnvelope(pre, h.store.config.SigningKey.Public().(ed25519.PublicKey), &preauth) != nil || preauth.Validate() != nil {
				t.Fatal("preauth signature")
			}
			if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(raw.file.Fd()), windows.CurrentProcess(), &capturedup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
				t.Fatal(err)
			}
			captureFile := os.NewFile(uintptr(capturedup), path)
			origin := o
			origin.Phase = "capture"
			origin.OuterRPCID = "outer-rpc"
			p := FirstCaptureParams{1, token, o.OuterRPCID, params.Nonce, strings.Repeat("B", 32)}
			ticket := h.base
			ticket.Target = preauth.Descriptors.Target
			ticket.Parent = preauth.Descriptors.Parent
			ticket = h.attested(ticket)
			envelope, err := h.sign(ticket)
			if err != nil {
				t.Fatal(err)
			}
			result, owned, terminated, closed, err := h.helper.executeFirstCapture(h.ctx, h.peer, origin, p, envelope, captureFile)
			if err != nil || !owned || !terminated || !closed {
				t.Fatal("original complete helper capture chain", err)
			}
			if native.observes != 2 || native.captures != 1 || native.restores != 0 {
				t.Fatal("original Observe->Capture->Observe chain changed")
			}
			var completed FirstCaptureResultPayload
			if verifyFirstCaptureEnvelope(result, h.store.config.SigningKey.Public().(ed25519.PublicKey), &completed) != nil || completed.Validate(h.store.config.SigningKey.Public().(ed25519.PublicKey)) != nil {
				t.Fatal("completed capture signature/fields")
			}
			var issued SignedTicket
			if json.Unmarshal(envelope, &issued) != nil {
				t.Fatal("actual ticket decode")
			}
			payload, err := decodeTicketPayload(issued)
			if err != nil || completed.TicketPayloadDigest != Digest(payload) || completed.Origin != origin {
				t.Fatal("actual ticket/actor/origin payload digest association")
			}
			if _, _, _, _, err := h.helper.executeFirstCapture(h.ctx, h.peer, origin, p, envelope, captureFile); err == nil || native.captures != 1 {
				t.Fatal("consumed token redispatched")
			}
			t.Log("SDK fixture ordinary FD + DUPLICATE_SAME_ACCESS + zero-preauth-capture + preserved full Helper chain + captured-after-close private record signature; not production custody/SID readiness")
		})
	}
}

// A real pipe server can match PID/SID and still cannot claim the dedicated
// executor service SID. actualPipePeer must reject before any file duplication.
func TestNativeWindowsFirstCapturePipePeerDoesNotTrustSameSID(t *testing.T) {
	requirePreparedScratch(t)
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = key
	name, err := windows.UTF16PtrFromString(`\\.\pipe\NarraFork.Backup.first-capture-peer-` + strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10))
	if err != nil {
		t.Fatal(err)
	}
	server, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED|windows.FILE_FLAG_FIRST_PIPE_INSTANCE, windows.PIPE_TYPE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 5000, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(server)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	clientResult := make(chan error, 1)
	probeDone := make(chan struct{})
	go func() {
		client, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED, 0)
		if err == nil {
			select {
			case <-probeDone:
			case <-ctx.Done():
			}
			err = windows.CloseHandle(client)
		}
		clientResult <- err
	}()
	if err := connectHelperPipe(ctx, server); err != nil {
		t.Fatal(err)
	}
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(windows.CurrentProcess(), &created, &exited, &kernel, &user) != nil {
		t.Fatal("actual process creation")
	}
	identity, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	expected := PeerIdentity{PID: uint32(os.Getpid()), CreationTime: uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), SID: identity.User.Sid.String(), ServiceSID: "S-1-5-80-1-2-3-4-5", ExecutorInstance: "unit-test-instance"}
	_, process, peerErr := actualPipePeer(server, expected)
	if process != 0 {
		windows.CloseHandle(process)
	}
	close(probeDone)
	if err := <-clientResult; err != nil {
		t.Fatal(err)
	}
	if peerErr == nil || !strings.Contains(peerErr.Error(), "actual pipe token lacks dedicated registered service SID") {
		t.Fatal("actual same PID/creation/SID service-group rejection was not reached", peerErr)
	}
	t.Log("real pipe same PID/creation/SID cannot substitute enabled service SID; no native capture/data/ACL call")
}
