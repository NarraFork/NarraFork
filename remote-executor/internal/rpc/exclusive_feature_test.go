package rpc

import (
	"encoding/json"
	"testing"
)

func TestCapabilitiesAdvertiseExclusiveCreation(t *testing.T) {
	bytes, err := json.Marshal(Capabilities{})
	if err != nil {
		t.Fatal(err)
	}
	var decoded Capabilities
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{FeatureFsMkdirExclusiveV1, FeatureFsCreateBoundParentV1} {
		found := false
		for _, feature := range decoded.Features {
			if feature == required {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("exclusive creation feature %q was not advertised", required)
		}
	}
}
