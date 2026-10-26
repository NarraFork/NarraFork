#!/bin/sh
# Rebuild kernels.wasm (needs clang >= 15 with the wasm32 target and wasm-ld).
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -msimd128 -nostdlib -ffreestanding -fno-builtin \
	-Wl,--no-entry -Wl,--import-memory -Wl,--initial-memory=2097152 -Wl,--max-memory=4294967296 \
	-Wl,-z,stack-size=65536 -Wl,--export-dynamic \
	-o kernels.wasm kernels.c
ls -l kernels.wasm
