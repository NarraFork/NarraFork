import { afterEach, describe, expect, test } from "bun:test";
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

		test("reference-only drafts share the text CAS request", async () => {
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
			const result = await api.updateNarratorDraft("n", "", 3, "tab", [reference]);
			expect(sent).toEqual({
				text: "",
				baseRevision: 3,
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
