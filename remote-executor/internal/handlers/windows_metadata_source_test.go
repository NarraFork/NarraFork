package handlers

import (
	"os"
	"strings"
	"testing"
)

// These guards run on non-Windows builders too. Native fixture tests are still
// required: a source guard is not evidence that Windows ACLs were restored.
func TestWindowsAttachmentMetadataPreflightBeforePublication(t *testing.T) {
	data, err := os.ReadFile("attachment_creation.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	start := strings.Index(text, "if method == \"attachment.commit\" {")
	text = text[start:]
	end := strings.Index(text, "if method == \"attachment.cleanup\" {")
	text = text[:end]
	capture := strings.Index(text, "captureHistoryMetadata(ctx, preparedFile)")
	publish := strings.Index(text, "publishAttachmentPrepared(preparedFile, target)")
	if capture < 0 || publish < 0 || capture > publish {
		t.Fatal("metadata capability/prepared snapshot must be captured before exclusive publication")
	}
}
func TestWindowsHistoricalRestoreDoesNotUseReplacePreparation(t *testing.T) {
	data, err := os.ReadFile("history_metadata_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "m.native.apply(file)") || !strings.Contains(text, ".channel.ApplyOriginal") || !strings.Contains(text, "windowsbackup.DecodeDescriptor") {
		t.Fatal("historical restore must install and verify the stored full security descriptor")
	}
}
func TestWindowsHistoryMutationDoesNotReclaimPathUnderPrivilege(t *testing.T) {
	data, err := os.ReadFile("history_restore_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	start := strings.Index(text, "func quarantineHistoryOriginal")
	end := strings.Index(text, "func publishHistoryNoReplace")
	if strings.Contains(text[start:end], "openConditionalWindowsFile(file.Name()") {
		t.Fatal("quarantine must use the originally authorized identity handle, not open by path again")
	}
}
