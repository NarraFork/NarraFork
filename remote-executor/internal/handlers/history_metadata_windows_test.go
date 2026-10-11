//go:build windows

package handlers

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

func TestWindowsProductionNeverAcceptsClientSecuritySnapshot(t *testing.T) {
	// This is the real production decoder, not a separate test verifier. Even a
	// syntactically valid raw v2 snapshot staged in history CAS is not authority.
	fields := map[string]string{}
	for _, name := range []string{"owner", "group", "dacl", "sacl", "label", "specialSecurity", "times", "attributes", "ea", "streams", "singleLink", "ordinaryFile"} {
		fields[name] = "captured_exact"
	}
	fields["specialSecurity"] = "known_absent"
	snapshot := windowsbackup.Snapshot{Version: 2, Platform: "windows", Matrix: "ordinary-file-v2", Security: make([]byte, 20), Manifest: fields, Streams: []windowsbackup.Stream{}}
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeHistoryMetadata(context.Background(), data); err == nil {
		t.Fatal("client self-relative SD reached a privileged restore adapter")
	}
	legacy, _ := json.Marshal(historyWindowsBackup{Version: 1, Platform: "windows", Security: "O:SYG:SYD:P(A;;FA;;;WD)", Label: "S:", Audit: "S:", Attributes: 128})
	if _, err := decodeHistoryMetadata(context.Background(), legacy); err == nil {
		t.Fatal("legacy v1 was upgraded from current rights")
	}
}
