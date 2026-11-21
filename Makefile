VERSION ?= auto
BUN ?= bun
ARCHIVE_DIR ?= .build-alpha-archive

.PHONY: build-alpha
# Full local diagnostic build with the next alpha version.
# Override VERSION, BUN or ARCHIVE_DIR as needed.
build-alpha:
	@"$(BUN)" scripts/build-alpha.ts "$(VERSION)" "$(ARCHIVE_DIR)"
