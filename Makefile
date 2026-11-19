VERSION ?= auto
BUN ?= $(if $(wildcard dist/build-runtime-bun-1.4.3/package/bin/bun),dist/build-runtime-bun-1.4.3/package/bin/bun,bun)
ARCHIVE_DIR ?= /home/project/narrafork

.PHONY: build-alpha
# Full local diagnostic build with the next alpha version.
# Override VERSION, BUN or ARCHIVE_DIR as needed.
build-alpha:
	@"$(BUN)" scripts/build-alpha.ts "$(VERSION)" "$(ARCHIVE_DIR)"
