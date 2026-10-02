# Cross-compilation matrix for the NarraFork remote executor.
# Produces single-file binaries (CGO disabled) under dist/.
# Darwin calls system libSystem for ACL handling; CGO-disabled does not mean
# a fully static binary on every platform.
#
#   make build          # build for the host platform
#   make dist           # build all platforms
#   make test           # run tests

BINARY := narrafork-executor
PKG := ./cmd/narrafork-executor
DIST := dist
MODULE := github.com/narrafork/remote-executor
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || printf dev)
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || printf unknown)
BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w \
	-X $(MODULE)/internal/buildinfo.Version=$(VERSION) \
	-X $(MODULE)/internal/buildinfo.Commit=$(COMMIT) \
	-X $(MODULE)/internal/buildinfo.BuildTime=$(BUILD_TIME)
BUILDFLAGS := -trimpath -ldflags "$(LDFLAGS)"

# os/arch pairs. Linux binaries are statically linked with CGO disabled;
# Darwin and Windows rely on the target OS's native system libraries.
PLATFORMS := \
	linux/amd64 \
	linux/arm64 \
	darwin/amd64 \
	darwin/arm64 \
	windows/amd64 \
	windows/arm64

.PHONY: build
build:
	CGO_ENABLED=0 go build $(BUILDFLAGS) -o $(BINARY) $(PKG)

.PHONY: test
test:
	go test ./...

.PHONY: vet
vet:
	go vet ./...

.PHONY: dist
dist:
	@mkdir -p $(DIST)
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; arch=$${platform#*/}; \
		ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
		out="$(DIST)/$(BINARY)-$$os-$$arch$$ext"; \
		echo "→ building $$out"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build $(BUILDFLAGS) -o $$out $(PKG) || exit 1; \
	done
	@echo "✓ all platforms built under $(DIST)/"

.PHONY: clean
clean:
	rm -rf $(DIST) $(BINARY)
