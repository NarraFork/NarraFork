package windowsbackup

import (
	"encoding/json"
	"fmt"
	"sort"
)

// This is a TEST diagnostic only. It never prints SD/EA/ADS data, stream names,
// tickets, proofs or keys, and does not alter any snapshot or comparison policy.
func redactedSnapshotDiagnostic(expected, current *Snapshot) []string {
	result := []string{
		fmt.Sprintf("policy: expected(version=%d platform=%q matrix=%q) current(version=%d platform=%q matrix=%q)", expected.Version, expected.Platform, expected.Matrix, current.Version, current.Platform, current.Matrix),
		fmt.Sprintf("Security: equal=%t expected(len=%d sha256=%s) current(len=%d sha256=%s)", Digest(expected.Security) == Digest(current.Security), len(expected.Security), Digest(expected.Security), len(current.Security), Digest(current.Security)),
		fmt.Sprintf("Attributes: equal=%t expected=0x%08x current=0x%08x", expected.Attributes == current.Attributes, expected.Attributes, current.Attributes),
		fmt.Sprintf("Creation: equal=%t expected=%d current=%d", expected.Creation == current.Creation, expected.Creation, current.Creation),
		fmt.Sprintf("LastAccess: equal=%t expected=%d current=%d", expected.LastAccess == current.LastAccess, expected.LastAccess, current.LastAccess),
		fmt.Sprintf("LastWrite: equal=%t expected=%d current=%d", expected.LastWrite == current.LastWrite, expected.LastWrite, current.LastWrite),
		fmt.Sprintf("EA: equal=%t expected(len=%d sha256=%s) current(len=%d sha256=%s)", Digest(expected.EA) == Digest(current.EA), len(expected.EA), Digest(expected.EA), len(current.EA), Digest(current.EA)),
	}
	streams := func(s *Snapshot) (string, int) {
		items := append([]Stream(nil), s.Streams...)
		sort.Slice(items, func(i, j int) bool {
			if items[i].Name != items[j].Name {
				return items[i].Name < items[j].Name
			}
			if items[i].Digest != items[j].Digest {
				return items[i].Digest < items[j].Digest
			}
			return items[i].Size < items[j].Size
		})
		// Hash only the complete sorted manifest; its names/data never enter output.
		encoded, _ := json.Marshal(items)
		return Digest(encoded), len(encoded)
	}
	a, al := streams(expected)
	b, bl := streams(current)
	result = append(result, fmt.Sprintf("Streams: equal=%t expected(count=%d manifestLen=%d manifestSha256=%s) current(count=%d manifestLen=%d manifestSha256=%s)", a == b, len(expected.Streams), al, a, len(current.Streams), bl, b))
	keys := make(map[string]bool, len(expected.Manifest)+len(current.Manifest))
	for k := range expected.Manifest {
		keys[k] = true
	}
	for k := range current.Manifest {
		keys[k] = true
	}
	ordered := make([]string, 0, len(keys))
	for k := range keys {
		ordered = append(ordered, k)
	}
	sort.Strings(ordered)
	for _, k := range ordered {
		e, ep := expected.Manifest[k]
		c, cp := current.Manifest[k]
		result = append(result, fmt.Sprintf("Manifest[%s]: equal=%t expected(present=%t state=%q) current(present=%t state=%q)", k, ep == cp && e == c, ep, e, cp, c))
	}
	// Separately observed evidence, not an identity or restorable-field exclusion.
	result = append(result, fmt.Sprintf("observation.ChangeTime: expected=%d current=%d", expected.ChangeTime, current.ChangeTime), fmt.Sprintf("observation.ReadAccessAfter: expected=%d current=%d", expected.ReadAccessAfter, current.ReadAccessAfter))
	return result
}
