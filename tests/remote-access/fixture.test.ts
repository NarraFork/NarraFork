import { afterEach, describe, expect, test } from "bun:test";
import { startFixture } from "../../remote-prototype/fixture";

let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
afterEach(() => {
	fixture?.stop();
	fixture = undefined;
});

describe("private isolated backend fixture", () => {
	test("every endpoint including auth is protected by bridge capability", async () => {
		fixture = await startFixture();
		expect((await fetch(`${fixture.bridgeUrl}/api/auth/me`)).status).toBe(401);
		expect(
			(
				await fetch(`${fixture.bridgeUrl}/api/projects`, {
					headers: { Authorization: `Bearer ${fixture.adminToken}` },
				})
			).status,
		).toBe(401);
		const headers = {
			"X-NarraFork-Bridge": fixture.bridgeSecret,
			Authorization: `Bearer ${fixture.adminToken}`,
		};
		expect((await fetch(`${fixture.bridgeUrl}/api/projects`, { headers })).status).toBe(200);
	});
	test("admin and ordinary user tokens are distinct and revocable", async () => {
		fixture = await startFixture();
		const headers = {
			"X-NarraFork-Bridge": fixture.bridgeSecret,
			Authorization: `Bearer ${fixture.userToken}`,
		};
		expect((await fetch(`${fixture.bridgeUrl}/api/auth/me`, { headers })).status).toBe(200);
		expect((await fetch(`${fixture.bridgeUrl}/api/projects`, { headers })).status).toBe(403);
		fixture.revoke(fixture.userToken);
		expect((await fetch(`${fixture.bridgeUrl}/api/auth/me`, { headers })).status).toBe(401);
	});
	test("login JSON rejects oversized body before unbounded text collection", async () => {
		fixture = await startFixture();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(5000));
				controller.close();
			},
		});
		const response = await fetch(`${fixture.bridgeUrl}/api/auth/login`, {
			method: "POST",
			headers: { "X-NarraFork-Bridge": fixture.bridgeSecret },
			body,
		});
		expect(response.status).toBe(413);
	});
	test("upload hashes incrementally and binary/SSE streams remain cancelable", async () => {
		fixture = await startFixture();
		const headers = {
			"X-NarraFork-Bridge": fixture.bridgeSecret,
			Authorization: `Bearer ${fixture.adminToken}`,
		};
		const response = await fetch(`${fixture.bridgeUrl}/api/upload`, {
			method: "POST",
			headers,
			body: new Uint8Array(100).fill(97),
		});
		const result = (await response.json()) as { bytes: number; sha256: string };
		expect(result.bytes).toBe(100);
		expect(result.sha256).toHaveLength(64);
		const head = await fetch(`${fixture.bridgeUrl}/api/echo`, { method: "HEAD", headers });
		expect(head.status).toBe(204);
		expect(head.body).toBeNull();
		const stream = await fetch(`${fixture.bridgeUrl}/api/events?repeat=16`, { headers });
		const reader = stream.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.read();
		await reader?.cancel();
	});
});
