import { afterEach, describe, expect, test } from "bun:test";
import type { ComposerDocument } from "@shared/composer-document";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import { ApiError } from "./client";
import { api } from "./index";
import {
	parseContentDispositionFileName,
	type RetryFailedCompactResponse,
	shouldClearEditDraft,
} from "./narrators";

describe("narrators API", () => {
	const g = globalThis as typeof globalThis & {
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
	});

	test("modeltrace posts once to the encoded endpoint without a body", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const requests: Array<{ url: string; init: RequestInit }> = [];
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (url: unknown, init: RequestInit) => {
				requests.push({ url: String(url), init });
				return Response.json({ id: "trace-child" });
			},
		});
		expect(await api.startModelTrace("n/a")).toEqual({ id: "trace-child" });
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("/api/narrators/n%2Fa/modeltrace");
		expect(requests[0].init.method).toBe("POST");
		expect(requests[0].init.body).toBeUndefined();
	});

	test("modeltrace retry posts to the encoded child endpoint without a body", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const requests: Array<{ url: string; init: RequestInit }> = [];
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (url: unknown, init: RequestInit) => {
				requests.push({ url: String(url), init });
				return Response.json({ id: "child/a" });
			},
		});
		expect(await api.retryModelTrace("child/a")).toEqual({ id: "child/a" });
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("/api/narrators/child%2Fa/modeltrace/retry");
		expect(requests[0].init.method).toBe("POST");
		expect(requests[0].init.body).toBeUndefined();
	});

	test("message and block deletions are always history-only", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const requests: Array<{ url: string; init: RequestInit }> = [];
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (url: unknown, init: RequestInit) => {
				requests.push({ url: String(url), init });
				return Response.json({ ok: true, deleted: 1, failed: 0, results: [] });
			},
		});
		await api.deleteMessage("n", "m");
		await api.deleteMessageBlock("n", { messageId: "m", blockIndex: 2, blockId: "b2" });
		await api.deleteMessageBlocks("n", [{ messageId: "m", blockIndex: 0, blockId: "b0" }]);
		expect(requests[0].url).toEndWith("/narrators/n/messages/m?skipRevert=1");
		for (const [index, blockId] of [
			[1, "b2"],
			[2, "b0"],
		] as const) {
			expect(requests[index].url).toEndWith("/narrators/n/blocks");
			expect(JSON.parse(String(requests[index].init.body))).toEqual({
				blockIds: [blockId],
				skipRevert: true,
			});
		}
	});

	test.each([
		false,
		true,
	])("edit transports the reviewed plan with actual content and uploads (%s)", async (multipart) => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const requests: RequestInit[] = [];
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (_url: unknown, init: RequestInit) => {
				requests.push(init);
				return Response.json({ ok: true });
			},
		});
		const revertPlan = {
			planId: "reviewed-plan",
			planHash: "a".repeat(64),
			action: "edit_and_regenerate" as const,
		};
		await api.editAndRegenerate("n", "m", "  actual new prompt  ", {
			skipRevert: false,
			revertPlan,
			newTextFiles: multipart ? [new File(["attachment"], "notes.txt")] : undefined,
		});
		const body = requests[0].body;
		const parsed =
			body instanceof FormData
				? { content: body.get("content"), revertPlan: JSON.parse(String(body.get("revertPlan"))) }
				: JSON.parse(String(body));
		expect(parsed.content).toBe("  actual new prompt  ");
		expect(parsed.revertPlan).toEqual(revertPlan);
	});

	describe("composer document transport", () => {
		const doc: ComposerDocument = {
			version: 1,
			assets: [],
			paragraphs: [{ children: [{ type: "text", text: "hello" }] }],
		};
		test.each([
			false,
			true,
		])("send/queue/history edit preserve optional layout in JSON and multipart (%s)", async (multipart) => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => null },
				configurable: true,
			});
			const requests: RequestInit[] = [];
			Object.defineProperty(g, "fetch", {
				configurable: true,
				value: async (_url: unknown, init: RequestInit) => {
					requests.push(init);
					return Response.json({ ok: true });
				},
			});
			const originalXHR = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
			class TestXHR {
				status = 200;
				statusText = "OK";
				responseText = '{"ok":true}';
				onload: (() => void) | null = null;
				open() {}
				setRequestHeader() {}
				getAllResponseHeaders() {
					return "Content-Type: application/json";
				}
				send(body: FormData) {
					requests.push({ body });
					queueMicrotask(() => this.onload?.());
				}
			}
			Object.defineProperty(globalThis, "XMLHttpRequest", { value: TestXHR, configurable: true });
			try {
				for (const composerDocument of [undefined, doc]) {
					const uploads = multipart
						? [new File(["x"], "a.txt", { type: "text/plain" })]
						: undefined;
					await api.sendNarratorMessage(
						"n",
						"hello",
						undefined,
						uploads,
						undefined,
						undefined,
						undefined,
						[],
						undefined,
						"turn",
						{ composerDocument },
					);
					await api.updateBufferedMessage("n", "q", "hello", {
						newTextFiles: uploads,
						composerDocument,
					});
					await api.editAndRegenerate("n", "m", "hello", {
						newTextFiles: uploads,
						composerDocument,
					});
					for (const request of requests.splice(0)) {
						const body = request.body;
						if (body instanceof FormData) {
							expect(body.has("composerDocument")).toBe(composerDocument !== undefined);
							if (composerDocument)
								expect(JSON.parse(String(body.get("composerDocument")))).toEqual(composerDocument);
						} else {
							expect(JSON.parse(String(body)).composerDocument).toEqual(composerDocument);
						}
					}
				}
			} finally {
				if (originalXHR) Object.defineProperty(globalThis, "XMLHttpRequest", originalXHR);
				else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
			}
		});
		test("drafts and lazy detail endpoints carry the same document and cancellation", async () => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => null },
				configurable: true,
			});
			const requests: Array<{ url: string; init: RequestInit }> = [];
			Object.defineProperty(g, "fetch", {
				configurable: true,
				value: async (url: string, init: RequestInit) => {
					requests.push({ url, init });
					return Response.json({ composerDocument: doc });
				},
			});
			await api.updateNarratorDraft("n", "hello", "source", [], doc);
			expect(JSON.parse(String(requests[0].init.body)).composerDocument).toEqual(doc);
			const controller = new AbortController();
			expect(await api.getMessageComposerDocument("n/a", "m/a", controller.signal)).toEqual({
				composerDocument: doc,
			});
			expect(await api.getBufferedMessageComposerDocument("n/a", "q/a", controller.signal)).toEqual(
				{ composerDocument: doc },
			);
			expect(requests[1].url).toBe("/api/narrators/n%2Fa/messages/m%2Fa/composer-document");
			expect(requests[2].url).toBe("/api/narrators/n%2Fa/buffer/q%2Fa/composer-document");
			expect(requests[1].init.signal).toBe(controller.signal);
			expect(requests[2].init.signal).toBe(controller.signal);
		});
	});

	describe("request recordings", () => {
		test("save/list/delete use encoded endpoints and explicit bounded cursor pages", async () => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => "recording-token" },
				configurable: true,
			});
			const calls: Array<{ url: string; init?: RequestInit }> = [];
			Object.defineProperty(g, "fetch", {
				configurable: true,
				value: async (url: string, init?: RequestInit) => {
					calls.push({ url, init });
					return Response.json({ id: "s", narratorId: "n", items: [], nextCursor: null, ok: true });
				},
			});
			const controller = new AbortController();
			const result = await api.saveRequestRecording("n/a", controller.signal);
			await api.listRequestRecordings("n/a", "before/one", controller.signal);
			await api.deleteRequestRecording("n/a", "save/one");
			expect(result.id).toBe("s");
			expect(calls.map((call) => call.url)).toEqual([
				"/api/narrators/n%2Fa/request-recordings",
				"/api/narrators/n%2Fa/request-recordings?limit=50&cursor=before%2Fone",
				"/api/narrators/n%2Fa/request-recordings/save%2Fone",
			]);
			expect(calls.map((call) => call.init?.method)).toEqual(["POST", undefined, "DELETE"]);
			expect(calls[0]?.init?.signal).toBe(controller.signal);
			expect(calls[1]?.init?.signal).toBe(controller.signal);
			for (const call of calls)
				expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer recording-token");
		});
		test("ZIP download is authenticated, cancelable and honors server filenames", async () => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => "recording-token" },
				configurable: true,
			});
			const calls: Array<{ url: string; init?: RequestInit }> = [];
			Object.defineProperty(g, "fetch", {
				configurable: true,
				value: async (url: string, init?: RequestInit) => {
					calls.push({ url, init });
					return new Response("zip-body", {
						headers: {
							"content-type": "application/zip",
							"content-disposition": 'attachment; filename="evidence.zip"',
						},
					});
				},
			});
			const controller = new AbortController();
			const result = await api.downloadRequestRecording("n/a", "s/a", controller.signal);
			expect(result.fileName).toBe("evidence.zip");
			expect(await result.blob.text()).toBe("zip-body");
			expect(calls[0]?.url).toBe("/api/narrators/n%2Fa/request-recordings/s%2Fa/download");
			expect(calls[0]?.init?.signal).toBe(controller.signal);
			expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
				"Bearer recording-token",
			);
		});
		test("failed ZIP download raises API error rather than saving an error body", async () => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => null },
				configurable: true,
			});
			Object.defineProperty(g, "fetch", {
				configurable: true,
				value: async () => Response.json({ error: "Forbidden" }, { status: 403 }),
			});
			await expect(api.downloadRequestRecording("n", "s")).rejects.toMatchObject({
				status: 403,
				message: "Forbidden",
			});
		});
	});

	test("narrator detail forwards optional cancellation signals while legacy callers stay compatible", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const signals: Array<AbortSignal | null | undefined> = [];
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (_url: string, init?: RequestInit) => {
				signals.push(init?.signal);
				return Response.json({ id: "n" });
			},
		});
		const controller = new AbortController();
		await api.getNarrator("n", controller.signal);
		await api.getNarrator("n");
		expect(signals).toEqual([controller.signal, undefined]);
	});

	test("snapshot preview and apply forward explicit consent while default requests omit recovery fields", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (url: string, init?: RequestInit) => {
				calls.push({ url, body: JSON.parse(String(init?.body)) });
				return Response.json({});
			},
		});
		const target = {
			messageId: "m",
			blockIndex: 2,
			blockId: "b2",
			action: "rollback_to_block" as const,
		};
		await api.previewRevertAction("n", { ...target, idempotencyKey: "selective-key" });
		await api.previewRevertAction("n", {
			...target,
			idempotencyKey: "snapshot-key",
			recoveryMode: "snapshot",
		});
		const plan = { planId: "p", planHash: "h", action: target.action };
		await api.applyRevertPlan("n", plan);
		await api.applyRevertPlan("n", { ...plan, acceptSnapshotRestore: true });
		const planned = { action: target.action, blockIds: [target.blockId] };
		expect(calls[0]?.body).toEqual({ ...planned, idempotencyKey: "selective-key" });
		expect(calls[1]?.body).toEqual({
			...planned,
			idempotencyKey: "snapshot-key",
			recoveryMode: "snapshot",
		});
		expect(calls[2]?.body).toEqual({ planHash: "h", action: target.action });
		expect(calls[3]?.body).toEqual({
			planHash: "h",
			action: target.action,
			acceptSnapshotRestore: true,
		});
	});

	test("historical ensure sends exact row/message/attempt without asking for full tool detail", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const calls: string[] = [];
		const ref = {
			id: "regenerated",
			epoch: "fresh",
			revision: 1,
			length: 50000,
			complete: true,
			originKnown: true,
		};
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (url: string) => {
				calls.push(url);
				return Response.json(ref);
			},
		});
		expect(
			await api.ensureWriteDocumentSource("reader", "provider:call", {
				toolCallId: "exact-row",
				messageId: "exact-message",
				executionAttempt: 2,
			}),
		).toEqual(ref);
		expect(calls).toEqual([
			"/api/narrators/reader/tool-calls/provider%3Acall/input-document?toolCallId=exact-row&messageId=exact-message&executionAttempt=2",
		]);
	});

	test("complete source reader routes by exact narrator/ref and bounds raw Unicode response bytes", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const calls: string[] = [];
		const ref = {
			id: "source-id",
			epoch: "epoch",
			revision: 1,
			length: 8,
			complete: true,
			originKnown: true,
			source: { narratorId: "child-id", toolUseId: "provider-id", field: "content" },
		};
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (url: string) => {
				calls.push(url);
				return Response.json({ ref, offset: 2, text: "\ud800\r\n" });
			},
		});
		expect((await api.readTextDocumentRange(ref, 2, 999999)).text).toBe("\ud800\r\n");
		expect(calls).toEqual(["/api/narrators/child-id/text-documents/source-id?offset=2&limit=8192"]);
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async () => new Response(`{"text":"${"a".repeat(65536)}"}`),
		});
		await expect(api.readTextDocumentRange(ref, 0, 8192)).rejects.toThrow("packet limit");
	});

	test("bounded document reads enforce streamed bytes without relying on Content-Length", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
						protocol: 2,
						messages: [],
						blocks: [],
						padding: "x".repeat(100),
					}),
					{ headers: { "content-type": "application/json" } },
				),
			configurable: true,
		});
		await expect(api.getPretextDocumentPage("n", { maxResponseBytes: 32 })).rejects.toThrow(
			"Response exceeds byte budget",
		);
		let bytes = 0;
		await api.getPretextDocumentPage("n", {
			maxResponseBytes: 1024,
			onResponseBytes: (count) => {
				bytes = count;
			},
		});
		expect(bytes).toBeGreaterThan(100);
	});

	test("oversized Content-Length cancels the body before reading and cannot block a retry", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		let cancelled = false;
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					new ReadableStream({
						cancel: () => {
							cancelled = true;
						},
					}),
					{ headers: { "content-type": "application/json", "content-length": "999999" } },
				),
			configurable: true,
		});
		await expect(api.getPretextDocumentPage("n", { maxResponseBytes: 32 })).rejects.toThrow(
			"Response exceeds byte budget",
		);
		expect(cancelled).toBe(true);
		Object.defineProperty(g, "fetch", {
			value: async () => Response.json({ messages: [] }),
			configurable: true,
		});
		expect((await api.getPretextDocumentPage("n", { maxResponseBytes: 32 })).messages).toEqual([]);
	});

	test("ask acknowledgements keep their fields and decode the message's blocks", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const element = { type: "ask_in_passing", status: "pending" };
		const encoded = {
			messages: [
				{
					id: "ask",
					seq: 3,
					role: "assistant",
					askInsertVersion: 7,
					blockIds: ["ask:0"],
					parentMessageId: null,
				},
			],
			blocks: [
				{
					id: "ask:0",
					messageId: "ask",
					ordinal: 0,
					kind: "context",
					subtype: null,
					phase: "done",
					revision: 0,
					wireId: null,
					attemptId: null,
					elements: [element],
					hasOriginal: false,
				},
			],
		};
		Object.defineProperty(g, "fetch", {
			value: async () => Response.json({ messageId: "ask", message: encoded }),
			configurable: true,
		});
		const started = await api.startAskInPassing("n", { sourceMessageId: "source" });
		expect(started.messageId).toBe("ask");
		expect(started.message?.id).toBe("ask");
		expect(started.message?.seq).toBe(3);
		expect(started.message?.askInsertVersion).toBe(7);
		expect(started.message ? messageBody(started.message) : []).toEqual([element]);
		expect(started.message?.blocks?.[0]).toMatchObject({ id: "ask:0", named: true });
		Object.defineProperty(g, "fetch", {
			value: async () => Response.json({ id: "target", message: encoded }),
			configurable: true,
		});
		const resolved = await api.askInPassing("n", { question: "why", pendingMessageId: "ask" });
		expect(resolved.id).toBe("target");
		expect(resolved.message?.id).toBe("ask");
		expect(resolved.message ? messageBody(resolved.message) : []).toEqual([element]);
		Object.defineProperty(g, "fetch", {
			value: async () => Response.json({ messageId: "ask" }),
			configurable: true,
		});
		expect((await api.startAskInPassing("n", { sourceMessageId: "source" })).message).toBe(
			undefined,
		);
	});

	test("detaches Bash with an encoded tool endpoint and no request body", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		let receivedUrl = "";
		let receivedInit: RequestInit | undefined;
		Object.defineProperty(g, "fetch", {
			value: async (url: string, init: RequestInit) => {
				receivedUrl = url;
				receivedInit = init;
				return Response.json({ detached: true, taskId: "task-1", alias: "build" });
			},
			configurable: true,
		});
		expect(await api.detachBash("n/1", "tu/1")).toEqual({
			detached: true,
			taskId: "task-1",
			alias: "build",
		});
		expect(receivedUrl).toEndWith("/narrators/n%2F1/tools/tu%2F1/detach");
		expect(receivedInit?.method).toBe("POST");
		expect(receivedInit?.body).toBeUndefined();
		Object.defineProperty(g, "fetch", {
			value: async () => Response.json({ error: "Already finished" }, { status: 409 }),
			configurable: true,
		});
		try {
			await api.detachBash("n", "tu");
			throw new Error("Expected a conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(409);
		}
	});

	test("interrupt can wait for the old loop to finish before replacement input", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const urls: URL[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (url: string) => {
				urls.push(new URL(url, "https://test.invalid"));
				return Response.json({ interrupted: true, settled: true });
			},
			configurable: true,
		});

		expect(await api.interruptNarrator("narrator-1")).toEqual({ interrupted: true, settled: true });
		expect(urls[0]?.pathname).toBe("/api/narrators/narrator-1/interrupt");
		expect(urls[0]?.search).toBe("");

		expect(await api.interruptNarrator("narrator-1", true)).toEqual({
			interrupted: true,
			settled: true,
		});
		expect(urls[1]?.search).toBe("?waitForIdle=1");
	});

	test("encodes raw tool row refs without treating the provider ID as a PK", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const urls: URL[] = [];
		const signals: (AbortSignal | null | undefined)[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (url: string, init?: RequestInit) => {
				urls.push(new URL(url, "https://test.invalid"));
				signals.push(init?.signal);
				return Response.json({ id: "actual-pk", inputJson: "input", outputJson: "output" });
			},
			configurable: true,
		});
		const narratorId = "n/a ?#%汉";
		const toolUseId = "provider/reused?&x=1#% +汉";
		const ref = { toolCallId: "pk/?&messageId=wrong#% +汉", messageId: "msg/+#%&=" };
		const signal = new AbortController().signal;
		expect(await api.getToolCallDetail(narratorId, toolUseId, ref, signal)).toMatchObject({
			id: "actual-pk",
			inputJson: "input",
			outputJson: "output",
		});
		expect(urls[0].pathname).toBe(
			`/api/narrators/${encodeURIComponent(narratorId)}/tool-calls/${encodeURIComponent(toolUseId)}`,
		);
		expect(Object.fromEntries(urls[0].searchParams)).toEqual(ref);
		expect(signals[0]).toBe(signal);
		await api.getToolCallDetail(narratorId, toolUseId, { messageId: ref.messageId });
		expect(Object.fromEntries(urls[1].searchParams)).toEqual({ messageId: ref.messageId });
		await api.getToolCallDetail(narratorId, toolUseId);
		expect(urls[2].search).toBe("");
		await api.getToolEditPreview(narratorId, toolUseId, { ...ref, executionAttempt: 2 }, signal);
		expect(urls[3].pathname).toBe(
			`/api/narrators/${encodeURIComponent(narratorId)}/tool-calls/${encodeURIComponent(toolUseId)}/file-edit-preview`,
		);
		expect(Object.fromEntries(urls[3].searchParams)).toEqual(ref);
		expect(signals[3]).toBe(signal);
	});

	test("retry buffer encodes both identifiers and preserves queued-without-wake response", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		const requests: { url: string; method?: string }[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (url: string, init?: RequestInit) => {
				requests.push({ url, method: init?.method });
				return Response.json({ ok: true, resumed: false });
			},
			configurable: true,
		});
		expect(await api.retryBufferedMessage("n/a?", "m/b#")).toEqual({ ok: true, resumed: false });
		expect(requests).toEqual([
			{ url: "/api/narrators/n%2Fa%3F/buffer/m%2Fb%23/retry", method: "POST" },
		]);
	});

	test("keeps the edit draft unless the request explicitly succeeds", () => {
		expect(shouldClearEditDraft(true)).toBe(true);
		expect(shouldClearEditDraft(false)).toBe(false);
		expect(shouldClearEditDraft({ ok: true })).toBe(false);
	});

	test("maps edit-and-regenerate ok:false to false", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(JSON.stringify({ ok: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			configurable: true,
		});
		expect(await api.editAndRegenerate("narrator-1", "message-1", "draft")).toEqual({ ok: false });
	});

	test("sends the edit's revert choice and scope", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		let requestInit: RequestInit | undefined;
		Object.defineProperty(g, "fetch", {
			value: async (_url: string, init?: RequestInit) => {
				requestInit = init;
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			configurable: true,
		});

		await api.editAndRegenerate("narrator-1", "message-1", "draft", {
			skipRevert: true,
			scope: "workspace",
		});

		expect(JSON.parse(String(requestInit?.body))).toMatchObject({
			content: "draft",
			skipRevert: true,
			scope: "workspace",
		});
	});

	test("omits the revert fields when the caller did not choose", async () => {
		// The server defaults to reverting; sending `skipRevert: false` unasked would
		// state a choice the caller never made.
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		let requestInit: RequestInit | undefined;
		Object.defineProperty(g, "fetch", {
			value: async (_url: string, init?: RequestInit) => {
				requestInit = init;
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			configurable: true,
		});

		await api.editAndRegenerate("narrator-1", "message-1", "draft");

		const body = JSON.parse(String(requestInit?.body));
		expect("skipRevert" in body).toBe(false);
		expect("scope" in body).toBe(false);
	});

	test("surfaces rollback warnings from an edit", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
						ok: true,
						warnings: [
							{ code: "SUBAGENT_CHANGES_REVERTED", changeCount: 2, sampleFilePaths: ["a.ts"] },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			configurable: true,
		});

		const result = await api.editAndRegenerate("narrator-1", "message-1", "draft");
		expect(result.ok).toBe(true);
		expect(result.warnings).toHaveLength(1);
	});

	test("preserves the COW retry ID contract", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL, init?: RequestInit) => {
				requestUrl = String(input);
				requestInit = init;
				return new Response(
					JSON.stringify({
						ok: true,
						messageId: "compact-new",
						oldMessageId: "compact-old",
						replacedMessageId: "compact-old",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			configurable: true,
		});

		const result: RetryFailedCompactResponse = await api.retryFailedCompact(
			"narrator-1",
			"compact-old",
			"provider:model",
		);
		expect(result).toEqual({
			ok: true,
			messageId: "compact-new",
			oldMessageId: "compact-old",
			replacedMessageId: "compact-old",
		});
		expect(requestUrl).toBe("/api/narrators/narrator-1/compact/compact-old/retry");
		expect(requestInit?.method).toBe("POST");
		expect(JSON.parse(String(requestInit?.body))).toEqual({ model: "provider:model" });
	});

	test("accepts the legacy same-ID retry response without aliases", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(JSON.stringify({ ok: true, messageId: "compact-old" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			configurable: true,
		});

		expect(await api.retryFailedCompact("narrator-1", "compact-old")).toEqual({
			ok: true,
			messageId: "compact-old",
		});
	});

	test("surfaces structured narrator message errors", async () => {
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
						code: "NARRATOR_MESSAGE_TOO_LONG",
						reason: "Narrator message is too long",
					}),
					{
						status: 413,
						statusText: "Payload Too Large",
						headers: { "content-type": "application/json" },
					},
				),
			configurable: true,
		});

		try {
			await api.sendNarratorMessage("narrator-1", "hello world");
			throw new Error("expected narrator message send to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(413);
			expect((err as Error).message).toBe("Narrator message is too long");
			expect((err as ApiError).data?.code).toBe("NARRATOR_MESSAGE_TOO_LONG");
		}
	});

	describe("interrupt-and-insert request fields", () => {
		test.each([
			false,
			true,
		])("one prioritized message request (multipart=%s)", async (multipart) => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => null },
				configurable: true,
			});
			const requests: { url: string; method?: string; body?: BodyInit | null }[] = [];
			Object.defineProperty(g, "fetch", {
				value: async (url: string, init: RequestInit) => {
					requests.push({ url, method: init.method, body: init.body });
					return Response.json({ buffered: true, id: "replacement" }, { status: 202 });
				},
				configurable: true,
			});
			const originalXHR = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
			class TestXHR {
				status = 202;
				statusText = "Accepted";
				responseText = '{"buffered":true,"id":"replacement"}';
				onload: (() => void) | null = null;
				url = "";
				method = "";
				open(method: string, url: string) {
					this.method = method;
					this.url = url;
				}
				setRequestHeader() {}
				getAllResponseHeaders() {
					return "Content-Type: application/json";
				}
				send(body: FormData) {
					requests.push({ url: this.url, method: this.method, body });
					queueMicrotask(() => this.onload?.());
				}
			}
			Object.defineProperty(globalThis, "XMLHttpRequest", { value: TestXHR, configurable: true });
			try {
				for (const interrupt of [undefined, false, true]) {
					requests.length = 0;
					const images = multipart
						? [new File(["image"], "a.png", { type: "image/png" })]
						: undefined;
					const textFiles = multipart ? [new File(["text"], "a.txt")] : undefined;
					const refs = [{ id: "ref", deviceId: "remote", path: "/work/a.ts", label: "a.ts" }];
					expect(
						await api.sendNarratorMessage(
							"n",
							"replace",
							images,
							textFiles,
							false,
							undefined,
							undefined,
							refs,
							interrupt,
						),
					).toEqual({ buffered: true, id: "replacement" });
					expect(requests).toHaveLength(1);
					expect(requests[0]).toMatchObject({ url: "/api/narrators/n/messages", method: "POST" });
					if (multipart) {
						const form = requests[0].body as FormData;
						expect(form.get("interrupt")).toBe(interrupt ? "true" : null);
						expect(form.get("priority")).toBe(interrupt ? "true" : null);
						expect(form.get("message")).toBe("replace");
						expect(form.getAll("images")).toHaveLength(1);
						expect(form.getAll("textFiles")).toHaveLength(1);
						expect(JSON.parse(String(form.get("fileReferences")))).toEqual(refs);
					} else {
						expect(JSON.parse(String(requests[0].body))).toEqual({
							message: "replace",
							fileReferences: refs,
							...(interrupt ? { interrupt: true, priority: true } : {}),
						});
					}
				}
			} finally {
				if (originalXHR) Object.defineProperty(globalThis, "XMLHttpRequest", originalXHR);
				else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
			}
		});
	});

	describe("file reference request fields", () => {
		const reference = { id: "ref-1", deviceId: "RemoteCaseID", path: "/work/a.ts", label: "a.ts" };

		test.each([
			false,
			true,
		])("send/edit/queue agree on omitted, empty and populated refs (multipart=%s)", async (multipart) => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
				configurable: true,
			});
			const requests: RequestInit[] = [];
			Object.defineProperty(g, "fetch", {
				value: async (_url: unknown, init: RequestInit) => {
					requests.push(init);
					return Response.json({ ok: true });
				},
				configurable: true,
			});
			const originalXHR = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
			class TestXHR {
				status = 200;
				statusText = "OK";
				responseText = '{"ok":true}';
				onload: (() => void) | null = null;
				open() {}
				setRequestHeader() {}
				getAllResponseHeaders() {
					return "Content-Type: application/json";
				}
				send(body: FormData) {
					requests.push({ method: "POST", body });
					queueMicrotask(() => this.onload?.());
				}
			}
			Object.defineProperty(globalThis, "XMLHttpRequest", { value: TestXHR, configurable: true });
			try {
				for (const fileReferences of [undefined, [], [reference]]) {
					const uploads = multipart
						? [new File(["x"], "a.txt", { type: "text/plain" })]
						: undefined;
					await api.sendNarratorMessage(
						"n",
						"",
						undefined,
						uploads,
						true,
						undefined,
						undefined,
						fileReferences,
					);
					await api.editAndRegenerate("n", "m", "", { newTextFiles: uploads, fileReferences });
					await api.updateBufferedMessage("n", "q", "", { newTextFiles: uploads, fileReferences });
					for (const request of requests.splice(0)) {
						if (multipart) {
							expect(request.body).toBeInstanceOf(FormData);
							const form = request.body as FormData;
							expect(form.has("fileReferences")).toBe(fileReferences !== undefined);
							if (fileReferences !== undefined)
								expect(JSON.parse(String(form.get("fileReferences")))).toEqual(fileReferences);
						} else {
							const body = JSON.parse(String(request.body));
							expect("fileReferences" in body).toBe(fileReferences !== undefined);
							expect(body.fileReferences).toEqual(fileReferences);
						}
					}
				}
			} finally {
				if (originalXHR) Object.defineProperty(globalThis, "XMLHttpRequest", originalXHR);
				else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
			}
		});

		test("reference-only drafts share the text sync request", async () => {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
				configurable: true,
			});
			let sent: unknown;
			Object.defineProperty(g, "fetch", {
				value: async (_url: unknown, init: RequestInit) => {
					sent = JSON.parse(String(init.body));
					return Response.json({
						hasDraft: true,
						text: "",
						fileReferences: [reference],
						revision: 4,
					});
				},
				configurable: true,
			});
			const result = await api.updateNarratorDraft("n", "", "tab", [reference]);
			expect(sent).toEqual({
				text: "",
				sourceId: "tab",
				fileReferences: [reference],
			});
			expect(result.fileReferences).toEqual([reference]);
		});
	});

	describe("transcript export", () => {
		function stubFetch(response: Response, capture?: { url?: string }) {
			Object.defineProperty(g, "localStorage", {
				value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
				configurable: true,
			});
			Object.defineProperty(g, "fetch", {
				value: async (input: RequestInfo | URL) => {
					if (capture) capture.url = String(input);
					return response;
				},
				configurable: true,
			});
		}

		test("sends every option and returns the server's filename", async () => {
			const capture: { url?: string } = {};
			stubFetch(
				new Response("# transcript", {
					status: 200,
					headers: {
						"content-type": "text/markdown; charset=utf-8",
						"content-disposition":
							"attachment; filename=\"narrafork-s-20260803-1020.md\"; filename*=UTF-8''narrafork-%E4%BC%9A%E8%AF%9D-20260803-1020.md",
					},
				}),
				capture,
			);

			const result = await api.exportNarratorMessages("narrator-1", {
				format: "markdown",
				scope: "full",
				includeToolIO: true,
				lang: "zh-CN",
			});

			expect(capture.url).toContain("/api/narrators/narrator-1/export?");
			expect(capture.url).toContain("format=markdown");
			expect(capture.url).toContain("scope=full");
			expect(capture.url).toContain("includeToolIO=true");
			expect(capture.url).toContain("lang=zh-CN");
			// filename* wins, so the real (CJK) title survives.
			expect(result.fileName).toBe("narrafork-会话-20260803-1020.md");
			expect(await result.blob.text()).toBe("# transcript");
		});

		test("includeToolIO=false is sent explicitly, not dropped", async () => {
			const capture: { url?: string } = {};
			stubFetch(new Response("{}", { status: 200 }), capture);
			await api.exportNarratorMessages("n1", {
				format: "json",
				scope: "visible",
				includeToolIO: false,
				lang: "en",
			});
			expect(capture.url).toContain("includeToolIO=false");
			expect(capture.url).toContain("scope=visible");
		});

		test("an unknown language falls back to en", async () => {
			const capture: { url?: string } = {};
			stubFetch(new Response("{}", { status: 200 }), capture);
			await api.exportNarratorMessages("n1", {
				format: "json",
				scope: "full",
				includeToolIO: true,
				lang: "de-DE",
			});
			expect(capture.url).toContain("lang=en");
		});

		test("a failed export raises ApiError instead of downloading the error body", async () => {
			stubFetch(
				new Response(JSON.stringify({ error: "Narrator not found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
			);
			try {
				await api.exportNarratorMessages("missing", {
					format: "markdown",
					scope: "full",
					includeToolIO: true,
					lang: "en",
				});
				throw new Error("expected export to fail");
			} catch (err) {
				expect(err).toBeInstanceOf(ApiError);
				expect((err as ApiError).status).toBe(404);
				expect((err as Error).message).toBe("Narrator not found");
			}
		});
	});
});

describe("Content-Disposition filename parsing", () => {
	test("filename* takes precedence over the ASCII fallback", () => {
		expect(
			parseContentDispositionFileName(
				"attachment; filename=\"fallback.md\"; filename*=UTF-8''real-%E5%90%8D.md",
			),
		).toBe("real-名.md");
	});

	test("the quoted filename is used when no filename* is present", () => {
		expect(parseContentDispositionFileName('attachment; filename="plain.json"')).toBe("plain.json");
	});

	test("an unquoted filename is accepted", () => {
		expect(parseContentDispositionFileName("attachment; filename=bare.md")).toBe("bare.md");
	});

	test("a path in the header cannot escape into the download name", () => {
		expect(parseContentDispositionFileName('attachment; filename="../../etc/passwd"')).toBe(
			"passwd",
		);
		expect(parseContentDispositionFileName("attachment; filename*=UTF-8''..%2F..%2Fevil.md")).toBe(
			"evil.md",
		);
	});

	test("a missing or unusable header yields null so the caller names the file", () => {
		expect(parseContentDispositionFileName(null)).toBeNull();
		expect(parseContentDispositionFileName("attachment")).toBeNull();
		expect(parseContentDispositionFileName('attachment; filename=".."')).toBeNull();
	});

	test("malformed percent-encoding falls back rather than throwing", () => {
		expect(
			parseContentDispositionFileName("attachment; filename=\"ok.md\"; filename*=UTF-8''%E0%A4%A"),
		).toBe("ok.md");
	});
});
