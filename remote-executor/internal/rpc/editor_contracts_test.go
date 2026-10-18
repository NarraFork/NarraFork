package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/narrafork/remote-executor/internal/handlers"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The fixture lives with the TS mirror; the executor module is tested from the
// repository checkout (CI and local), so a missing file is a hard failure.
func loadEditorGolden(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "editor-provider-contracts.golden.json"))
	if err != nil {
		t.Fatalf("read shared golden fixture: %v", err)
	}
	var cases map[string]json.RawMessage
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("decode golden fixture: %v", err)
	}
	return cases
}

// roundTrip strictly decodes into T (unknown or misspelled fields fail) and
// proves json.Marshal reproduces the fixture: required-null fields must encode
// as null and optional-omitted fields must stay absent.
func roundTrip[T any](t *testing.T, name string, raw json.RawMessage) T {
	t.Helper()
	var value T
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("%s: strict decode: %v", name, err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("%s: encode: %v", name, err)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("%s: wire shape drifted\nwant %s\n got %s", name, raw, encoded)
	}
	return value
}

func TestEditorContractGoldenFixture(t *testing.T) {
	g := loadEditorGolden(t)
	checked := map[string]func(json.RawMessage){
		"capabilitiesNone": func(raw json.RawMessage) {
			if caps := roundTrip[EditorProviderCapabilities](t, "capabilitiesNone", raw); caps != (EditorProviderCapabilities{}) {
				t.Fatalf("no-capability fixture must be all false: %+v", caps)
			}
		},
		"capabilitiesLocalV1": func(raw json.RawMessage) {
			want := EditorProviderCapabilities{BoundedRead: true, V1Save: true}
			if caps := roundTrip[EditorProviderCapabilities](t, "capabilitiesLocalV1", raw); caps != want {
				t.Fatalf("local v1 capabilities: %+v", caps)
			}
		},
		"capabilitiesBoundedRead": func(raw json.RawMessage) {
			want := EditorProviderCapabilities{BoundedRead: true}
			if caps := roundTrip[EditorProviderCapabilities](t, "capabilitiesBoundedRead", raw); caps != want {
				t.Fatalf("bounded-read capabilities: %+v", caps)
			}
		},
		"identityPosix":       func(raw json.RawMessage) { roundTrip[EditorResourceIdentity](t, "identityPosix", raw) },
		"rawReadOpen":         func(raw json.RawMessage) { roundTrip[EditorRawReadOpen](t, "rawReadOpen", raw) },
		"rawReadChunkRequest": func(raw json.RawMessage) { roundTrip[EditorRawReadChunkRequest](t, "rawReadChunkRequest", raw) },
		"rawReadChunkEof":     func(raw json.RawMessage) { roundTrip[EditorRawReadChunk](t, "rawReadChunkEof", raw) },
		"rawReadClose":        func(raw json.RawMessage) { roundTrip[EditorRawReadClose](t, "rawReadClose", raw) },
		"stageOpen":           func(raw json.RawMessage) { roundTrip[EditorStageOpen](t, "stageOpen", raw) },
		"stageHandle":         func(raw json.RawMessage) { roundTrip[EditorStageHandle](t, "stageHandle", raw) },
		"stageAppend":         func(raw json.RawMessage) { roundTrip[EditorStageAppend](t, "stageAppend", raw) },
		"stageSeal":           func(raw json.RawMessage) { roundTrip[EditorStageSeal](t, "stageSeal", raw) },
		"stageAbort":          func(raw json.RawMessage) { roundTrip[EditorStageAbort](t, "stageAbort", raw) },
		"queryRequest":        func(raw json.RawMessage) { roundTrip[EditorQueryRequest](t, "queryRequest", raw) },
		"watchOpen":           func(raw json.RawMessage) { roundTrip[EditorWatchOpen](t, "watchOpen", raw) },
		"watchHandle":         func(raw json.RawMessage) { roundTrip[EditorWatchHandle](t, "watchHandle", raw) },
		"watchNotify":         func(raw json.RawMessage) { roundTrip[EditorWatchNotify](t, "watchNotify", raw) },
		"watchClose":          func(raw json.RawMessage) { roundTrip[EditorWatchClose](t, "watchClose", raw) },
		"rawReadPreflight": func(raw json.RawMessage) {
			if v := roundTrip[EditorRawReadPreflight](t, "rawReadPreflight", raw); v.Identity.CanonicalPath != `C:\repo\pkg\file.ts` {
				t.Fatalf("Windows canonical path changed: %q", v.Identity.CanonicalPath)
			}
		},
		"applyCreate": func(raw json.RawMessage) {
			if v := roundTrip[EditorApplyRequest](t, "applyCreate", raw); v.ExpectedRawHash != nil {
				t.Fatal("create must carry an explicit null expectedRawHash")
			}
		},
		"applyReplace": func(raw json.RawMessage) {
			if v := roundTrip[EditorApplyRequest](t, "applyReplace", raw); v.ExpectedRawHash == nil {
				t.Fatal("replace must carry expectedRawHash")
			}
		},
		"applyCommitted": func(raw json.RawMessage) {
			if v := roundTrip[EditorApplyResult](t, "applyCommitted", raw); v.Error != nil || v.TotalBytes == nil || *v.TotalBytes != 3 {
				t.Fatalf("committed result: %+v", v)
			}
		},
		"applyUncertain": func(raw json.RawMessage) {
			if v := roundTrip[EditorApplyResult](t, "applyUncertain", raw); v.RawDigest != nil || v.TotalBytes != nil || v.Error == nil {
				t.Fatalf("uncertain result must keep null proof and an error: %+v", v)
			}
		},
		"queryNotFound": func(raw json.RawMessage) {
			if v := roundTrip[EditorQueryResult](t, "queryNotFound", raw); v.Result != nil || v.Outcome != "not_found" {
				t.Fatalf("not_found result: %+v", v)
			}
		},
		"queryCommitted": func(raw json.RawMessage) {
			if v := roundTrip[EditorQueryResult](t, "queryCommitted", raw); v.Result == nil || v.Result.Error != nil {
				t.Fatalf("committed query: %+v", v)
			}
		},
		"enums": func(raw json.RawMessage) {
			var enums map[string][]string
			if err := json.Unmarshal(raw, &enums); err != nil {
				t.Fatalf("enums: %v", err)
			}
			for name, values := range map[string][]string{
				"pathFlavors":       EditorPathFlavors,
				"stageAbortReasons": EditorStageAbortReasons,
				"metadataPolicies":  EditorMetadataPolicies,
				"applyOutcomes":     EditorApplyOutcomes,
				"queryOutcomes":     EditorQueryOutcomes,
				"watchReasons":      EditorWatchReasons,
				"errors":            EditorProviderErrors,
			} {
				if !reflect.DeepEqual(enums[name], values) {
					t.Fatalf("enum %s drifted: fixture %v, Go %v", name, enums[name], values)
				}
			}
			if len(enums) != 7 {
				t.Fatalf("unexpected enum set: %v", enums)
			}
		},
	}
	for name := range g {
		if checked[name] == nil {
			t.Fatalf("fixture case %q has no Go type check", name)
		}
	}
	for name, check := range checked {
		raw, ok := g[name]
		if !ok {
			t.Fatalf("fixture is missing case %q", name)
		}
		check(raw)
	}
}

// Only implemented editor features may be advertised; frozen future contracts
// alone must not enable write, stage, query, or watch capabilities.
func TestEditorContractsAdvertiseImplementedFeaturesOnly(t *testing.T) {
	encoded, err := json.Marshal(Capabilities{})
	if err != nil {
		t.Fatal(err)
	}
	var caps Capabilities
	if err := json.Unmarshal(encoded, &caps); err != nil {
		t.Fatal(err)
	}
	for _, feature := range caps.Features {
		if strings.HasPrefix(feature, "editor.") && feature != FeatureEditorRawReadV1 {
			t.Fatalf("executor advertises an unimplemented editor feature: %s", feature)
		}
	}
	if !containsFeature(caps.Features, FeatureEditorRawReadV1) {
		t.Fatal("implemented raw-read feature missing")
	}
	d := NewDispatcher(handlers.New(handlers.NewPathGuard(nil), 1024))
	defer d.CloseEditorReads()
	for _, method := range []string{"editor.read.open", "editor.read.chunk", "editor.read.close"} {
		_, err := d.Dispatch(context.Background(), method, nil, nil)
		if err != nil && strings.Contains(err.Error(), "unknown method") {
			t.Fatal("advertised method has no handler", method)
		}
	}
}
