import { describe, expect, test } from "bun:test";
import type { BusinessSocket } from "@shared/remote-access/business-transport";
import { resetAppBaseForTest } from "./base-path";
import { buildWsUrl, safeCloseWs } from "./ws";
import { withSocketTimers } from "./ws-test-utils";

interface GlobalPatch {
	key: string;
	had: boolean;
	previous: unknown;
}

describe("safeCloseWs", () => {
	for (const outcome of ["pending", "open", "closed"] as const) {
		test(`bounds disposal when handshake is ${outcome}`, () => {
			withSocketTimers((fire) => {
				let closes = 0;
				const socket = {
					readyState: 0,
					close: () => closes++,
					onopen: null as (() => void) | null,
					onclose: null as (() => void) | null,
				};
				safeCloseWs(socket as unknown as BusinessSocket);
				if (outcome === "open") {
					socket.readyState = 1;
					socket.onopen?.();
				} else if (outcome === "closed") {
					socket.readyState = 3;
					socket.onclose?.();
				}
				fire(1000);
				expect(closes).toBe(outcome === "closed" ? 0 : 1);
				expect(socket.onopen).toBeNull();
			});
		});
	}
	test("accepts a missing socket", () => safeCloseWs(null));
});

function patchGlobal(key: string, value: unknown): GlobalPatch {
	const globals = globalThis as Record<string, unknown>;
	const patch = { key, had: Object.hasOwn(globals, key), previous: globals[key] };
	globals[key] = value;
	return patch;
}

function restoreGlobal(patch: GlobalPatch): void {
	const globals = globalThis as Record<string, unknown>;
	if (patch.had) globals[patch.key] = patch.previous;
	else delete globals[patch.key];
}

function withBrowserLocation(
	location: { protocol: string; hostname: string; host: string; port: string },
	baseURI: string,
	fn: () => void,
): void {
	const patches = [
		patchGlobal("window", { location }),
		patchGlobal("location", { ...location, href: `${location.protocol}//${location.host}/` }),
		patchGlobal("document", { baseURI }),
		patchGlobal("__DEV_VITE_PORT__", "41221"),
		patchGlobal("__DEV_BACKEND_PORT__", "7778"),
	];
	resetAppBaseForTest();
	try {
		fn();
	} finally {
		resetAppBaseForTest();
		for (const patch of patches.reverse()) restoreGlobal(patch);
	}
}

describe("buildWsUrl", () => {
	test("keeps a remote host, secure protocol, and mount prefix even in serve mode", () => {
		withBrowserLocation(
			{
				protocol: "https:",
				hostname: "nf.example.com",
				host: "nf.example.com",
				port: "",
			},
			"https://nf.example.com/nf/",
			() => {
				expect(buildWsUrl("/ws/narrator", "token=test")).toBe(
					"wss://nf.example.com/nf/ws/narrator?token=test",
				);
			},
		);
	});

	test("still bypasses the broken proxy for direct local Vite access", () => {
		withBrowserLocation(
			{
				protocol: "http:",
				hostname: "localhost",
				host: "localhost:41221",
				port: "41221",
			},
			"http://localhost:41221/",
			() => {
				expect(buildWsUrl("/ws/terminal")).toBe("ws://localhost:7778/ws/terminal");
			},
		);
	});
});
