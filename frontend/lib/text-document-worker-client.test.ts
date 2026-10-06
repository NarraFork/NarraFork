import { beforeAll, describe, expect, test } from "bun:test";
import type { ShikiModule } from "./shiki-loader";
import { documentTokensForRange, PagedTextDocument } from "./text-document-pure-core";
import { TextDocumentStore } from "./text-document-store";
import { TextDocumentWorkerClient } from "./text-document-worker-client";
import { TextDocumentLayoutIndex, TextDocumentWorkerRuntime } from "./text-document-worker-core";
import {
	type DocumentWorkerRequest,
	type DocumentWorkerResponse,
	documentPacketBytes,
	type TextDocumentViewOptions,
} from "./text-document-worker-protocol";

beforeAll(() => {
	Object.assign(globalThis, {
		OffscreenCanvas: class {
			getContext() {
				return {
					font: "12px monospace",
					measureText(text: string) {
						return { width: Array.from(text).length * 8 };
					},
				};
			}
		},
	});
});
const options: TextDocumentViewOptions = {
	language: "javascript",
	theme: "github-dark",
	font: "12px monospace",
	lineHeight: 18,
	letterSpacing: 0,
	tabSize: 4,
	width: 320,
	wrap: true,
	top: 0,
	height: 180,
	left: 0,
	viewportWidth: 320,
	fontRevision: 1,
};
const styleShiki: ShikiModule = {
	bundledLanguages: {},
	codeToHtml: async () => "",
	codeToTokens: async (text) => ({ tokens: [[{ offset: 0, content: text, color: "#abc" }]] }),
};

class Port {
	onmessage: ((event: MessageEvent<DocumentWorkerResponse>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	terminated = false;
	packets: DocumentWorkerRequest[] = [];
	runtime: TextDocumentWorkerRuntime;
	constructor(
		load = async () => styleShiki,
		private hung = false,
	) {
		this.runtime = new TextDocumentWorkerRuntime(
			(data) =>
				queueMicrotask(() => {
					if (!this.terminated) this.onmessage?.({ data } as MessageEvent<DocumentWorkerResponse>);
				}),
			load,
		);
	}
	postMessage(packet: DocumentWorkerRequest) {
		this.packets.push(packet);
		if (!this.hung && !this.terminated) this.runtime.handle(packet);
	}
	terminate() {
		this.terminated = true;
	}
}

describe("isolated document worker lanes", () => {
	test("two lazy workers, absolute mount boot, viewport-only payloads and exact full raw source", async () => {
		const store = new TextDocumentStore();
		const text = "const x = '中😀';\r\n".repeat(10_000);
		const ref = store.importText("doc", text);
		const ports: Port[] = [];
		const client = new TextDocumentWorkerClient(
			store,
			() => {
				const port = new Port();
				ports.push(port);
				return port;
			},
			() => "https://example.test/nf/",
		);
		const release = client.retain(ref.id);
		const view = await client.view(ref, options);
		expect(ports.length).toBe(1);
		expect(view.rows.length).toBeLessThan(30);
		expect(view.contentHeight).toBe(10_001 * 18);
		expect(view.rows[0].text).toBe("const x = '中😀';");
		expect(view.rows.every((row) => row.text === text.slice(row.start, row.end))).toBe(true);
		const tokens = await client.highlight(ref, options, view.rows);
		expect(ports.length).toBe(2);
		expect(tokens.length).toBeLessThan(30);
		expect(await store.readAll(ref.id)).toBe(text);
		for (const port of ports) {
			expect(port.packets[0]).toEqual({
				type: "boot",
				role: port === ports[0] ? "layout" : "tokens",
				assetBase: "https://example.test/nf/",
			});
			for (const packet of port.packets)
				expect(documentPacketBytes(packet)).toBeLessThanOrEqual(64 * 1024);
		}
		release();
		expect(ports.every((port) => port.runtime.stats().documents === 0)).toBe(true);
	});
	test("100k single-line horizontal view clips text/tokens but source copy/search is complete", async () => {
		const store = new TextDocumentStore();
		const text = "x".repeat(100_000),
			ref = store.importText("long", text);
		const client = new TextDocumentWorkerClient(
			store,
			() => new Port(),
			() => "https://example.test/proxy/7778/",
		);
		const viewport = { ...options, wrap: false, left: 400_000 };
		const view = await client.view(ref, viewport);
		expect(view.rows).toHaveLength(1);
		expect(view.rows[0].start).toBeGreaterThan(49_000);
		expect(view.rows[0].text.length).toBeLessThan(100);
		expect(view.rows[0].left).toBeLessThanOrEqual(400_000);
		const tokens = await client.highlight(ref, viewport, view.rows);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].start).toBe(view.rows[0].start);
		expect(tokens[0].end).toBe(view.rows[0].end);
		expect(await store.readAll("long")).toBe(text);
		expect(await client.position(ref, viewport, 90_000)).toEqual({
			index: 0,
			top: 0,
			left: 720_000,
		});
	});
	test("blocked highlighting does not block layout/source reads on the other lane", async () => {
		let resolve!: (value: Awaited<ReturnType<ShikiModule["codeToTokens"]>>) => void;
		const stalled: ShikiModule = {
			...styleShiki,
			codeToTokens: () =>
				new Promise((done) => {
					resolve = done;
				}),
		};
		const store = new TextDocumentStore(),
			ref = store.importText("doc", "abc");
		const ports: Port[] = [];
		const client = new TextDocumentWorkerClient(
			store,
			() => {
				const port = new Port(async () => stalled);
				ports.push(port);
				return port;
			},
			() => "https://example.test/",
		);
		const view = await client.view(ref, options);
		const highlighting = client.highlight(ref, options, view.rows);
		await new Promise((done) => setTimeout(done, 5));
		expect((await client.view(ref, { ...options, width: 120 })).rows[0].text).toBe("abc");
		expect(await store.readAll("doc")).toBe("abc");
		resolve({ tokens: [[{ offset: 0, content: "abc", color: "#abc" }]] });
		expect(await highlighting).toHaveLength(1);
	});
	test("watchdog is explicit, terminates only failing lane, preserves full source and retry recreates it", async () => {
		const store = new TextDocumentStore(),
			ref = store.importText("doc", "source\r\n😀");
		const ports: Port[] = [];
		const client = new TextDocumentWorkerClient(
			store,
			() => {
				const port = new Port(undefined, ports.length === 0);
				ports.push(port);
				return port;
			},
			() => "https://example.test/",
			25,
		);
		await expect(client.view(ref, options)).rejects.toThrow("timed out");
		expect(ports[0].terminated).toBe(true);
		expect(await store.readAll(ref.id)).toBe("source\r\n😀");
		expect((await client.view(ref, options)).rows[0].text).toBe("source");
		expect(ports).toHaveLength(2);
	});
	test("stale epoch/revision result is rejected and cannot replace a newer document", async () => {
		const store = new TextDocumentStore(),
			ref = store.importText("doc", "abc");
		const port = new Port(undefined, true);
		const client = new TextDocumentWorkerClient(
			store,
			() => port,
			() => "https://example.test/",
		);
		const request = client.view(ref, options);
		await new Promise((done) => setTimeout(done, 1));
		const message = port.packets.find((packet) => packet.type === "view");
		if (!message || message.type !== "view") throw new Error("View request missing");
		port.onmessage?.({
			data: { type: "done", requestId: message.requestId, epoch: "old", revision: ref.revision },
		} as MessageEvent<DocumentWorkerResponse>);
		await expect(request).rejects.toThrow("Stale");
		expect(store.getSnapshot("doc")).toBe(ref);
	});
	test("reset acknowledges old queued work; old-ref callers cannot resurrect the retired epoch", async () => {
		const store = new TextDocumentStore();
		const old = store.importText("doc", "old");
		const port = new Port();
		const client = new TextDocumentWorkerClient(
			store,
			() => port,
			() => "https://example.test/",
			40,
		);
		const first = client.view(old, options).then(
			() => "completed",
			(error: Error) => error.message,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const fresh = store.importText("doc", "new source");
		expect((await client.view(fresh, options)).rows[0].text).toBe("new source");
		expect(["completed", "Document source released or superseded"]).toContain(await first);
		await expect(client.view(old, options)).rejects.toThrow("epoch superseded");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(port.terminated).toBe(false);
		expect((await client.view(fresh, options)).rows[0].text).toBe("new source");
	});
	test("abort acknowledges cancelled request and stops waiting without removing source", async () => {
		const store = new TextDocumentStore(),
			ref = store.importText("doc", "abc");
		const port = new Port(),
			client = new TextDocumentWorkerClient(
				store,
				() => port,
				() => "https://example.test/",
			);
		const controller = new AbortController();
		const request = client.view(ref, options, controller.signal);
		queueMicrotask(() => controller.abort());
		await expect(request).rejects.toThrow();
		expect(await store.readAll(ref.id)).toBe("abc");
		expect((await client.view(ref, options)).rows[0].text).toBe("abc");
	});
	test("shared inline/fullscreen retains keep worker source until the final view closes", async () => {
		const store = new TextDocumentStore(),
			ref = store.importText("doc", "abc");
		const port = new Port(),
			client = new TextDocumentWorkerClient(
				store,
				() => port,
				() => "https://example.test/",
			);
		const inline = client.retain("doc"),
			fullscreen = client.retain("doc");
		await client.view(ref, options);
		inline();
		expect(port.runtime.stats().documents).toBe(1);
		await client.view(ref, { ...options, width: 600 });
		fullscreen();
		expect(port.runtime.stats().documents).toBe(0);
		expect(await store.readAll("doc")).toBe("abc");
	});
	test("long tokens are independently clipped to every wrapped row instead of consumed once", () => {
		const token = [{ start: 0, end: 100, color: "#123" }];
		for (let start = 0; start < 100; start += 10)
			expect(documentTokensForRange(token, start, start + 10)).toEqual([
				{ start, end: start + 10, color: "#123" },
			]);
	});
	test("layout updates reuse completed physical rows and replace incomplete CRLF tail; font/width changes reflow", async () => {
		const source = new PagedTextDocument();
		source.append(0, "one\r\ntwo\r");
		const index = new TextDocumentLayoutIndex(options);
		await index.update(source);
		const first = index.rows[0];
		source.append(source.length, "\nthree");
		await index.update(source);
		expect(index.rows[0]).toBe(first);
		expect(index.rows.map((row) => source.slice(row.start, row.end))).toEqual([
			"one",
			"two",
			"three",
		]);
		const narrow = new TextDocumentLayoutIndex({ ...options, width: 16, fontRevision: 2 });
		await narrow.update(source);
		expect(narrow.rows.length).toBeGreaterThan(index.rows.length);
		for (const row of index.rows)
			for (let i = 0; i < row.offsets.length; i++) {
				const position = index.position(row.offsets[i]);
				expect(index.offsetAtPosition(position.top, position.left)).toBe(row.offsets[i]);
			}
	});
});
