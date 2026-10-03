import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { textDocumentStore } from "@frontend/lib/text-document-store";
import type {
	TextDocumentRangeReader,
	TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	useWriteDocumentSources,
	type WriteDocumentSourceEnsurer,
	type WriteDocumentSourceRequest,
} from "./useWriteDocumentSources";

let root: Root;
let client: QueryClient;
let container: HTMLElement;
let restore: () => void;
let result: ReturnType<typeof useWriteDocumentSources>;
const EMPTY: WriteDocumentSourceRequest[] = [];
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = {
		window,
		document: window.document,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	restore = () => {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	restore();
});
function Probe({
	narratorId,
	requests,
	ensure,
	reader,
}: {
	narratorId: string;
	requests: readonly WriteDocumentSourceRequest[];
	ensure?: WriteDocumentSourceEnsurer;
	reader?: TextDocumentRangeReader;
}) {
	result = useWriteDocumentSources(narratorId, requests, ensure, reader);
	return null;
}
async function render(
	requests: readonly WriteDocumentSourceRequest[],
	ensure?: WriteDocumentSourceEnsurer,
	reader?: TextDocumentRangeReader,
	narratorId = "historical",
) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe narratorId={narratorId} requests={requests} ensure={ensure} reader={reader} />
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
}
function descriptor(id: string, source: WriteDocumentSourceRequest): TextDocumentRef {
	return {
		id,
		epoch: `${id}:e`,
		revision: 1,
		complete: true,
		originKnown: true,
		length: 1_000_000,
		source: { narratorId: "historical", field: "content", ...source },
	};
}

describe("historical Write source hydration", () => {
	test("only observed Write identities request small descriptors, never another tool's payload", async () => {
		const request = {
			toolUseId: "same",
			toolCallId: "pk-1",
			messageId: "message",
			executionAttempt: 1,
		};
		const read = { toolUseId: "Read", toolCallId: "pk-read" };
		const calls: string[] = [];
		const ensure: WriteDocumentSourceEnsurer = async (_narrator, toolUseId, pin) => {
			calls.push(toolUseId);
			return descriptor("historical-ref", { toolUseId, ...pin });
		};
		const reader: TextDocumentRangeReader = async (ref, offset, limit) => ({
			ref,
			offset,
			text: "x".repeat(limit),
		});
		await render(EMPTY, ensure, reader);
		result.noteWrite(request.toolUseId, request);
		await render([request, read], ensure, reader);
		expect(calls).toEqual(["same"]);
		expect(result.resolve(request.toolUseId, request)?.id).toBe("historical-ref");
		expect(await textDocumentStore.readRange("historical-ref", 500000, 500010)).toBe(
			"x".repeat(10),
		);
	});
	test("retains source refs after request withdrawal and keeps resolver identity stable on scroll", async () => {
		const request = {
			toolUseId: "retain",
			toolCallId: "pk-retain",
			messageId: "message-retain",
			executionAttempt: 1,
		};
		let calls = 0;
		const ensure: WriteDocumentSourceEnsurer = async () => {
			calls++;
			return descriptor("retain-ref", request);
		};
		await render(EMPTY, ensure);
		result.noteWrite(request.toolUseId, request);
		await render([request], ensure);
		const resolver = result.resolve;
		await render(EMPTY, ensure);
		expect(result.resolve).toBe(resolver);
		expect(result.resolve(request.toolUseId, request)?.id).toBe("retain-ref");
		await render([request], ensure);
		expect(calls).toBe(1);
	});
	test("same provider id is isolated by row PK and attempt; narrator change resets retained aliases", async () => {
		const one = {
			toolUseId: "reuse",
			toolCallId: "pk-old",
			messageId: "message-old",
			executionAttempt: 1,
		};
		const two = {
			toolUseId: "reuse",
			toolCallId: "pk-new",
			messageId: "message-new",
			executionAttempt: 2,
		};
		const ensure: WriteDocumentSourceEnsurer = async (_n, _id, pin) =>
			descriptor(`ref-${pin?.toolCallId}`, { toolUseId: "reuse", ...pin });
		await render(EMPTY, ensure);
		result.noteWrite(one.toolUseId, one);
		result.noteWrite(two.toolUseId, two);
		await render([one, two], ensure);
		expect(result.resolve(one.toolUseId, one)?.id).toBe("ref-pk-old");
		expect(result.resolve(two.toolUseId, two)?.id).toBe("ref-pk-new");
		await render(EMPTY, ensure, undefined, "different");
		expect(result.resolve(one.toolUseId, one)).toBeUndefined();
	});
	test("failures stay explicit and retry invalidates only failed sources", async () => {
		const request = {
			toolUseId: "failure",
			toolCallId: "pk-failure",
			messageId: "message-failure",
			executionAttempt: 1,
		};
		let failed = true;
		const ensure: WriteDocumentSourceEnsurer = async () => {
			if (failed) throw new Error("denied");
			return descriptor("retried-ref", request);
		};
		await render(EMPTY, ensure);
		result.noteWrite(request.toolUseId, request);
		await render([request], ensure);
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		});
		expect(result.hasError(request.toolUseId, request)).toBe(true);
		failed = false;
		await act(async () => result.retryErrors());
		await render([request], ensure);
		expect(result.hasError(request.toolUseId, request)).toBe(false);
		expect(result.resolve(request.toolUseId, request)?.id).toBe("retried-ref");
	});
	test("missing injected transport makes no JWT or alternate credential fallback", async () => {
		const request = {
			toolUseId: "no-transport",
			toolCallId: "pk",
			messageId: "message-no-transport",
			executionAttempt: 1,
		};
		await render(EMPTY);
		result.noteWrite(request.toolUseId, request);
		await render([request]);
		expect(result.resolve(request.toolUseId, request)).toBeUndefined();
		expect(
			client.getQueryState([
				"write-document-source",
				"historical",
				JSON.stringify([
					request.toolUseId,
					request.toolCallId,
					request.messageId,
					request.executionAttempt,
				]),
			])?.fetchStatus,
		).toBe("idle");
	});
});
