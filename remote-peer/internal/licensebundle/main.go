// Command licensebundle reproduces the peer's independent license attachment.
// Run from remote-peer/: go run ./internal/licensebundle
// It copies local, locked source bytes; it never downloads license templates.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const attachment = "remote-peer-LICENSES.txt"
const maxBytes = 64 * 1024

type module struct{ path, version string }
type attribution struct{ license, author, repository string }
type source struct {
	module, version, upstream, file, license string
	text                                     []byte
}

func metadata(path string) (attribution, error) {
	switch {
	case strings.HasPrefix(path, "github.com/pion/"):
		name := strings.Split(strings.TrimPrefix(path, "github.com/pion/"), "/")[0]
		license := "MIT"
		if name == "stun" || name == "transport" {
			license = "MIT AND BSD-3-Clause"
		}
		return attribution{license, "The Pion community; additional Go Authors notices where indicated", "https://github.com/pion/" + name}, nil
	case strings.HasPrefix(path, "golang.org/x/"):
		return attribution{"BSD-3-Clause", "The Go Authors", "https://github.com/golang/" + strings.TrimPrefix(path, "golang.org/x/")}, nil
	case path == "github.com/coder/websocket":
		return attribution{"ISC", "Coder", "https://github.com/coder/websocket"}, nil
	case path == "github.com/google/uuid":
		return attribution{"BSD-3-Clause", "Google Inc.", "https://github.com/google/uuid"}, nil
	case path == "github.com/wlynxg/anet":
		return attribution{"BSD-3-Clause", "wlynxg; The Go Authors (Android-derived source)", "https://github.com/wlynxg/anet"}, nil
	}
	return attribution{}, fmt.Errorf("unreviewed module: %s", path)
}

func readBounded(path string) ([]byte, error) {
	stat, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > maxBytes {
		return nil, fmt.Errorf("source is not a bounded regular file: %s", path)
	}
	return os.ReadFile(path)
}

func lockedModules(root string) ([]module, error) {
	data, err := readBounded(filepath.Join(root, "go.mod"))
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(data, []byte("\ngo 1.26.1\n")) {
		return nil, errors.New("review standard-library materials when changing Go 1.26.1")
	}
	matches := regexp.MustCompile(`(?m)^\t(\S+) (v\S+)`).FindAllSubmatch(data, -1)
	var modules []module
	for _, m := range matches {
		modules = append(modules, module{string(m[1]), string(m[2])})
	}
	if len(modules) == 0 {
		return nil, errors.New("no locked modules")
	}
	return modules, nil
}

func collect(root, cache, goroot string) ([]source, []module, error) {
	modules, err := lockedModules(root)
	if err != nil {
		return nil, nil, err
	}
	var sources []source
	add := func(mod, version, upstream, base, file, license string, first, last int) error {
		text, err := readBounded(filepath.Join(base, file))
		if err != nil {
			return err
		}
		label := file
		if first > 0 {
			lines := bytes.SplitAfter(text, []byte("\n"))
			if last < first || last > len(lines) {
				return fmt.Errorf("invalid source line range: %s", file)
			}
			text = bytes.Join(lines[first-1:last], nil)
			label += fmt.Sprintf(":%d-%d (verbatim source notice)", first, last)
		}
		sources = append(sources, source{mod, version, upstream, label, license, text})
		return nil
	}
	for _, file := range []string{"LICENSE", "PATENTS"} {
		if err := add("Go standard library", "go1.26.1", "https://github.com/golang/go/tree/go1.26.1", goroot, file, "BSD-3-Clause; PATENTS is the additional IP rights grant", 0, 0); err != nil {
			return nil, nil, err
		}
	}
	// These are part of the actual Go 1.26.1 standard-library source distribution,
	// not the newer x/* modules locked separately in remote-peer/go.mod.
	for _, mod := range []module{
		{"crypto", "v0.46.1-0.20251210140736-7dacc380ba00"},
		{"net", "v0.47.1-0.20251128220604-7c360367ab7e"},
		{"sys", "v0.39.0"}, {"text", "v0.32.0"},
	} {
		for _, file := range []string{"LICENSE", "PATENTS"} {
			if err := add("Go standard-library vendor/golang.org/x/"+mod.path, mod.version, "https://github.com/golang/"+mod.path, goroot, "src/vendor/golang.org/x/"+mod.path+"/"+file, "BSD-3-Clause; PATENTS is the additional IP rights grant", 0, 0); err != nil {
				return nil, nil, err
			}
		}
	}
	if err := add("Go standard library: fiat-crypto generated field/scalar arithmetic", "v0.0.9 (Go 1.26.1)", "https://github.com/mit-plv/fiat-crypto", goroot, "src/crypto/internal/fips140/nistec/fiat/README", "BSD-1-Clause", 0, 0); err != nil {
		return nil, nil, err
	}
	if err := add("Go standard library: fiat-crypto scalar arithmetic", "v0.0.9 (Go 1.26.1)", "https://github.com/mit-plv/fiat-crypto", goroot, "src/crypto/internal/fips140/edwards25519/scalar.go", "BSD-1-Clause", 29, 54); err != nil {
		return nil, nil, err
	}
	for _, notice := range []struct {
		name, file, license string
		first, last         int
	}{
		{"SunPro fdlibm", "src/math/sqrt.go", "LicenseRef-Sun-fdlibm", 12, 19},
		{"Sun fdlibm exponential", "src/math/exp.go", "LicenseRef-Sun-fdlibm", 28, 34},
		{"SunSoft fdlibm", "src/math/cbrt.go", "LicenseRef-Sun-fdlibm", 10, 17},
		{"Cephes Math Library", "src/math/atan.go", "LicenseRef-Cephes", 36, 52},
	} {
		if err := add("Go standard library math: "+notice.name, "Go 1.26.1 source", "https://github.com/golang/go/tree/go1.26.1/src/math", goroot, notice.file, notice.license, notice.first, notice.last); err != nil {
			return nil, nil, err
		}
	}
	for _, mod := range modules {
		meta, err := metadata(mod.path)
		if err != nil {
			return nil, nil, err
		}
		base := filepath.Join(cache, mod.path+"@"+mod.version)
		files, err := os.ReadDir(base)
		if err != nil {
			return nil, nil, err
		}
		licenses := 0
		for _, file := range files {
			name := strings.ToUpper(file.Name())
			if regexp.MustCompile(`^(LICENSE|LICENCE|COPYING|NOTICE|PATENTS)([._-].*)?$`).MatchString(name) {
				if err := add(mod.path, mod.version, meta.repository, base, file.Name(), meta.license, 0, 0); err != nil {
					return nil, nil, err
				}
				if strings.HasPrefix(name, "LICENSE") || strings.HasPrefix(name, "LICENCE") || strings.HasPrefix(name, "COPYING") {
					licenses++
				}
			}
		}
		if licenses == 0 {
			return nil, nil, fmt.Errorf("missing upstream license: %s", mod.path)
		}
		// Root MIT licenses alone do not cover these Go-derived BSD notices.
		var file string
		last := 2
		switch mod.path {
		case "github.com/pion/stun/v4":
			file = "internal/hmac/hmac.go"
		case "github.com/pion/transport/v5":
			file, last = "utils/xor/xor_generic.go", 4
		case "github.com/wlynxg/anet":
			file, last = "netlink_android.go", 3
		}
		if file != "" {
			if err := add(mod.path, mod.version, meta.repository, base, file, "BSD-3-Clause; full Go license reproduced in the Go standard-library section", 1, last); err != nil {
				return nil, nil, err
			}
		}
	}
	return sources, modules, nil
}

func render(sources []source, modules []module) ([]byte, error) {
	var out bytes.Buffer
	fmt.Fprintf(&out, "NarraFork remote-peer: independent distribution third-party materials\n\nScope: Go 1.26.1 standard library (including its bundled vendor packages) and all %d modules required by remote-peer/go.mod, as locked by go.sum.\nThese components are compiled into the separately downloaded remote-peer, not embedded in the NarraFork main executable.\nTest-only modules appearing only in go.sum (testify and yaml) are not linked or distributed.\nCGO is disabled. BoringSSL, Go build tools, Pion test-wasm/examples/testdata are not part of these six peer binaries.\n\nAll license and notice bodies below are copied verbatim from the installed Go 1.26.1 source or locked module source cache. Exact byte-identical materials are explicitly mapped to their first full-text section, without merging different authors or years. SHA-256 identifies each original body or indicated original source-line excerpt.\nThe additional Go-authored Pion and anet notices accompany the complete Go BSD license; the fiat-crypto notices accompany the standard-library notice.\n\nReview note: Pion interceptor/pkg/twcc/arrival_time_map.go declares MIT but describes an adaptation of Chrome/WebRTC. The module supplies no separate WebRTC notice; this upstream attribution question remains subject to review, not a claim of independently verified legal compliance.\n\n", len(modules))
	seen := map[[32]byte]int{}
	for i, source := range sources {
		digest := sha256.Sum256(source.text)
		fmt.Fprintf(&out, "=== Source %d ===\nModule: %s\nVersion: %s\nUpstream: %s\nSource file: %s\nLicense / notice: %s\nSource SHA-256: %x\n", i+1, source.module, source.version, source.upstream, source.file, source.license, digest)
		if first, exists := seen[digest]; exists {
			fmt.Fprintf(&out, "Verbatim text: see Source %d (byte-identical original, including attribution).\n\n", first)
			continue
		}
		seen[digest] = i + 1
		out.WriteString("----- BEGIN VERBATIM -----\n")
		out.Write(source.text)
		out.WriteString("\n----- END VERBATIM -----\n\n")
	}
	if out.Len() >= maxBytes {
		return nil, fmt.Errorf("license attachment is %d bytes; requires reviewed finite split below 64 KiB", out.Len())
	}
	return out.Bytes(), nil
}

func moduleCache() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "env", "GOMODCACHE")
	var out bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &out, remaining: 4096}
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

type limitedWriter struct {
	w         *bytes.Buffer
	remaining int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if len(p) > w.remaining {
		return 0, errors.New("subprocess output exceeds limit")
	}
	w.remaining -= len(p)
	return w.w.Write(p)
}

func main() {
	cache, err := moduleCache()
	if err == nil && runtime.Version() != "go1.26.1" {
		err = errors.New("use the pinned Go 1.26.1 toolchain")
	}
	var data []byte
	var modules []module
	if err == nil {
		var sources []source
		sources, modules, err = collect(".", cache, runtime.GOROOT())
		if err == nil {
			data, err = render(sources, modules)
		}
	}
	if err == nil {
		err = os.WriteFile(filepath.Join("..", "licenses", "extra", attachment), data, 0644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("%s: %d bytes, %d locked dependency modules plus Go standard library\n", attachment, len(data), len(modules))
}
