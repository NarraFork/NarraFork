package handlers

import (
	"context"
	"strings"
	"testing"
)

func TestNativeWindowsPathFreeze(t *testing.T) {
	cases := []struct{ base, input, want, kind string }{
		{`D:\work`, `D:foo`, `D:\work\foo`, "drive-relative"},
		{`D:\work`, `\foo`, `D:\foo`, "root-relative"},
		{`D:\work`, `..\Unicode 空格\文件.txt`, `D:\Unicode 空格\文件.txt`, "relative"},
		{`D:\work`, `C:\full\file`, `C:\full\file`, "drive-absolute"},
		{`D:\work`, `\\server\share\Unicode 空格\file`, `\\server\share\Unicode 空格\file`, "unc-absolute"},
		{`D:\work`, `\\?\C:\Unicode 空格\` + strings.Repeat("x", 300), `\\?\C:\Unicode 空格\` + strings.Repeat("x", 300), "extended-drive-absolute"},
		{`D:\work`, `\\?\UNC\server\share\文档\file`, `\\?\UNC\server\share\文档\file`, "extended-unc-absolute"},
		{`\\server\share\work`, `\foo`, `\\server\share\foo`, "root-relative"},
	}
	for _, c := range cases {
		t.Run(c.kind+c.input, func(t *testing.T) {
			got, kind, err := freezeWindowsPath(c.base, c.input)
			if err != nil || got != c.want || kind != c.kind {
				t.Fatalf("got (%q,%q,%v), want (%q,%q)", got, kind, err, c.want, c.kind)
			}
		})
	}
	_, _, err := freezeWindowsPath(`D:\work`, `C:foo`)
	if err == nil || !strings.Contains(err.Error(), "AMBIGUOUS_DRIVE_RELATIVE") {
		t.Fatalf("cross-drive ambiguity: %v", err)
	}
	for _, base := range []string{`D:work`, `\work`, `work`, "/linux/controller/cwd"} {
		if _, _, err := freezeWindowsPath(base, "file"); err == nil {
			t.Errorf("accepted nonqualified base %q", base)
		}
	}
}

func TestNativeWindowsPathRejectsSpecialTargets(t *testing.T) {
	for _, input := range []string{
		`C:\file:stream`, `C:\file::$DATA`, `C:\NUL.txt`, `C:\COM1`, `C:\COM¹.log`, `C:\LPT²`, `C:\CONIN$`,
		`\\.\pipe\name`, `\\?\GLOBALROOT\Device\HarddiskVolume1\file`, `\??\C:\file`,
		`\\?\C:\a\..\file`, `\\?\C:\literal.`, `C:\name `, `C:\folder\*.txt`, `\\server`,
		"C:\\nul\x00file", "C:\\control\nfile", strings.Repeat("a", nativePathCodeUnitsLimit+1),
	} {
		if _, _, err := freezeWindowsPath(`D:\work`, input); err == nil {
			t.Errorf("accepted forbidden target %q", input)
		}
	}
	// Names are not trimmed, folded, or normalized to another Unicode spelling.
	got, _, err := freezeWindowsPath(`D:\work`, ` leading space\é.txt`)
	if err != nil || got != `D:\work\ leading space\é.txt` {
		t.Fatalf("changed valid name: %q %v", got, err)
	}
}

func TestNativePathV2RejectsUnknownFieldsBeforeIO(t *testing.T) {
	h := New(NewPathGuard(nil), 1<<20)
	if _, err := h.FsResolvePathV2(context.Background(), map[string]any{"inputPath": `D:\file`, "baseCwd": `D:\work`, "operation": "create", "guessCase": false}); err == nil {
		t.Fatal("unknown v2 field accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.FsResolvePathV2(ctx, map[string]any{}); err != context.Canceled {
		t.Fatalf("cancel ignored: %v", err)
	}
	if _, err := h.FsResolvePathV2(context.Background(), map[string]any{"inputPath": strings.Repeat("界", 30000), "baseCwd": `D:\work`, "operation": "create"}); err == nil || !strings.Contains(err.Error(), "PATH_BODY_LIMIT") {
		t.Fatalf("UTF8 body ceiling not enforced: %v", err)
	}
}
