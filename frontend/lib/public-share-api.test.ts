import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resetAppBaseForTest } from "./base-path";
import {
	buildPublicShareUrl,
	createPublicShareClient,
	linkPublicShareSignals,
	PublicShareError,
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
			return Response.json({});
		});
		const client = createPublicShareClient("share-id", credential);
		const signal = new AbortController().signal;
		await client.session(signal);
		await client.pretextDocument(signal, { beforeSeq: 123, messageVersion: 7, limit: 50 });
		await client.discussion(signal, 100);
		await client.toolCallDetail("tool-1", {}, signal);
		await client.messageLocation("msg-1", signal);
		await client.post("hello", "message-1", signal);
		expect(calls.map((call) => call.url)).toEqual([
			"/api/public/narrator-shares/share-id",
			"/api/public/narrator-shares/share-id/pretext-document?beforeSeq=123&limit=50&messageVersion=7",
			"/api/public/narrator-shares/share-id/discussion?limit=50&beforeSeq=100",
			"/api/public/narrator-shares/share-id/tool-calls/tool-1",
			"/api/public/narrator-shares/share-id/message-location/msg-1",
			"/api/public/narrator-shares/share-id/discussion",
		]);
		for (const { url, init } of calls) {
			expect(url).not.toContain(credential);
			expect(init.credentials).toBe("omit");
			expect(init.referrerPolicy).toBe("no-referrer");
			expect(init.cache).toBe("no-store");
			expect(init.redirect).toBe("error");
			expect(new Headers(init.headers).get("authorization")).toBe(`Share ${credential}`);
		}
		expect(JSON.parse(calls[5].init.body as string)).toEqual({
			text: "hello",
			replyToMessageId: "message-1",
		});
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
		await expect(client.toolCallDetail("../files", {}, signal)).rejects.toBeInstanceOf(
			PublicShareError,
		);
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
		await client.toolCallDetail("provider:call.123", {}, signal);
		expect(url).toBe("/api/public/narrator-shares/share/tool-calls/provider%3Acall.123");
		for (const id of [".", "..", "a/b"])
			await expect(client.toolCallDetail(id, {}, signal)).rejects.toBeInstanceOf(PublicShareError);
	});

	test("responses are bounded before JSON parsing", async () => {
		let cancelled = false;
		replaceGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							// The document window budget is 32 MiB (a full pretext window);
							// one byte past it must abort the read rather than buffer it.
							controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
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

describe("public display boundary", () => {
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
