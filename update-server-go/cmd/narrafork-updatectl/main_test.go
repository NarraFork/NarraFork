package main

import "testing"

func TestChannelForVersion(t *testing.T) {
	cases := map[string]string{
		"1.2.0":        "stable",
		"1.2.1":        "stable",
		"1.2.0-beta.1": "beta",
	}
	for version, expected := range cases {
		if got := channelForVersion(version); got != expected {
			t.Fatalf("channelForVersion(%q)=%q, want %q", version, got, expected)
		}
	}
}

func TestFilteredUploadEntries(t *testing.T) {
	all := filteredUploadEntries("")
	if len(all) != 7 {
		t.Fatalf("expected all platforms, got %d", len(all))
	}
	linux := filteredUploadEntries("linux-x64")
	if len(linux) != 1 || linux[0].platformID != "linux-x64" {
		t.Fatalf("unexpected linux-x64 filter: %#v", linux)
	}
	darwin := filteredUploadEntries("darwin-arm64")
	if len(darwin) != 1 || darwin[0].suffix != "macos-arm64" || darwin[0].platformID != "darwin-arm64" {
		t.Fatalf("unexpected darwin-arm64 filter: %#v", darwin)
	}
	windows := filteredUploadEntries("windows-x64")
	if len(windows) != 1 || windows[0].platformID != "win-x64" {
		t.Fatalf("unexpected windows-x64 filter: %#v", windows)
	}
}

func TestGoTarget(t *testing.T) {
	goos, goarch, ext := goTarget("windows-x64")
	if goos != "windows" || goarch != "amd64" || ext != ".exe" {
		t.Fatalf("unexpected windows target: %s %s %s", goos, goarch, ext)
	}
	goos, goarch, ext = goTarget("linux-arm64")
	if goos != "linux" || goarch != "arm64" || ext != "" {
		t.Fatalf("unexpected linux-arm64 target: %s %s %s", goos, goarch, ext)
	}
	goos, goarch, ext = goTarget("macos-x64")
	if goos != "darwin" || goarch != "amd64" || ext != "" {
		t.Fatalf("unexpected macos-x64 target: %s %s %s", goos, goarch, ext)
	}
	if canonicalBuildPlatformName("linux-amd64") != "linux-x64" {
		t.Fatalf("expected linux-amd64 to normalize to linux-x64")
	}
}
