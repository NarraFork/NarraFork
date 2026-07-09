# Cross-compilation matrix for the NarraFork remote executor.
# Produces static, single-file binaries (CGO disabled) under dist/.
#
#   make build          # build for the host platform
#   make dist           # build all platforms
#   make test           # run tests

BINARY := narrafork-executor
PKG := ./cmd/narrafork-executor
DIST := dist
LDFLAGS := -s -w
BUILDFLAGS := -trimpath -ldflags "$(LDFLAGS)"

# os/arch pairs. Same-arch binaries are portable across distros because they are
# statically linked with CGO disabled.
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
