# Go backend production image for NarraFork.
# This runtime image uses local prebuilt assets in go_backend/container_assets/.
# Build/update those assets with:
#   bun run build
#   cp -R dist/frontend/. go_backend/container_assets/frontend/
#   (cd go_backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags "-s -w" -o container_assets/narrafork-go ./cmd/narrafork-go)

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		curl \
		dtach \
		git \
		procps \
		ripgrep \
		unzip \
		xz-utils \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY go_backend/container_assets/narrafork-go /app/narrafork-go
COPY go_backend/container_assets/frontend /app/dist/frontend

ENV HOST=0.0.0.0 \
	PORT=7778 \
	NARRAFORK_FRONTEND_DIR=/app/dist/frontend \
	PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN mkdir -p /root/.narrafork /root/projects \
	&& chmod +x /app/narrafork-go
VOLUME ["/root/.narrafork"]
EXPOSE 7778

CMD ["/app/narrafork-go"]
