import { describe, expect, test } from "bun:test";
import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import type { DocumentToken } from "./text-document-pure-core";
import {
	type DocumentViewSnapshot,
	overlayDocumentTokens,
	TextDocumentViewSession,
} from "./text-document-view-session";
import type { TextDocumentViewResult } from "./text-document-worker-client";
import type { TextDocumentViewOptions } from "./text-document-worker-protocol";

const options: TextDocumentViewOptions = {
	language: "typescript",
	theme: "github-dark-default",
	font: "12px monospace",
	lineHeight: 18,
	letterSpacing: 0,
	tabSize: 4,
	width: 600,
	wrap: true,
	top: 0,
	height: 180,
	left: 0,
	viewportWidth: 600,
};
const ref = (revision: number, length = revision + 2, epoch = "epoch"): TextDocumentRef => ({
	id: "doc",
	epoch,
	revision,
	length,
	complete: false,
	originKnown: true,
});
const view = (document: TextDocumentRef): TextDocumentViewResult => ({
	revision: document.revision,
	contentHeight: 18,
	contentWidth: document.length * 8,
	rows: [
		{
			index: 0,
			start: 0,
			end: document.length,
			left: 0,
			top: 0,
			height: 18,
			width: document.length * 8,
			text: "x".repeat(document.length),
			tokens: [],
			points: [
				{ offset: 0, x: 0 },
				{ offset: document.length, x: document.length * 8 },
			],
		},
	],
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("non-starving independent document view pumps", () => {
	test("50ms appends do not abort a running prefix; older completed colour is painted before EOF", async () => {
		const layouts: {
			ref: TextDocumentRef;
			signal?: AbortSignal;
			result: ReturnType<typeof deferred<TextDocumentViewResult>>;
		}[] = [];
		const highlights: {
			ref: TextDocumentRef;
			signal?: AbortSignal;
			result: ReturnType<typeof deferred<DocumentToken[]>>;
		}[] = [];
		const published: DocumentViewSnapshot[] = [];
		const session = new TextDocumentViewSession(
			{
				view: async (document, _options, signal) => {
					const result = deferred<TextDocumentViewResult>();
					layouts.push({ ref: document, signal, result });
					return result.promise;
				},
				highlight: async (document, _options, _rows, signal) => {
					const result = deferred<DocumentToken[]>();
					highlights.push({ ref: document, signal, result });
					return result.promise;
				},
			},
			(value) => published.push(value),
		);
		const initial = ref(0),
			latest = ref(100);
		session.setTarget(initial, options);
		for (let i = 1; i < 100; i++) session.setTarget(ref(i), options);
		session.setTarget(latest, options);
		expect(layouts).toHaveLength(1);
		expect(layouts[0].signal?.aborted).toBe(false);
		layouts[0].result.resolve(view(initial));
		await flush();
		expect(session.getSnapshot().ready).toBe(true);
		expect(session.getSnapshot().rows[0].text).toBe("xx");
		expect(layouts).toHaveLength(2);
		expect(layouts[1].ref).toBe(latest);
		expect(highlights).toHaveLength(1);
		layouts[1].result.resolve(view(latest));
		await flush();
		expect(session.getSnapshot().rows[0].text.length).toBe(latest.length);
		expect(highlights[0].signal?.aborted).toBe(false);
		highlights[0].result.resolve([{ start: 0, end: initial.length, color: "#123" }]);
		await flush();
		expect(session.getSnapshot().rows[0].tokens).toEqual([{ start: 0, end: 2, color: "#123" }]);
		expect(session.getSnapshot().highlightReady).toBe(false);
		expect(highlights).toHaveLength(2);
		expect(highlights[1].ref).toBe(latest);
		expect(session.stats().cancellations).toBe(0);
		highlights[1].result.resolve([{ start: 0, end: latest.length, color: "#456" }]);
		await flush();
		expect(session.getSnapshot().highlightReady).toBe(true);
		expect(session.getSnapshot().rows[0].tokens).toEqual([
			{ start: 0, end: latest.length, color: "#456" },
		]);
		expect(
			published.some(
				(snapshot) =>
					snapshot.ready && !snapshot.highlightReady && snapshot.rows[0]?.tokens.length > 0,
			),
		).toBe(true);
	});
	test("blocked highlighting cannot block newer raw windows or clear prior colours", async () => {
		const delayed = deferred<DocumentToken[]>();
		let calls = 0;
		const session = new TextDocumentViewSession(
			{
				view: async (document) => view(document),
				highlight: async (document) => {
					if (calls++ === 0) return [{ start: 0, end: document.length, color: "#123" }];
					return delayed.promise;
				},
			},
			() => {},
		);
		session.setTarget(ref(0), options);
		await flush();
		expect(session.getSnapshot().highlightReady).toBe(true);
		session.setTarget(ref(1), options);
		await flush();
		for (let i = 2; i < 20; i++) {
			session.setTarget(ref(i), options);
			await flush();
		}
		expect(session.getSnapshot().rows[0].text.length).toBe(21);
		expect(session.getSnapshot().rows[0].tokens[0].color).toBe("#123");
		expect(session.stats().tokenActive).toBe(true);
		expect(session.stats().pendingTokenTargets).toBe(1);
		expect(session.stats().cancellations).toBe(0);
		session.stop();
		delayed.resolve([]);
		await flush();
	});
	test("epoch replacement cancels incompatible work and ignores late source results", async () => {
		const old = deferred<TextDocumentViewResult>();
		let signal: AbortSignal | undefined;
		const session = new TextDocumentViewSession(
			{
				view: async (document, _options, value) => {
					if (document.epoch === "epoch") {
						signal = value;
						return old.promise;
					}
					return view(document);
				},
				highlight: async (document) => [{ start: 0, end: document.length, color: "#new" }],
			},
			() => {},
		);
		session.setTarget(ref(0), options);
		const fresh = ref(10, 12, "new");
		session.setTarget(fresh, options);
		await flush();
		expect(signal?.aborted).toBe(true);
		expect(session.getSnapshot().documentKey).toBe(JSON.stringify(["doc", "new"]));
		old.resolve(view(ref(0)));
		await flush();
		expect(session.getSnapshot().rows[0].text.length).toBe(12);
		expect(session.getSnapshot().rows[0].tokens[0].color).toBe("#new");
	});
	test("theme changes reject old palette; geometry changes reject old layout but retain valid raw styles", async () => {
		const old = deferred<DocumentToken[]>();
		let signal: AbortSignal | undefined;
		const session = new TextDocumentViewSession(
			{
				view: async (document) => view(document),
				highlight: async (document, style, _rows, value) => {
					if (style.theme === options.theme) {
						signal = value;
						return old.promise;
					}
					return [{ start: 0, end: document.length, color: "#light" }];
				},
			},
			() => {},
		);
		const document = ref(0);
		session.setTarget(document, options);
		await flush();
		session.setTarget(document, {
			...options,
			theme: "github-light-default",
			width: 120,
			fontRevision: 2,
		});
		await flush();
		expect(signal?.aborted).toBe(true);
		old.resolve([{ start: 0, end: 2, color: "#wrong" }]);
		await flush();
		expect(session.getSnapshot().rows[0].tokens[0].color).toBe("#light");
	});
	test("failures preserve raw window and are explicit; stop/restart is reusable", async () => {
		let failed = true;
		const session = new TextDocumentViewSession(
			{
				view: async (document) => view(document),
				highlight: async (document) => {
					if (failed) throw new Error("Worker timeout; retry available");
					return [{ start: 0, end: document.length, color: "#123" }];
				},
			},
			() => {},
		);
		const document = ref(0);
		session.setTarget(document, options);
		await flush();
		expect(session.getSnapshot().ready).toBe(true);
		expect(session.getSnapshot().highlightReady).toBe(false);
		expect(session.getSnapshot().error).toContain("timeout");
		expect(session.getSnapshot().rows[0].text).toBe("xx");
		failed = false;
		session.stop();
		session.setTarget(document, options);
		await flush();
		expect(session.getSnapshot().error).toBeUndefined();
		expect(session.getSnapshot().highlightReady).toBe(true);
	});
	test("partial colour patches keep every uncovered original span without duplicated overlaps", () => {
		expect(
			overlayDocumentTokens(
				[{ start: 0, end: 100, color: "#old" }],
				[{ start: 30, end: 40, color: "#new" }],
				[{ start: 20, end: 50 }],
			),
		).toEqual([
			{ start: 0, end: 20, color: "#old" },
			{ start: 30, end: 40, color: "#new" },
			{ start: 50, end: 100, color: "#old" },
		]);
	});
});
