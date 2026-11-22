import { beforeAll, expect, test } from "bun:test";
import { url } from "node:inspector";
import { Hono } from "hono";
import { app } from "../../app";
import { db } from "../../db";
import { users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { createToken } from "../../lib/auth";
import { generateId } from "../../lib/id";
import { diagnosticsRoutes } from "../diagnostics";

const path = "/api/diagnostics/cpu-profile";
const router = new Hono().route("/api/diagnostics", diagnosticsRoutes);
router.onError((error, c) => buildAppErrorResponse(error, c) ?? c.text("Internal error", 500));
let adminToken: string;
let userToken: string;

beforeAll(async () => {
	async function token(role: "admin" | "user") {
		const id = generateId();
		await db.insert(users).values({
			id,
			username: id,
			role,
			passwordHash: "fixture",
			createdAt: new Date().toISOString(),
		});
		return createToken(id);
	}
	adminToken = await token("admin");
	userToken = await token("user");
});

function post(body: BodyInit, token?: string, signal?: AbortSignal): RequestInit {
	const headers = {
		"Content-Type": "application/json",
		...(token && { Authorization: `Bearer ${token}` }),
	};
	return { method: "POST", headers, body, signal };
}

test("the standalone router rejects missing sessions and non-admin sessions", async () => {
	expect((await router.request(path, post("{}"))).status).toBe(401);
	expect((await router.request(path, post("{}", userToken))).status).toBe(403);
});

test("malformed JSON, invalid durations, and excess streamed bytes are rejected", async () => {
	for (const body of [
		"{",
		"null",
		"[]",
		'{"durationMs":"25"}',
		'{"durationMs":0}',
		'{"durationMs":1.5}',
		'{"durationMs":30001}',
	]) {
		expect((await router.request(path, post(body, adminToken))).status).toBe(400);
	}
	const oversized = " ".repeat(1025);
	const request = post(oversized, adminToken);
	const headers = new Headers(request.headers);
	headers.set("Content-Length", String(oversized.length));
	expect((await router.request(path, { ...request, headers })).status).toBe(413);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(600));
			controller.enqueue(new Uint8Array(600));
			controller.close();
		},
	});
	expect((await router.request(path, post(stream, adminToken))).status).toBe(413);
});

test("the mounted route downloads a usable profile, without opening an inspector listener", async () => {
	const recording = app.request(path, post('{"durationMs":750}', adminToken));
	const deadline = Date.now() + 500;
	let concurrent: Response;
	do {
		concurrent = await app.request(path, post('{"durationMs":20}', adminToken));
	} while (concurrent.status !== 409 && Date.now() < deadline);
	function burnFixtureCpu() {
		const end = Date.now() + 150;
		while (Date.now() < end) Math.random();
	}
	burnFixtureCpu();
	const response = await recording;
	expect(concurrent.status).toBe(409);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(response.headers.get("content-disposition")).toMatch(
		/^attachment; filename="cpu-\d+\.cpuprofile"$/,
	);
	const profile = await response.json();
	expect(profile.nodes.length).toBeGreaterThan(0);
	expect(profile.samples.length).toBeGreaterThan(0);
	expect(profile.timeDeltas).toHaveLength(profile.samples.length);
	expect(profile.endTime).toBeGreaterThan(profile.startTime);
	const nodes = new Set(profile.nodes.map((node: { id: number }) => node.id));
	expect(profile.samples.every((id: number) => nodes.has(id))).toBe(true);
	expect(url()).toBeUndefined();
});

test("a real HTTP disconnect releases a running capture and concurrent POSTs get 409", async () => {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 10, fetch: app.fetch });
	const controller = new AbortController();
	const endpoint = new URL(path, server.url);
	const pending = fetch(endpoint, post('{"durationMs":30000}', adminToken, controller.signal));
	const result = pending.catch((error: unknown) => error);
	async function pollFor(status: number) {
		const deadline = Date.now() + 2_000;
		let actual: number;
		do {
			const response = await fetch(
				endpoint,
				post('{"durationMs":20}', adminToken, AbortSignal.timeout(1000)),
			);
			actual = response.status;
			await response.text();
			if (actual === status) break;
			await Bun.sleep(10);
		} while (Date.now() < deadline);
		expect(actual).toBe(status);
	}
	try {
		await pollFor(409);
		controller.abort();
		expect(await result).toMatchObject({ name: "AbortError" });
		await pollFor(200);
	} finally {
		controller.abort();
		void server.stop(true);
		await result;
	}
});
