//go:build windows

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

type historyWindowsBackup struct {
	Version    int    `json:"version"`
	Platform   string `json:"platform"`
	Security   string `json:"security"`
	Label      string `json:"label"`
	Audit      string `json:"audit"`
	Attributes uint32 `json:"attributes"`
}
type historyWindowsMetadata struct {
	native     *windowsConditionalMetadata
	attributes uint32
}

func captureHistoryMetadata(ctx context.Context, file *os.File) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m, err := captureWindowsMetadata(file, true)
	if err != nil {
		return nil, err
	}
	// A hidden/unreadable SACL cannot be reconstructed from a mode-only backup.
	if m.audit == nil {
		return nil, fmt.Errorf("native_backup_incomplete: audit SACL requires readable security privilege")
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return nil, err
	}
	return json.Marshal(historyWindowsBackup{1, "windows", m.sd.String(), m.label.String(), m.audit.String(), info.FileAttributes})
}
func decodeHistoryMetadata(ctx context.Context, data []byte) (conditionalMetadata, error) {
	if len(data) > 512<<10 {
		return nil, fmt.Errorf("native metadata budget")
	}
	var b historyWindowsBackup
	if err := json.Unmarshal(data, &b); err != nil {
		return nil, err
	}
	if b.Version != 1 || b.Platform != "windows" || b.Audit == "" || b.Security == "" || b.Label == "" {
		return nil, fmt.Errorf("incomplete Windows security backup")
	}
	sd, err := windows.SecurityDescriptorFromString(b.Security)
	if err != nil {
		return nil, err
	}
	label, err := windows.SecurityDescriptorFromString(b.Label)
	if err != nil {
		return nil, err
	}
	audit, err := windows.SecurityDescriptorFromString(b.Audit)
	if err != nil {
		return nil, err
	}
	m := &windowsConditionalMetadata{sd: sd, label: label, audit: audit}
	m.owner, _, err = sd.Owner()
	if err != nil {
		return nil, err
	}
	m.group, _, err = sd.Group()
	if err != nil {
		return nil, err
	}
	m.control, _, err = sd.Control()
	if err != nil {
		return nil, err
	}
	m.auditControl, _, err = audit.Control()
	if err != nil {
		return nil, err
	}
	m.dacl, err = descriptorACL(sd, false)
	if err != nil {
		return nil, err
	}
	m.labelACL, err = descriptorACL(label, true)
	if err != nil {
		return nil, err
	}
	m.auditACL, err = descriptorACL(audit, true)
	if err != nil {
		return nil, err
	}
	return &historyWindowsMetadata{m, b.Attributes}, nil
}
func (m *historyWindowsMetadata) apply(file *os.File) error {
	if err := m.native.apply(file); err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(file.Name())
	if err != nil {
		return err
	}
	return windows.SetFileAttributes(name, m.attributes)
}
func (m *historyWindowsMetadata) matches(file *os.File) error {
	if err := m.native.matches(file); err != nil {
		return err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return err
	}
	if info.FileAttributes != m.attributes {
		return errConditionalMetadataChanged
	}
	return nil
}
func historyMetadataWithMode(ctx context.Context, data []byte, mode uint32) ([]byte, error) {
	if mode != 0444 && mode != 0666 {
		return nil, fmt.Errorf("Windows restore mode must be readonly/writable")
	}
	if _, err := decodeHistoryMetadata(ctx, data); err != nil {
		return nil, err
	}
	var b historyWindowsBackup
	json.Unmarshal(data, &b)
	if mode == 0444 {
		b.Attributes |= windows.FILE_ATTRIBUTE_READONLY
	} else {
		b.Attributes &^= windows.FILE_ATTRIBUTE_READONLY
	}
	return json.Marshal(b)
}
