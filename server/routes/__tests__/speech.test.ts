import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechSettings } from "@shared/speech";
import { Hono } from "hono";
import { ZodError } from "zod";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "nf-speech-routes-"));
process.env.NARRAFORK_HOME = home;
const { AppError } = await import("../../lib/errors");
const { createSpeechRoutes } = await import("../speech");
const { SpeechService } = await import("../../services/speech/service");
const config = (): SpeechSettings => ({
	enabled: true,
	defaultAsrProviderId: "p",
	defaultTtsProviderId: "p",
	providers: [
		{
			id: "p",
			name: "Speech",
			enabled: true,
			baseUrl: "https://upstream.invalid/v1",
			apiKey: "top-secret",
			asr: { protocol: "chat-completions-asr", model: "asr", streaming: true },
			tts: { protocol: "openai-speech", model: "tts", voice: "test", format: "pcm16" },
		},
	],
});
let calls = 0;
const service = () =>
	new SpeechService(config, {
		getCapabilities: (p) => ({
			id: p.id,
			name: p.name,
			asr: { realtimeInput: false, textStreaming: true },
		}),
		async *transcribe() {
			calls++;
			yield { type: "delta", text: "你好" };
			yield { type: "done", text: "你好" };
		},
		async synthesize() {
			calls++;
			return {
				metadata: { format: "pcm16", mimeType: "audio/pcm", sampleRate: 24000, channels: 1 },
				audio: (async function* () {
					yield new Uint8Array([1, 2, 3, 4]);
				})(),
			};
		},
	});
function app(role: "admin" | "user" | "anonymous" = "admin", speech = service()) {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		if (role !== "anonymous")
			c.set("user", {
				sub: role,
				sid: "verified-session",
				role,
				iat: 0,
				exp: Number.MAX_SAFE_INTEGER,
			});
		await next();
	});
	instance.onError((e) =>
		Response.json(
			{ code: e instanceof AppError ? e.code : "INVALID" },
			{ status: e instanceof AppError ? e.statusCode : e instanceof ZodError ? 400 : 500 },
		),
	);
	instance.route("/speech", createSpeechRoutes(speech));
	return instance;
}
afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

test("private admin boundary rejects normal user and unauthenticated access", async () => {
	const before = calls;
	for (const role of ["user", "anonymous"] as const) {
		for (const url of ["capabilities", "transcriptions", "synthesis"]) {
			const response = await app(role).request(`/speech/${url}`, {
				method: url === "capabilities" ? "GET" : "POST",
			});
			expect(response.status).toBe(role === "anonymous" ? 401 : 403);
		}
	}
	expect(calls).toBe(before);
});

test("capabilities omit connection and credential data", async () => {
	const response = await app().request("/speech/capabilities");
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).not.toContain("top-secret");
	expect(text).not.toContain("upstream.invalid");
});

test("raw audio produces unified JSON or text SSE", async () => {
	const instance = app();
	const init = {
		method: "POST",
		headers: { "content-type": "audio/wav" },
		body: new Uint8Array([1]),
	};
	const response = await instance.request("/speech/transcriptions", init);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ text: "你好" });
	const streaming = await instance.request("/speech/transcriptions?stream=true", init);
	expect(streaming.headers.get("content-type")).toBe("text/event-stream");
	const text = await streaming.text();
	expect(text).toContain("event: delta");
	expect(text).toContain("event: done");
	expect(text).not.toContain("event: error");
	// Both requests finished: the same actor can be admitted again.
	expect((await instance.request("/speech/transcriptions", init)).status).toBe(200);
});

test("synthesis returns binary with PCM playback metadata and no-store", async () => {
	const response = await app().request("/speech/synthesis", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "hello" }),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-audio-sample-rate")).toBe("24000");
	expect(response.headers.get("x-audio-channels")).toBe("1");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("rejects request-controlled endpoints and credentials without contacting adapter", async () => {
	const before = calls;
	const response = await app().request("/speech/synthesis", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "hello", baseUrl: "http://127.0.0.1", apiKey: "secret" }),
	});
	expect(response.status).toBe(400);
	expect(calls).toBe(before);
});

test("HTTP audio consumption owns admission and cancellation releases it", async () => {
	const instance = app();
	const init = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "hello" }),
	};
	const first = await instance.request("/speech/synthesis", init);
	expect(first.status).toBe(200);
	expect((await instance.request("/speech/synthesis", init)).status).toBe(429);
	await first.body?.cancel();
	const next = await instance.request("/speech/synthesis", init);
	expect(next.status).toBe(200);
	await next.arrayBuffer();
});

test("failed bodies release capacity and do not echo private JSON", async () => {
	const instance = app();
	const invalid = await instance.request("/speech/synthesis", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: '{"private-unclosed',
	});
	expect(invalid.status).toBe(400);
	expect(await invalid.text()).not.toContain("private-unclosed");
	const large = await instance.request("/speech/transcriptions", {
		method: "POST",
		headers: { "content-type": "audio/wav", "content-length": "20000000" },
		body: "x",
	});
	expect(large.status).toBe(413);
	const good = await instance.request("/speech/transcriptions", {
		method: "POST",
		headers: { "content-type": "audio/wav" },
		body: "x",
	});
	expect(good.status).toBe(200);
	await good.text();
});
