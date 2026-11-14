package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLicenseAttachmentMatchesLockedOriginalSources(t *testing.T) {
	if runtime.Version() != "go1.26.1" {
		t.Fatal("license provenance requires pinned Go 1.26.1")
	}
	root := filepath.Join("..", "..")
	cache, err := moduleCache()
	if err != nil {
		t.Fatal(err)
	}
	sources, modules, err := collect(root, cache, runtime.GOROOT())
	if err != nil {
		t.Fatal(err)
	}
	generated, err := render(sources, modules)
	if err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(root, "..", "licenses", "extra")
	actual, err := readBounded(filepath.Join(extra, attachment))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, generated) {
		t.Fatal("attachment differs from locked upstream source bytes; review changes, then run go run ./internal/licensebundle")
	}
	if len(actual) >= maxBytes {
		t.Fatalf("attachment exceeds release metadata budget: %d", len(actual))
	}
	sums, err := os.ReadFile(filepath.Join(root, "go.sum"))
	if err != nil {
		t.Fatal(err)
	}
	var entries []struct {
		Name           string `json:"name"`
		Version        string `json:"version"`
		License        string `json:"license"`
		Author         string `json:"author"`
		Repository     string `json:"repository"`
		TextFile       string `json:"textFile"`
		DistributedVia string `json:"distributedVia"`
	}
	data, err := os.ReadFile(filepath.Join(extra, "entries.json"))
	if err != nil || json.Unmarshal(data, &entries) != nil {
		t.Fatal("cannot parse license entries")
	}
	for _, mod := range modules {
		if !bytes.Contains(sums, []byte(mod.path+" "+mod.version+" h1:")) {
			t.Errorf("module has no locked source digest: %s %s", mod.path, mod.version)
		}
		found := 0
		for _, entry := range entries {
			if entry.Name == mod.path+" (remote-peer)" {
				found++
				meta, err := metadata(mod.path)
				if err != nil || entry.Version != strings.TrimPrefix(mod.version, "v") || entry.License != meta.license || entry.Author == "" || entry.Repository != meta.repository || entry.TextFile != attachment || !strings.Contains(entry.DistributedVia, "independent remote-peer") {
					t.Errorf("incomplete independent disclosure: %+v", entry)
				}
			}
		}
		if found != 1 {
			t.Errorf("expected one independent disclosure for %s, got %d", mod.path, found)
		}
	}
	goFound := false
	for _, entry := range entries {
		if entry.Name == "Go standard library (remote-peer)" && entry.Version == "1.26.1" && entry.TextFile == attachment && strings.Contains(entry.DistributedVia, "independent remote-peer") {
			goFound = true
		}
	}
	if !goFound {
		t.Fatal("missing independent peer Go standard-library disclosure")
	}
}

func TestLicenseDeduplicationRetainsDifferentAttribution(t *testing.T) {
	sources := []source{
		{module: "first", text: []byte("Copyright Alice\n")},
		{module: "second", text: []byte("Copyright Alice\n")},
		{module: "third", text: []byte("Copyright Bob\n")},
	}
	data, err := render(sources, nil)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(data, []byte("----- BEGIN VERBATIM -----")) != 2 || !bytes.Contains(data, []byte("Verbatim text: see Source 1")) || !bytes.Contains(data, []byte("Copyright Bob")) {
		t.Fatal("deduplication lost distinct attribution or duplicated identical bytes")
	}
	if _, err := render([]source{{text: bytes.Repeat([]byte("x"), maxBytes)}}, nil); err == nil {
		t.Fatal("oversized attachment accepted")
	}
}
