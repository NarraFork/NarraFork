package updateserver

import (
	"strconv"
	"strings"
)

type parsedVersion struct {
	major      int
	minor      int
	patch      int
	prerelease []string
}

func parseVersion(version string) parsedVersion {
	version = strings.TrimSpace(version)
	core := version
	if idx := strings.IndexByte(core, '+'); idx >= 0 {
		core = core[:idx]
	}
	pre := ""
	if idx := strings.IndexByte(core, '-'); idx >= 0 {
		pre = core[idx+1:]
		core = core[:idx]
	}
	parts := strings.Split(core, ".")
	parsed := parsedVersion{}
	if len(parts) > 0 {
		parsed.major = parseLeadingInt(parts[0])
	}
	if len(parts) > 1 {
		parsed.minor = parseLeadingInt(parts[1])
	}
	if len(parts) > 2 {
		parsed.patch = parseLeadingInt(parts[2])
	}
	if pre != "" {
		parsed.prerelease = strings.Split(pre, ".")
	}
	return parsed
}

func parseLeadingInt(value string) int {
	value = strings.TrimSpace(value)
	end := 0
	for end < len(value) && value[end] >= '0' && value[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0
	}
	n, err := strconv.Atoi(value[:end])
	if err != nil {
		return 0
	}
	return n
}

func CompareVersions(a, b string) int {
	pa := parseVersion(a)
	pb := parseVersion(b)
	if pa.major != pb.major {
		if pa.major > pb.major {
			return 1
		}
		return -1
	}
	if pa.minor != pb.minor {
		if pa.minor > pb.minor {
			return 1
		}
		return -1
	}
	if pa.patch != pb.patch {
		if pa.patch > pb.patch {
			return 1
		}
		return -1
	}
	if len(pa.prerelease) == 0 && len(pb.prerelease) == 0 {
		return 0
	}
	if len(pa.prerelease) == 0 {
		return 1
	}
	if len(pb.prerelease) == 0 {
		return -1
	}
	for i := 0; i < len(pa.prerelease) || i < len(pb.prerelease); i++ {
		if i >= len(pa.prerelease) {
			return -1
		}
		if i >= len(pb.prerelease) {
			return 1
		}
		ai := pa.prerelease[i]
		bi := pb.prerelease[i]
		aNum, aIsNum := parsePrereleaseIdentifier(ai)
		bNum, bIsNum := parsePrereleaseIdentifier(bi)
		switch {
		case aIsNum && bIsNum:
			if aNum != bNum {
				if aNum > bNum {
					return 1
				}
				return -1
			}
		case aIsNum != bIsNum:
			if aIsNum {
				return -1
			}
			return 1
		default:
			if ai != bi {
				if ai > bi {
					return 1
				}
				return -1
			}
		}
	}
	return 0
}

func parsePrereleaseIdentifier(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return n, true
}

func IsNewerVersion(a, b string) bool {
	return CompareVersions(a, b) > 0
}
