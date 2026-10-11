//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Administrator-preinstalled configuration only. This loader never generates a
// production key, trusts a client root or starts/installs an OS service.
type FirstCaptureHelperConfiguration struct {
	Version        int                      `json:"version"`
	Enrollment     FirstCaptureEnrollment   `json:"enrollment"`
	ServiceSID     string                   `json:"serviceSid"`
	SigningKeyFile string                   `json:"signingKeyFile"`
	StoreDirectory string                   `json:"storeDirectory"`
	RootPath       string                   `json:"rootPath"`
	ClientPeer     PeerIdentity             `json:"clientPeer"`
	IssuerPins     []IssuerKeyConfiguration `json:"issuerPins"`
}
type IssuerKeyConfiguration struct {
	Issuer    string `json:"issuer"`
	ServiceID string `json:"serviceId"`
	KeyEpoch  uint64 `json:"keyEpoch"`
	PublicKey string `json:"publicKey"`
}
type FirstCapturePublicPin struct {
	file     *os.File
	raw      []byte
	identity stableReadObjectState
}

func (p *FirstCapturePublicPin) Close() error { return p.file.Close() }
func (p *FirstCapturePublicPin) Check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	state, err := inspectStableReadObject(windows.Handle(p.file.Fd()), ctx)
	if err != nil || state.ID != p.identity.ID || state.Basic.Creation != p.identity.Basic.Creation || state.Basic.Write != p.identity.Basic.Write || state.Basic.Change != p.identity.Basic.Change || state.Basic.Attributes != p.identity.Basic.Attributes {
		return ErrFirstCaptureNotReady
	}
	if err := checkFirstCaptureConfigACL(windows.Handle(p.file.Fd()), false, ""); err != nil {
		return err
	}
	data, err := readFirstCaptureConfigFD(p.file, FirstCapturePublicBytes)
	if err != nil || !bytes.Equal(data, p.raw) {
		return ErrFirstCaptureNotReady
	}
	return ctx.Err()
}
func firstCaptureTrustedSID(sid, service string) bool {
	return sid == "S-1-5-18" || sid == "S-1-5-32-544" || service != "" && sid == service
}
func checkFirstCaptureConfigACL(handle windows.Handle, private bool, service string) error {
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return ErrFirstCaptureNotReady
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !firstCaptureTrustedSID(owner.String(), service) {
		return ErrFirstCaptureNotReady
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return ErrFirstCaptureNotReady
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return ErrFirstCaptureNotReady
	}
	raw := unsafe.Slice((*byte)(unsafe.Pointer(acl)), int(*(*uint16)(unsafe.Add(unsafe.Pointer(acl), 2))))
	if len(raw) < 8 || len(raw) > 64<<10 {
		return ErrFirstCaptureNotReady
	}
	count := int(*(*uint16)(unsafe.Add(unsafe.Pointer(acl), 4)))
	offset := 8
	for i := 0; i < count; i++ {
		if offset+8 > len(raw) {
			return ErrFirstCaptureNotReady
		}
		size := int(*(*uint16)(unsafe.Pointer(&raw[offset+2])))
		if size < 12 || offset+size > len(raw) {
			return ErrFirstCaptureNotReady
		}
		aceType := raw[offset]
		if aceType != 0 && aceType != 1 {
			return ErrFirstCaptureNotReady
		}
		mask := *(*uint32)(unsafe.Pointer(&raw[offset+4]))
		sid := (*windows.SID)(unsafe.Pointer(&raw[offset+8]))
		if !sid.IsValid() || sid.Len() > size-8 {
			return ErrFirstCaptureNotReady
		}
		if aceType == 0 && !firstCaptureTrustedSID(sid.String(), service) {
			// Public material may be read, but never changed by the tool/executor.
			write := uint32(windows.GENERIC_ALL | windows.GENERIC_WRITE | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA | windows.FILE_WRITE_EA | windows.FILE_WRITE_ATTRIBUTES)
			if private && mask != 0 || mask&write != 0 {
				return ErrFirstCaptureNotReady
			}
		}
		offset += size
	}
	return nil
}
func readFirstCaptureConfigFD(file *os.File, limit int64) ([]byte, error) {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > limit {
		return nil, ErrFirstCaptureNotReady
	}
	data, err := io.ReadAll(io.NewSectionReader(file, 0, limit+1))
	if err != nil || int64(len(data)) != info.Size() {
		return nil, ErrFirstCaptureNotReady
	}
	return data, nil
}
func openFirstCaptureProtectedFile(ctx context.Context, path string, private bool, service string) (*FirstCapturePublicPin, error) {
	if !filepath.IsAbs(path) || len(path) > 32767 {
		return nil, ErrFirstCaptureNotReady
	}
	// Every configured ancestor must be an actual directory, not a reparse alias.
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		p, err := windows.UTF16PtrFromString(parent)
		if err != nil {
			return nil, ErrFirstCaptureNotReady
		}
		attr, err := windows.GetFileAttributes(p)
		if err != nil || attr&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || attr&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return nil, ErrFirstCaptureNotReady
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, ErrFirstCaptureNotReady
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ|windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, ErrFirstCaptureNotReady
	}
	file := os.NewFile(uintptr(h), "administrator-first-capture-config")
	fail := func() (*FirstCapturePublicPin, error) { file.Close(); return nil, ErrFirstCaptureNotReady }
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.NumberOfLinks != 1 {
		return fail()
	}
	if checkFirstCaptureConfigACL(h, private, service) != nil {
		return fail()
	}
	raw, err := readFirstCaptureConfigFD(file, FirstCapturePublicBytes)
	if err != nil {
		return fail()
	}
	identity, err := inspectStableReadObject(h, ctx)
	if err != nil {
		return fail()
	}
	return &FirstCapturePublicPin{file, raw, identity}, nil
}
func LoadFirstCaptureEnrollment(ctx context.Context, path string) (FirstCaptureEnrollment, *FirstCapturePublicPin, error) {
	var enrollment FirstCaptureEnrollment
	pin, err := openFirstCaptureProtectedFile(ctx, path, false, "")
	if err != nil {
		return enrollment, nil, err
	}
	if decodeFirstCapture(pin.raw, &enrollment, FirstCapturePublicBytes) != nil || enrollment.Validate() != nil {
		pin.Close()
		return FirstCaptureEnrollment{}, nil, ErrFirstCaptureNotReady
	}
	return enrollment, pin, nil
}
func LoadFirstCaptureHelperConfiguration(ctx context.Context, path string) (FirstCaptureHelperConfiguration, []io.Closer, ed25519.PrivateKey, error) {
	var config FirstCaptureHelperConfiguration
	pin, err := openFirstCaptureProtectedFile(ctx, path, true, "")
	if err != nil {
		return config, nil, nil, err
	}
	if decodeFirstCapture(pin.raw, &config, FirstCapturePublicBytes) != nil || config.Version != 1 || config.Enrollment.Validate() != nil || !strings.HasPrefix(config.ServiceSID, "S-1-5-80-") || config.ClientPeer.PID == 0 || config.ClientPeer.CreationTime == 0 || config.ClientPeer.ServiceSID == "" || config.ClientPeer.ExecutorInstance == "" || len(config.IssuerPins) == 0 || len(config.IssuerPins) > 64 || !filepath.IsAbs(config.StoreDirectory) || !filepath.IsAbs(config.RootPath) {
		pin.Close()
		return FirstCaptureHelperConfiguration{}, nil, nil, ErrFirstCaptureNotReady
	}
	keyPin, err := openFirstCaptureProtectedFile(ctx, config.SigningKeyFile, true, config.ServiceSID)
	if err != nil {
		pin.Close()
		return FirstCaptureHelperConfiguration{}, nil, nil, err
	}
	// The preinstalled private file is a canonical base64url Ed25519 private key.
	// Never print, emit, generate, rotate or copy it into an executor/session.
	key, err := base64.RawURLEncoding.Strict().DecodeString(string(keyPin.raw))
	if err != nil || len(key) != ed25519.PrivateKeySize {
		pin.Close()
		keyPin.Close()
		return FirstCaptureHelperConfiguration{}, nil, nil, ErrFirstCaptureNotReady
	}
	pub := ed25519.PrivateKey(key).Public().(ed25519.PublicKey)
	if base64.RawURLEncoding.EncodeToString(pub) != config.Enrollment.HelperPublicKey {
		pin.Close()
		keyPin.Close()
		return FirstCaptureHelperConfiguration{}, nil, nil, ErrFirstCaptureNotReady
	}
	return config, []io.Closer{pin, keyPin}, ed25519.PrivateKey(key), nil
}
func FirstCaptureIssuerPins(config FirstCaptureHelperConfiguration) ([]IssuerKey, error) {
	var keys []IssuerKey
	for _, p := range config.IssuerPins {
		key, err := base64.RawURLEncoding.Strict().DecodeString(p.PublicKey)
		if err != nil || len(key) != 32 || !validID(p.Issuer, 256) || !validID(p.ServiceID, 256) || p.KeyEpoch > 9007199254740991 {
			return nil, fmt.Errorf("first capture issuer pin unavailable")
		}
		keys = append(keys, IssuerKey{p.Issuer, p.ServiceID, p.KeyEpoch, key})
	}
	return keys, nil
}
