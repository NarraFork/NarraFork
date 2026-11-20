import { describe, expect, test } from "bun:test";
import { isTransientPeerBuildFailure } from "../../scripts/webrtc-prototype";

const proxyDrop = `PEER_BUILD_FAILED: golang.org/x/net@v0.55.0: read "https://proxy.golang.org/golang.org/x/net/@v/v0.55.0.zip": stream error: stream ID 63; INTERNAL_ERROR; received from peer`;

describe("peer build retry", () => {
	test("retries a Go module proxy drop", () => {
		expect(isTransientPeerBuildFailure(new Error(proxyDrop))).toBe(true);
	});

	test("does not retry a compile error, a cancelled start, or an oversized log", () => {
		expect(
			isTransientPeerBuildFailure(
				new Error("PEER_BUILD_FAILED: ./cmd/remote-peer/main.go:10: undefined: foo"),
			),
		).toBe(false);
		expect(isTransientPeerBuildFailure(new Error("STARTUP_CANCELLED"))).toBe(false);
		expect(isTransientPeerBuildFailure(new Error("BUILD_OUTPUT_LIMIT"))).toBe(false);
	});
});
