#!/usr/bin/env bash
# 编译静态链接的 zstd 二进制（musl libc）
# 支持 linux-x64 / linux-arm64；windows-arm64 走固定 llvm-mingw 交叉编译
# 使用 podman + Alpine 容器编译
#
# 用法:
#   ./scripts/build-zstd-static.sh              # 编译两个架构
#   ./scripts/build-zstd-static.sh x64          # 编译 linux-x64
#   ./scripts/build-zstd-static.sh arm64        # 编译 linux-arm64（交叉编译）
#   ./scripts/build-zstd-static.sh all          # 编译两个 Linux 架构
#   ./scripts/build-zstd-static.sh windows-arm64 # 同时获取原生 rg，交叉编译 zstd
# Windows 产物位于 dist/helpers/windows-arm64/；不上传。代理用 --ssh-host=HOST。

set -euo pipefail

ZSTD_VERSION="1.5.7"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/vendor/zstd"
# Linux 构建默认继承调用者的代理环境；ZSTD_BUILD_PROXY 可覆盖代理（空值强制直连）。
PROXY_ARGS=()
for name in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY; do
  if [[ -v "$name" ]]; then
    PROXY_ARGS+=(-e "$name=${!name}")
  fi
done
if [[ -v ZSTD_BUILD_PROXY ]]; then
  for name in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY; do
    PROXY_ARGS+=(-e "$name=$ZSTD_BUILD_PROXY")
  done
fi

mkdir -p "$OUTPUT_DIR"

# 原生编译 x64（在 x64 Alpine 容器中直接编译）
build_x64() {
  echo "=== 编译 zstd v${ZSTD_VERSION} for x64 (native) ==="

  podman run --rm \
    --platform linux/amd64 \
    -v "$OUTPUT_DIR:/output:z" \
    "${PROXY_ARGS[@]}" \
    docker.io/library/alpine:latest \
    sh -c "
      set -ex

      apk add --no-cache gcc musl-dev make curl file

      curl -fsSL -o zstd-${ZSTD_VERSION}.tar.gz \
        https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz
      tar xzf zstd-${ZSTD_VERSION}.tar.gz
      cd zstd-${ZSTD_VERSION}

      CFLAGS='-static -O2' LDFLAGS='-static' make -j\$(nproc) zstd-release

      description=\$(file -b programs/zstd)
      case \"\$description\" in
        *'ELF 64-bit'*'x86-64'*) ;;
        *) echo \"错误: 预期 x86-64 ELF，实际为 \$description\" >&2; exit 1 ;;
      esac
      ./programs/zstd --version

      cp programs/zstd /output/zstd-linux-x64
      chmod +x /output/zstd-linux-x64
      echo '=== 编译完成: zstd-linux-x64 ==='
    "

  echo "产出: $OUTPUT_DIR/zstd-linux-x64"
  ls -lh "$OUTPUT_DIR/zstd-linux-x64"
  file "$OUTPUT_DIR/zstd-linux-x64"
}

# 交叉编译 arm64（在 x64 Alpine 容器中使用 aarch64 交叉编译工具链）
build_arm64() {
  echo "=== 编译 zstd v${ZSTD_VERSION} for arm64 (cross-compile) ==="

  podman run --rm \
    --platform linux/amd64 \
    -v "$OUTPUT_DIR:/output:z" \
    "${PROXY_ARGS[@]}" \
    docker.io/library/alpine:latest \
    sh -c "
      set -ex

      apk add --no-cache make curl file

      # 下载 musl.cc 提供的 aarch64-linux-musl 交叉编译工具链
      TOOLCHAIN_URL='https://musl.cc/aarch64-linux-musl-cross.tgz'
      curl -fsSL -o toolchain.tgz \"\$TOOLCHAIN_URL\"
      tar xzf toolchain.tgz -C /opt
      export PATH=\"/opt/aarch64-linux-musl-cross/bin:\$PATH\"

      # 验证工具链
      aarch64-linux-musl-gcc --version

      curl -fsSL -o zstd-${ZSTD_VERSION}.tar.gz \
        https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz
      tar xzf zstd-${ZSTD_VERSION}.tar.gz
      cd zstd-${ZSTD_VERSION}

      # 使用 aarch64-linux-musl 交叉编译器，静态链接
      CC=aarch64-linux-musl-gcc \
      CFLAGS='-static -O2' \
      LDFLAGS='-static' \
      make -j\$(nproc) zstd-release

      description=\$(file -b programs/zstd)
      case \"\$description\" in
        *'ELF 64-bit'*'ARM aarch64'*) ;;
        *) echo \"错误: 预期 ARM64 ELF，实际为 \$description\" >&2; exit 1 ;;
      esac

      cp programs/zstd /output/zstd-linux-arm64
      chmod +x /output/zstd-linux-arm64
      echo '=== 编译完成: zstd-linux-arm64 ==='
    "

  echo "产出: $OUTPUT_DIR/zstd-linux-arm64"
  ls -lh "$OUTPUT_DIR/zstd-linux-arm64"
  file "$OUTPUT_DIR/zstd-linux-arm64"
}

TARGET="${1:-all}"
if [[ "$TARGET" == "windows-arm64" ]]; then
  shift
  exec bun "$SCRIPT_DIR/prepare-windows-arm64-helpers.ts" "$@"
fi

case "$TARGET" in
  x64)
    build_x64
    ;;
  arm64)
    build_arm64
    ;;
  all)
    build_x64
    build_arm64
    ;;
  *)
    echo "用法: $0 [x64|arm64|all|windows-arm64 [--ssh-host=HOST]]"
    exit 1
    ;;
esac

echo ""
echo "=== 全部完成 ==="
ls -lh "$OUTPUT_DIR"/zstd-linux-* 2>/dev/null || true
