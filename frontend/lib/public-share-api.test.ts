import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resetAppBaseForTest } from "./base-path";
import {
	buildPublicShareUrl,
	createPublicShareClient,
	linkPublicShareSignals,
	PublicShareError,
	PublicShareSseParser,
	parsePublicShareEvent,
	publicShareExternalHref,
	readPublicShareToken,
} from "./public-share-api";

const credential = "a".repeat(43);
const originals = new Map<string, PropertyDescriptor | undefined>();
function replaceGlobal(key: string, value: unknown) {
	if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
afterEach(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
	resetAppBaseForTest();
});

function noStorage() {
	const forbidden = () => {
		throw new Error("Public requests must not touch login or draft storage");
	};
	replaceGlobal("localStorage", { getItem: forbidden, setItem: forbidden, removeItem: forbidden });
	replaceGlobal("sessionStorage", {
		getItem: forbidden,
		setItem: forbidden,
		removeItem: forbidden,
	});
}

describe("public share cancellation links", () => {
	test("already aborted sources win in input order without adding listeners", () => {
		const first = new AbortController();
		const second = new AbortController();
		const active = new AbortController();
		second.abort("second");
		first.abort("first");
		const add = spyOn(active.signal, "addEventListener");
		try {
			const linked = linkPublicShareSignals([active.signal, first.signal, second.signal]);
			expect(linked.signal.aborted).toBe(true);
			expect(linked.signal.reason).toBe("first");
			expect(add).not.toHaveBeenCalled();
			linked.dispose();
		} finally {
			add.mockRestore();
		}
	});

	test.each([0, 1])("source %s cancels once and removes every listener", (index) => {
		const sources = [new AbortController(), new AbortController()];
		const remove = sources.map(({ signal }) => spyOn(signal, "removeEventListener"));
		try {
			const linked = linkPublicShareSignals([
				sources[0].signal,
				sources[1].signal,
				sources[0].signal,
			]);
			let events = 0;
			linked.signal.addEventListener("abort", () => events++);
			sources[index].abort("first cancellation");
			expect(linked.signal.aborted).toBe(true);
			expect(linked.signal.reason).toBe("first cancellation");
			for (const spy of remove) expect(spy).toHaveBeenCalledTimes(1);
			sources[1 - index].abort("late cancellation");
			linked.dispose();
			expect(events).toBe(1);
			expect(linked.signal.reason).toBe("first cancellation");
			for (const spy of remove) expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			for (const spy of remove) spy.mockRestore();
		}
	});

	test("disposing a completed operation detaches it from its long-lived session", () => {
		const session = new AbortController();
		const linked = linkPublicShareSignals([session.signal]);
		linked.dispose();
		linked.dispose();
		session.abort();
		expect(linked.signal.aborted).toBe(false);
	});
});

describe("anonymous public share fetch boundary", () => {
	test("all operations use only the share API and Share authorization, without cookies or storage", async () => {
		noStorage();
		const calls: { url: string; init: RequestInit }[] = [];
		replaceGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return url.endsWith("/events")
				? new Response('data: {"type":"ping"}\n\n', {
						headers: { "Content-Type": "text/event-stream" },
					})
				: Response.json({});
		});
		const client = createPublicShareClient("share-id", credential);
		const signal = new AbortController().signal;
		await client.session(signal);
		await client.messages(signal, 123, 7);
		await client.discussion(signal, 100);
		await client.tool("tool-1", signal);
		await client.post("hello", "message-1", signal);
		const events: unknown[] = [];
		await client.events(signal, (event) => events.push(event));
		expect(calls.map((call) => call.url)).toEqual([
			"/api/public/narrator-shares/share-id",
			"/api/public/narrator-shares/share-id/messages?limit=50&beforeSeq=123&messageVersion=7",
			"/api/public/narrator-shares/share-id/discussion?limit=50&beforeSeq=100",
			"/api/public/narrator-shares/share-id/tools/tool-1",
			"/api/public/narrator-shares/share-id/discussion",
			"/api/public/narrator-shares/share-id/events",
		]);
		for (const { url, init } of calls) {
			expect(url).not.toContain(credential);
			expect(init.credentials).toBe("omit");
			expect(init.referrerPolicy).toBe("no-referrer");
			expect(init.cache).toBe("no-store");
			expect(init.redirect).toBe("error");
			expect(new Headers(init.headers).get("authorization")).toBe(`Share ${credential}`);
		}
		expect(JSON.parse(calls[4].init.body as string)).toEqual({
			text: "hello",
			replyToMessageId: "message-1",
		});
		expect(events).toEqual([{ type: "ping" }]);
	});

	test("REST and SSE still work when AbortSignal.any is absent", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
		Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
		const calls: string[] = [];
		replaceGlobal("fetch", async (url: string) => {
			calls.push(url);
			return url.endsWith("/events")
				? new Response('data: {"type":"ping"}\n\n', {
						headers: { "Content-Type": "text/event-stream" },
					})
				: Response.json({});
		});
		try {
			const client = createPublicShareClient("share", credential);
			const signal = new AbortController().signal;
			await client.session(signal);
			await client.messages(signal);
			await client.discussion(signal);
			await client.post("hello", undefined, signal);
			await client.tool("tool", signal);
			const events: unknown[] = [];
			await client.events(signal, (event) => events.push(event));
			expect(calls).toHaveLength(6);
			expect(events).toEqual([{ type: "ping" }]);
		} finally {
			if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor);
			else Reflect.deleteProperty(AbortSignal, "any");
		}
	});

	test.each([200, 503])("REST and SSE detach session listeners after HTTP %s", async (status) => {
		const controller = new AbortController();
		const add = spyOn(controller.signal, "addEventListener");
		const remove = spyOn(controller.signal, "removeEventListener");
		replaceGlobal("fetch", async (url: string) =>
			url.endsWith("/events")
				? new Response('data: {"type":"ping"}\n\n', {
						status,
						headers: { "Content-Type": "text/event-stream" },
					})
				: Response.json({}, { status }),
		);
		try {
			const client = createPublicShareClient("share", credential);
			for (const operation of [
				() => client.session(controller.signal),
				() => client.events(controller.signal, () => {}),
			]) {
				if (status === 200) await operation();
				else await expect(operation()).rejects.toBeInstanceOf(PublicShareError);
			}
			expect(add).toHaveBeenCalledTimes(2);
			expect(remove).toHaveBeenCalledTimes(2);
			for (let index = 0; index < 2; index++) {
				expect(remove.mock.calls[index][1]).toBe(add.mock.calls[index][1]);
			}
		} finally {
			add.mockRestore();
			remove.mockRestore();
		}
	});

	test("failure never reads, clears or renews a signed-in token", async () => {
		noStorage();
		for (const status of [401, 403, 404, 410, 429]) {
			replaceGlobal("fetch", async () =>
				Response.json(
					{ code: "SESSION_INVALID" },
					{ status, headers: { "x-narrafork-session-token": "replacement" } },
				),
			);
			try {
				await createPublicShareClient("share-id", credential).session(new AbortController().signal);
				throw new Error("Expected rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(PublicShareError);
				expect((error as PublicShareError).status).toBe(status);
				expect((error as PublicShareError).unavailable).toBe(status !== 429);
			}
		}
	});

	test("basepath applies to both share links and every fetch", async () => {
		replaceGlobal("document", { baseURI: "https://example.test/proxy/7778/" });
		replaceGlobal("location", { href: "https://example.test/proxy/7778/narrators/n" });
		resetAppBaseForTest();
		let called = "";
		replaceGlobal("fetch", async (url: string) => {
			called = url;
			return Response.json({});
		});
		await createPublicShareClient("share-id", credential).session(new AbortController().signal);
		expect(called).toBe("/proxy/7778/api/public/narrator-shares/share-id");
		expect(
			buildPublicShareUrl(
				"share-id",
				credential,
				"https://example.test/proxy/7778/narrators/n?foo=1#old",
			),
		).toBe(`https://example.test/proxy/7778/shared/narrators/share-id#token=${credential}`);
	});

	test("invalid IDs, missing credentials and oversized posts never reach fetch", async () => {
		let calls = 0;
		replaceGlobal("fetch", async () => {
			calls++;
			return Response.json({});
		});
		const signal = new AbortController().signal;
		for (const id of ["../narrators", "x?path=/api", "https://evil.test", "%2F", ""]) {
			await expect(createPublicShareClient(id, credential).session(signal)).rejects.toBeInstanceOf(
				PublicShareError,
			);
		}
		await expect(createPublicShareClient("share", "").session(signal)).rejects.toBeInstanceOf(
			PublicShareError,
		);
		const client = createPublicShareClient("share", credential);
		await expect(client.tool("../files", signal)).rejects.toBeInstanceOf(PublicShareError);
		await expect(client.post("x".repeat(8001), undefined, signal)).rejects.toBeInstanceOf(
			PublicShareError,
		);
		await expect(client.post(" ", undefined, signal)).rejects.toBeInstanceOf(PublicShareError);
		await expect(client.post("text", "../other-room", signal)).rejects.toBeInstanceOf(
			PublicShareError,
		);
		expect(calls).toBe(0);
	});

	test("provider tool IDs may contain colon and dot but cannot become path navigation", async () => {
		let url = "";
		replaceGlobal("fetch", async (input: string) => {
			url = input;
			return Response.json({});
		});
		const client = createPublicShareClient("share", credential);
		const signal = new AbortController().signal;
		await client.tool("provider:call.123", signal);
		expect(url).toBe("/api/public/narrator-shares/share/tools/provider%3Acall.123");
		for (const id of [".", "..", "a/b"])
			await expect(client.tool(id, signal)).rejects.toBeInstanceOf(PublicShareError);
	});

	test("responses are bounded before JSON parsing", async () => {
		let cancelled = false;
		replaceGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(1024 * 1024 + 1));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
		);
		await expect(
			createPublicShareClient("share", credential).session(new AbortController().signal),
		).rejects.toBeInstanceOf(PublicShareError);
		expect(cancelled).toBe(true);
	});

	test("secrets are accepted only from a single well-formed fragment parameter", () => {
		expect(readPublicShareToken(`#token=${credential}`)).toBe(credential);
		expect(readPublicShareToken(`token=${credential}`)).toBe(credential);
		for (const hash of [
			"",
			"#token=short",
			`#token=${credential}&token=${credential}`,
			"#token=a%0Aheader",
		])
			expect(readPublicShareToken(hash)).toBe("");
	});
});

describe("public display protocol", () => {
	test("SSE handles split CRLF, comments, data frames and combined frames", () => {
		const parser = new PublicShareSseParser();
		expect(parser.push(': heartbeat\r\n\r\ndata: {"type":"p')).toEqual([]);
		expect(parser.push('ing"}\r\n\r')).toEqual([]);
		expect(parser.push('\ndata: {"type":"reset"}\n\ndata: {"type":"revoked"}\n\n')).toEqual([
			{ type: "ping" },
			{ type: "reset" },
			{ type: "revoked" },
		]);
	});

	test("only whitelisted events and display fields survive", () => {
		expect(
			parsePublicShareEvent(
				JSON.stringify({
					type: "snapshot",
					truncated: false,
					raw: "secret",
					blocks: [{ id: "b", kind: "text", text: "hello", filePath: "/secret" }],
				}),
			),
		).toEqual({
			type: "snapshot",
			truncated: false,
			blocks: [{ id: "b", kind: "text", text: "hello" }],
		});
		for (const event of [
			{ type: "permission_request" },
			{ type: "delta", blockId: "b", kind: "text", text: "x", offset: -1 },
			{ type: "delta", blockId: "b", kind: "html", text: "x", offset: 0 },
			{ type: "invalidate", scope: "terminal" },
			{ type: "snapshot", blocks: [null], truncated: false },
		])
			expect(() => parsePublicShareEvent(JSON.stringify(event))).toThrow();
	});

	test("oversized complete and incomplete frames are rejected", () => {
		expect(() => new PublicShareSseParser().push("x".repeat(65537))).toThrow();
		expect(() => new PublicShareSseParser().push(`${"x".repeat(65537)}\n\n`)).toThrow();
	});

	test("internal, relative, credentialed and active links are inert", () => {
		for (const href of [
			"/api/files",
			"/narrators/id",
			"#token=x",
			"//evil.test",
			"file:///etc/passwd",
			"nf-file://open",
			"javascript:alert(1)",
			"data:text/html,a",
			"https://app.test/api/files",
			"https://user:password@evil.test/a",
		]) {
			expect(publicShareExternalHref(href, "https://app.test")).toBeNull();
		}
		expect(publicShareExternalHref("https://docs.test/guide?q=1", "https://app.test")).toBe(
			"https://docs.test/guide?q=1",
		);
	});
});
