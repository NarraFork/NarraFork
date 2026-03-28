FROM debian:bookworm-slim

# ── 代理配置（构建时可选传入）─────────────────────────────
ARG HTTP_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"
ENV http_proxy=$HTTP_PROXY \
    https_proxy=$HTTP_PROXY \
    HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTP_PROXY \
    no_proxy=$NO_PROXY \
    NO_PROXY=$NO_PROXY

# ── 系统依赖 ──────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # 必需
    git curl ca-certificates bash procps \
    # PTY / 终端
    dtach \
    # 搜索
    ripgrep \
    # 原生模块编译
    python3 make g++ \
    # 容器支持（可选）
    podman podman-compose \
    # Chromium（WebFetch screenshot）+ 字体
    chromium fonts-noto-cjk fonts-noto-color-emoji \
    # 杂项
    xz-utils unzip \
    && rm -rf /var/lib/apt/lists/*

# 让 puppeteer 使用系统 chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ── 安装 Bun ─────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# ── 项目依赖（利用层缓存）────────────────────────────────
WORKDIR /app
COPY package.json bun.lock ./
ARG NPM_REGISTRY="https://registry.npmjs.org"
RUN echo '[install]' > bunfig.toml && \
    echo "registry = \"${NPM_REGISTRY}\"" >> bunfig.toml && \
    bun install --frozen-lockfile --ignore-scripts && \
    cd node_modules/esbuild && node install.js

# ── 复制源码 + 构建前端 ──────────────────────────────────
COPY . .
RUN bun run build

# ── 数据目录 + 端口 ──────────────────────────────────────
RUN mkdir -p /root/.narrafork
EXPOSE 7779

# ── 取消代理（运行时不需要）───────────────────────────────
ENV http_proxy="" https_proxy="" HTTP_PROXY="" HTTPS_PROXY=""

CMD ["bun", "run", "start"]
