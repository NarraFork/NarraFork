//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Native test adapter is deliberately limited to ordinary direct children of
// one explicit scratch root. It is not a production root/deny-hole resolver or
// evidence of ordinary-token service deployment. Every metadata call is real.
type preparedScratchNative struct {
	rootFile   *os.File
	root       NativeDescriptor
	restores   int
	observes   int
	captures   int
	outcomes   int
	describes  int
	diagnostic *preparedCaptureDiagnostic
}

func preparedNativeDescriptor(f *os.File) (NativeDescriptor, error) {
	var id fileIDInformation
	if err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileIdInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err != nil {
		return NativeDescriptor{}, err
	}
	var basic basicInformation
	if err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return NativeDescriptor{}, err
	}
	var name [32768]uint16
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(f.Fd()), &name[0], uint32(len(name)), 1)
	if err != nil || n == 0 || n >= uint32(len(name)) {
		return NativeDescriptor{}, fmt.Errorf("native scratch final name unavailable: %v", err)
	}
	volume, _, err := VolumeIdentity(f)
	if err != nil {
		return NativeDescriptor{}, err
	}
	return NativeDescriptor{volume, hex.EncodeToString(id.ID[:]), strconv.FormatUint(uint64(basic.Creation), 10), windows.UTF16ToString(name[:n])}, nil
}
func (n *preparedScratchNative) DescribeOrdinary(ctx context.Context, root NativeDescriptor, f *os.File) (NativeObservation, error) {
	n.describes++
	if err := ctx.Err(); err != nil {
		return NativeObservation{}, err
	}
	actualRoot, err := preparedNativeDescriptor(n.rootFile)
	if err != nil {
		return NativeObservation{}, err
	}
	target, err := preparedNativeDescriptor(f)
	if err != nil {
		return NativeObservation{}, err
	}
	if root != n.root || actualRoot != n.root || filepath.Dir(target.PathKey) != root.PathKey || target.VolumeID != root.VolumeID {
		return NativeObservation{}, fmt.Errorf("scratch exact native containment changed")
	}
	if _, err := validateOrdinary(windows.Handle(f.Fd())); err != nil {
		return NativeObservation{}, err
	}
	return NativeObservation{Root: root, Parent: root, Target: target, RootPath: root.PathKey, ParentPath: root.PathKey, TargetPath: target.PathKey}, nil
}
func (n *preparedScratchNative) Observe(ctx context.Context, ticket Ticket, f *os.File) (NativeObservation, error) {
	n.observes++
	o, err := n.DescribeOrdinary(ctx, ticket.Root, f)
	if err != nil {
		return o, err
	}
	s, err := Capture(ctx, f)
	if err != nil {
		return o, err
	}
	o.MetadataHash, err = SnapshotFingerprint(s)
	if err != nil {
		return o, err
	}
	info, err := f.Stat()
	if err != nil {
		return o, err
	}
	if info.Size() > 32<<20 {
		return o, fmt.Errorf("scratch main stream budget")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.NewSectionReader(f, 0, (32<<20)+1))
	if err != nil || size != info.Size() {
		return o, fmt.Errorf("scratch content changed: %v", err)
	}
	o.ContentHash = hex.EncodeToString(hash.Sum(nil))
	if n.diagnostic != nil {
		n.diagnostic.observed(ticket.Action, f, o, s)
	}
	return o, nil
}
func (n *preparedScratchNative) Capture(ctx context.Context, f *os.File) (*Snapshot, error) {
	n.captures++
	s, err := Capture(ctx, f)
	if err == nil && n.diagnostic != nil {
		n.diagnostic.captured(f, s)
	}
	return s, err
}
func (n *preparedScratchNative) Restore(ctx context.Context, f *os.File, r *CaptureRecord) error {
	n.restores++
	return ApplyExact(ctx, f, r.Snapshot)
}
func (*preparedScratchNative) Seal(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) (*VaultReference, error) {
	return nil, fmt.Errorf("scratch seal prohibited")
}
func (*preparedScratchNative) Unseal(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error {
	return fmt.Errorf("scratch unseal prohibited")
}
func (*preparedScratchNative) Cleanup(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error {
	return fmt.Errorf("scratch cleanup prohibited")
}
func (n *preparedScratchNative) VerifyOutcome(ctx context.Context, _ *VerifiedTicket, f *os.File, r *CaptureRecord) error {
	n.outcomes++
	return Matches(ctx, f, r.Snapshot)
}

// Verify actual ADS bytes without a path reopen or CAS substitution. This is
// fixture-only and runs AFTER the strict channel assertions, using the same
// ordinary live base handle and production relative-open/identity guards.
func verifyPreparedFixtureADS(ctx context.Context, native *preparedScratchNative, file *os.File, expectedBytes []byte) (resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if len(expectedBytes) > 4096 {
		return fmt.Errorf("fixture ADS verification budget")
	}
	original := windows.Handle(file.Fd())
	before, err := native.DescribeOrdinary(ctx, native.root, file)
	if err != nil {
		return err
	}
	state, err := inspectStableRead(original, ctx)
	if err != nil {
		return err
	}
	h, err := openNativeStream(ctx, original, ":Zone.Identifier:$DATA")
	if err != nil {
		return err
	}
	defer func() {
		if err := windows.CloseHandle(h); err != nil {
			resultErr = errors.Join(resultErr, err)
		}
		resultErr = errors.Join(resultErr, verifyStableOriginal(original, state, ctx))
		after, err := native.DescribeOrdinary(ctx, native.root, file)
		if err != nil {
			resultErr = errors.Join(resultErr, err)
		} else if after != before {
			resultErr = errors.Join(resultErr, fmt.Errorf("fixture ADS verification changed native root/parent/target"))
		}
	}()
	if err := preserveReadAccess(h, ctx); err != nil {
		return err
	}
	if err := verifyStableReadCompletion(original, h, state, ctx); err != nil {
		return err
	}
	actual := make([]byte, len(expectedBytes)+1)
	offset := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if offset == len(actual) {
			return fmt.Errorf("fixture ADS is larger than expected")
		}
		var n uint32
		err := windows.ReadFile(h, actual[offset:], &n, nil)
		if contextErr := ctx.Err(); contextErr != nil {
			return contextErr
		}
		if n > uint32(len(actual)-offset) {
			return fmt.Errorf("fixture ADS read length")
		}
		if err != nil && !errors.Is(err, windows.ERROR_HANDLE_EOF) {
			return err
		}
		offset += int(n)
		if n == 0 || err != nil {
			break
		}
	}
	if !bytes.Equal(actual[:offset], expectedBytes) {
		return fmt.Errorf("fixture actual ADS bytes changed")
	}
	return verifyStableReadCompletion(original, h, state, ctx)
}

func requirePreparedScratch(t *testing.T) {
	t.Helper()
	scratch := os.Getenv("NARRAFORK_PREPARED_SCRATCH")
	if !filepath.IsAbs(scratch) || !filepath.IsAbs(os.Getenv("TEMP")) || !strings.EqualFold(filepath.Clean(scratch), filepath.Clean(os.TempDir())) {
		t.Fatal("set NARRAFORK_PREPARED_SCRATCH and TEMP to the same explicitly authorized scratch directory")
	}
	info, err := os.Stat(scratch)
	if err != nil || !info.IsDir() {
		t.Fatal("explicit scratch unavailable", err)
	}
	if strings.Contains(strings.ToLower(filepath.Clean(scratch)), `\windows\`) {
		t.Fatal("system directory cannot be a native test scratch")
	}
}

func TestNativeWindowsPreparedChannel(t *testing.T) {
	requirePreparedScratch(t)
	before := nativeTokenPrivileges(t)
	for _, fixture := range []struct {
		name, sacl string
		ads        bool
	}{{"default", "", false}, {"empty-sacl", "S:", false}, {"null-sacl", "S:NO_ACCESS_CONTROL", false}, {"protected-audit-label", "S:P(AU;SAFA;FW;;;WD)(ML;;NW;;;ME)", false}, {"ads-protected-audit", "S:P(AU;SAFA;FW;;;WD)(ML;;NW;;;ME)", true}} {
		t.Run(fixture.name, func(t *testing.T) {
			h := newPreparedHarness(t)
			rootPath := t.TempDir()
			rootFile, err := openOrdinary(rootPath, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
			if err != nil {
				t.Fatal(err)
			}
			defer rootFile.Close()
			root, err := preparedNativeDescriptor(rootFile)
			if err != nil {
				t.Fatal(err)
			}
			native := &preparedScratchNative{rootFile: rootFile, root: root, diagnostic: &preparedCaptureDiagnostic{t: t}}
			h.base.Root = root
			h.base.Parent = root
			h.helper.Verifier.Roots = []NativeDescriptor{root}
			h.helper.Native = native
			oldPath := filepath.Join(rootPath, "original.txt")
			newPath := filepath.Join(rootPath, "prepared.txt")
			for _, path := range []string{oldPath, newPath} {
				if err := os.WriteFile(path, []byte("original main stream"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if fixture.ads {
				if err := os.WriteFile(oldPath+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			oldFile, err := OpenMutation(oldPath)
			if err != nil {
				t.Fatal(err)
			}
			defer oldFile.Close()
			newFile, err := OpenMutation(newPath)
			if err != nil {
				t.Fatal(err)
			}
			defer newFile.Close()
			if fixture.sacl != "" {
				user, err := windows.GetCurrentProcessToken().GetTokenUser()
				if err != nil {
					t.Fatal(err)
				}
				sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "G:SYD:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FR;;;WD)" + fixture.sacl)
				if err != nil {
					t.Fatal(err)
				}
				// Fixture initialization ONLY. Restoration always uses the unchanged
				// native BackupWrite full security stream implementation.
				if err := Privileged(h.ctx, []string{"SeSecurityPrivilege", "SeRestorePrivilege"}, func() error {
					handle, err := Reopen(windows.Handle(oldFile.Fd()), windows.WRITE_DAC|windows.WRITE_OWNER|windows.ACCESS_SYSTEM_SECURITY)
					if err != nil {
						return err
					}
					defer windows.CloseHandle(handle)
					return windows.SetKernelObjectSecurity(handle, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.SACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|windows.PROTECTED_SACL_SECURITY_INFORMATION, sd)
				}); err != nil {
					t.Fatal(err)
				}
			}
			original := h.capture(oldFile)
			prepared := h.capture(newFile)
			if original.Target.FileID == prepared.Target.FileID {
				t.Fatal("fixture did not allocate a new FILE_ID_128")
			}
			// A helper-signed capture is not itself a prepared registration.
			request := h.base
			request.Action = "restore_original"
			request.Target = prepared.Target
			request.CaptureProofID = &original.Proof.RecordID
			request.PreparedObjectID = &prepared.Proof.RecordID
			request.ExpectedCurrentMetadataHash = &prepared.MetadataDigest
			request.ExpectedCurrentContentHash = &prepared.ContentDigest
			if _, err := h.execute(h.attested(request), newFile, &original.Proof); err == nil || native.restores != 0 {
				t.Fatal("unregistered prepared native dispatch", err)
			}
			if err := h.channel.ApplyOriginal(h.ctx, newFile, original); err != nil {
				t.Fatal("authorized prepared channel full restore", err)
			}
			if native.restores != 1 {
				t.Fatal("native restore not exactly once")
			}
			var restore Ticket
			for _, ticket := range h.tickets {
				if ticket.Action == "restore_original" {
					restore = ticket
				}
			}
			record, err := h.store.loadCapture(original.Proof)
			if err != nil {
				t.Fatal(err)
			}
			native.diagnostic.statusExpected = record.Snapshot
			native.diagnostic.statusFile = newFile
			native.diagnostic.statusPhase = "before-store-reopen"
			native.diagnostic.checkpoint("before-existing-direct-Matches", newFile)
			if err := Matches(WithBlobs(h.ctx, h.store), newFile, record.Snapshot); err != nil {
				t.Fatal("full original matrix not exact", err)
			}
			native.diagnostic.checkpoint("after-existing-direct-Matches", newFile)
			actual, err := preparedNativeDescriptor(newFile)
			if err != nil {
				t.Fatal(err)
			}
			if actual.FileID != prepared.Target.FileID || actual.FileID == original.Target.FileID || actual.CreationTime != original.Target.CreationTime {
				t.Fatal("native prepared identity/creation not exact")
			}
			for i := 0; i < 2; i++ {
				func() {
					phase := fmt.Sprintf("retry-%d-before-attest", i)
					native.diagnostic.retryCheckpoint(phase, newFile, true)
					beforeCalls := [5]int{native.describes, native.observes, native.captures, native.outcomes, native.restores}
					oldFault := h.store.config.Fault
					oldRegistered := h.helper.Verifier.RegisteredChallenge
					defer func() { h.store.config.Fault = oldFault; h.helper.Verifier.RegisteredChallenge = oldRegistered }()
					// Reuse existing write-fault/registered-challenge seams with no
					// injection, extra file data read, or changed cached-result path.
					h.store.config.Fault = func(step string) error {
						native.diagnostic.retryCheckpoint(phase+"/"+step, newFile, false)
						if oldFault != nil {
							return oldFault(step)
						}
						return nil
					}
					h.helper.Verifier.RegisteredChallenge = func(ticket Ticket) (string, error) {
						native.diagnostic.retryCheckpoint(phase+"/before-registered-challenge", newFile, true)
						stage, err := oldRegistered(ticket)
						native.diagnostic.retryCheckpoint(phase+"/after-registered-challenge", newFile, true)
						return stage, err
					}
					retry := restore
					retry.Nonce = ""
					retry = h.attested(retry)
					phase = fmt.Sprintf("retry-%d-after-attest-before-execute", i)
					native.diagnostic.retryCheckpoint(phase, newFile, true)
					result, err := h.execute(retry, newFile, &original.Proof)
					phase = fmt.Sprintf("retry-%d-after-execute", i)
					native.diagnostic.retryCheckpoint(phase, newFile, true)
					afterCalls := [5]int{native.describes, native.observes, native.captures, native.outcomes, native.restores}
					t.Logf("prepared.retry index=%d NativeCountsOrder=describe-observe-capture-outcome-restore before=%v after=%v zeroAdditionalNativeIO=%t", i, beforeCalls, afterCalls, beforeCalls == afterCalls)
					if err != nil || result.State != "completed" || native.restores != 1 || beforeCalls != afterCalls {
						t.Fatal("native retry re-observed or repeated mutation", err)
					}
				}()
			}
			config := h.store.config
			native.diagnostic.checkpoint("before-store-close", newFile)
			if err := h.store.Close(); err != nil {
				t.Fatal(err)
			}
			native.diagnostic.checkpoint("after-store-close-before-open", newFile)
			reopened, err := NewProtectedStore(config)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			h.store = reopened
			h.helper.Store = reopened
			h.helper.Verifier.RegisteredChallenge = reopened.RegisteredStage
			native.diagnostic.statusPhase = "after-store-open"
			native.diagnostic.checkpoint("after-store-open-before-status", newFile)
			if err := h.channel.MatchesOriginal(h.ctx, newFile, original); err != nil {
				t.Fatal("reopened strict original association", err)
			}
			if fixture.ads {
				if err := verifyPreparedFixtureADS(h.ctx, native, newFile, []byte("[ZoneTransfer]\r\nZoneId=3\r\n")); err != nil {
					t.Fatal("prepared actual ADS bytes/live metadata verification", err)
				}
			}
		})
	}
	if !strings.EqualFold(hex.EncodeToString(before), hex.EncodeToString(nativeTokenPrivileges(t))) {
		t.Fatal("native channel leaked process privileges")
	}
}
