# Independent remote-peer builds. Never writes to the main application's dist/.
# Release callers provide VERSION, COMMIT and BUILD_TIME from their pinned inputs.
.DEFAULT_GOAL := build
GO_VERSION := 1.26.1
GO := go
BINARY := narrafork-remote-peer
PKG := ./cmd/remote-peer
DIST := dist
MODULE := narrafork/remote-peer
VERSION ?= dev
COMMIT ?= unknown
BUILD_TIME ?= unknown
LDFLAGS := -s -w \
	-X $(MODULE)/internal/buildinfo.Version=$(VERSION) \
	-X $(MODULE)/internal/buildinfo.Commit=$(COMMIT) \
	-X $(MODULE)/internal/buildinfo.BuildTime=$(BUILD_TIME)
BUILDFLAGS := -trimpath -buildvcs=false -ldflags "$(LDFLAGS)"
BUILDENV := GOTOOLCHAIN=go$(GO_VERSION) CGO_ENABLED=0 GOAMD64=v1 GOARM64=v8.0
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

.PHONY: build dist test vet licenses check-toolchain
check-toolchain:
	@test "$$(GOTOOLCHAIN=go$(GO_VERSION) $(GO) env GOVERSION)" = "go$(GO_VERSION)" || \
		{ printf '%s\n' 'remote-peer requires Go $(GO_VERSION)'; exit 1; }
	@test "$$(GOTOOLCHAIN=go$(GO_VERSION) $(GO) list -m -f '{{.GoVersion}}')" = "$(GO_VERSION)" || \
		{ printf '%s\n' 'remote-peer go.mod must match Go $(GO_VERSION)'; exit 1; }

build: check-toolchain
	@mkdir -p "$(DIST)"
	$(BUILDENV) $(GO) build $(BUILDFLAGS) -o "$(DIST)/$(BINARY)$(shell $(GO) env GOEXE)" $(PKG)

dist: check-toolchain
	@mkdir -p "$(DIST)"
	@set -eu; for platform in $(PLATFORMS); do \
		os=$${platform%/*}; arch=$${platform#*/}; \
		ext=""; if [ "$$os" = windows ]; then ext=".exe"; fi; \
		out="$(DIST)/$(BINARY)-$$os-$$arch$$ext"; \
		printf 'building %s\n' "$$out"; \
		$(BUILDENV) GOOS=$$os GOARCH=$$arch $(GO) build $(BUILDFLAGS) -o "$$out" $(PKG); \
	done

test: check-toolchain
	$(BUILDENV) $(GO) test ./...

vet: check-toolchain
	$(BUILDENV) $(GO) vet ./...

# After a dependency bump: regenerate the license attachment and sync entries.json versions.
# A new or removed module still needs a reviewed manual edit; the sync script refuses it.
licenses: check-toolchain
	$(BUILDENV) $(GO) run ./internal/licensebundle
	./scripts/sync-license-entries.sh
