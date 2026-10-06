import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BenchProvider } from "./client";
import { redactExperimentError } from "./error-redaction";

// bunfig.toml's tests/preload.ts isolates proxy/settings imports. Do not mock the
// proxy module: Bun's module mocks would leak into other test files in the process.
const FAKE_KEY = "fake-experiment-credential-7d30c891-only-for-tests";
const encoder = new TextEncoder();
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
	const blockNetwork = () => {
		throw new Error("Unexpected network request in experiment client test");
	};
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(blockNetwork, { preconnect: blockNetwork }),
	);
});

afterEach(() => {
	fetchSpy.mockRestore();
});

function provider(apiKey = FAKE_KEY, protocol: "codex" | "anthropic" = "codex") {
	return new BenchProvider({
		baseUrl: "https://experiment.invalid",
		apiKey,
		protocol,
		model: "fake-model",
		modelHash: "fake-model-hash",
		proxy: { mode: "direct" },
	});
}

function mockResponse(chunks: (string | Uint8Array)[], status = 200, hangOnCancel = false) {
	const state = { reads: 0, cancelled: false };
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[state.reads++];
				if (chunk === undefined) controller.close();
				else controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
			},
			cancel() {
				state.cancelled = true;
				if (hangOnCancel) return new Promise<void>(() => {});
			},
		},
		{ highWaterMark: 0 },
	);
	fetchSpy.mockResolvedValue(new Response(stream, { status }));
	return state;
}

function sse(data: unknown) {
	return `data: ${JSON.stringify(data)}\n\n`;
}

async function errorFromChat(client = provider(), signal = new AbortController().signal) {
	let caught: unknown;
	try {
		for await (const _event of client.chat({
			history: [],
			content: "test only",
			model: "fake-model",
			tools: [],
			toolResults: [],
			conversationId: "fake-conversation",
			signal,
		})) {
			// Consume the protocol-only stream without making any other requests.
		}
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	return String(caught);
}

describe("experiment client error redaction", () => {
	for (const protocol of ["codex", "anthropic"] as const) {
		test(`${protocol} standard SSE errors redact without adapter registration`, async () => {
			mockResponse([sse({ type: "error", error: { message: `Invalid key: ${FAKE_KEY}` } })]);
			const error = await errorFromChat(provider(FAKE_KEY, protocol));
			expect(error).toContain("UPSTREAM_ERROR");
			expect(error).toContain("[REDACTED]");
			expect(error).not.toContain(FAKE_KEY);
		});
	}

	for (const type of ["error", "response.failed"]) {
		test(`${type} redacts before the former 1500-character JSON cutoff`, async () => {
			const details = { padding: "x".repeat(1450), message: `Invalid key: ${FAKE_KEY}` };
			mockResponse([
				sse(type === "error" ? { type, error: details } : { type, response: { error: details } }),
			]);
			const error = await errorFromChat();
			expect(error).not.toContain(FAKE_KEY.slice(0, 12));
			expect(error).toContain("[REDACTED]");
			expect(error.length).toBeLessThanOrEqual(1900);
		});
	}

	test("response.failed redacts known credential fragments in separate SSE fields", async () => {
		const split = 25;
		mockResponse([
			sse({
				type: "response.failed",
				response: {
					error: {
						message: `Invalid key: ${FAKE_KEY.slice(0, split)}`,
						detail: FAKE_KEY.slice(split),
					},
				},
			}),
		]);
		const error = await errorFromChat();
		expect(error).toContain("RESPONSE_FAILED");
		expect(error).not.toContain(FAKE_KEY.slice(0, split));
		expect(error).not.toContain(FAKE_KEY.slice(split));
	});

	test("HTTP errors redact a complete credential spanning chunks", async () => {
		mockResponse([`Invalid key: ${FAKE_KEY.slice(0, 19)}`, `${FAKE_KEY.slice(19)}; denied`], 401);
		const error = await errorFromChat();
		expect(error).toContain("HTTP 401");
		expect(error).toContain("[REDACTED]");
		expect(error).not.toContain(FAKE_KEY);
	});

	test("HTTP input cutoff cancels rather than reading the remaining secret", async () => {
		const state = mockResponse(
			[`${"x".repeat(11_976)} key=`, FAKE_KEY.slice(0, 24), FAKE_KEY.slice(24), "unread"],
			401,
		);
		const error = await errorFromChat();
		expect(error).not.toContain(FAKE_KEY.slice(0, 12));
		expect(state.cancelled).toBe(true);
		expect(state.reads).toBe(2);
	});

	test("JSON-escaped credentials are removed from SSE diagnostics", async () => {
		const key = 'fake-quoted-"credential\\test-only';
		mockResponse([sse({ type: "error", error: { message: `Invalid key: ${key}` } })]);
		const error = await errorFromChat(provider(key));
		expect(error).toContain("[REDACTED]");
		expect(error).not.toContain(JSON.stringify(key).slice(1, -1));
		expect(error).not.toContain("fake-quoted-");
	});

	test("Bearer text is redacted even when it is not the configured key", async () => {
		mockResponse([
			sse({ type: "error", error: { message: "Authorization: Bearer fake-other-key" } }),
		]);
		const error = await errorFromChat();
		expect(error).toContain("Bearer [REDACTED]");
		expect(error).not.toContain("fake-other-key");
	});

	test("fetch rejections use the same redaction and preserve the request AbortSignal", async () => {
		const controller = new AbortController();
		fetchSpy.mockRejectedValue(new Error(`fetch failed with credential ${FAKE_KEY}`));
		const error = await errorFromChat(provider(), controller.signal);
		expect(error).not.toContain(FAKE_KEY);
		expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
	});

	test("multiple SSE data fields and transport chunks share one redaction boundary", async () => {
		const frame = `data: {"type":"error",\r\ndata: "error":{"message":"${FAKE_KEY}"}}\r\n\r\n`;
		const split = frame.indexOf(FAKE_KEY) + 17;
		mockResponse([frame.slice(0, split), frame.slice(split)]);
		const error = await errorFromChat();
		expect(error).toContain("[REDACTED]");
		expect(error).not.toContain(FAKE_KEY);
	});

	for (const prefix of [`Bearer ${"x".repeat(11_969)} key=`, `Bearer ${"界".repeat(3989)} key=`]) {
		test(`HTTP cutoff is safe after earlier redaction shrinks ${encoder.encode(prefix).length} bytes`, async () => {
			const available = 12_000 - encoder.encode(prefix).length;
			const state = mockResponse([prefix + FAKE_KEY, "never read"], 403);
			const error = await errorFromChat();
			expect(available).toBeGreaterThan(0);
			expect(error).toContain("key=[REDACTED]");
			expect(error).not.toContain(FAKE_KEY.slice(0, available));
			expect(state.reads).toBe(1);
			expect(state.cancelled).toBe(true);
		});
	}

	test("HTTP cutoff withholds a one-character prefix even without a token separator", async () => {
		const prefix = `Bearer ${"x".repeat(11_979)} ${"p".repeat(12)}`;
		expect(encoder.encode(prefix).length).toBe(11_999);
		mockResponse([prefix + FAKE_KEY, "never read"], 403);
		const error = await errorFromChat();
		expect(error).toContain(`${"p".repeat(12)}[REDACTED]`);
		expect(error).not.toContain("p".repeat(12) + FAKE_KEY.slice(0, 1));
	});

	test("HTTP decoding preserves UTF-8 credentials split in the middle of a code point", async () => {
		const key = "fake-凭据-测试专用-12345";
		const encoded = encoder.encode(`key: ${key}`);
		const split = encoder.encode("key: fake-").length + 1;
		mockResponse([encoded.subarray(0, split), encoded.subarray(split)], 401);
		const error = await errorFromChat(provider(key));
		expect(error).toContain("[REDACTED]");
		expect(error).not.toContain("凭据");
		expect(error).not.toContain("fake-");
	});

	for (const [label, content, expected] of [
		["total byte", "x".repeat(2_000_001), "SSE byte budget exceeded"],
		["unterminated frame", "x".repeat(1_000_001), "SSE frame budget exceeded"],
		["complete frame", sse({ message: "x".repeat(1_000_001) }), "SSE frame budget exceeded"],
	] as const) {
		test(`SSE ${label} input budget cancels before any additional read`, async () => {
			const state = mockResponse([content, "must not be read"]);
			const error = await errorFromChat();
			expect(error).toContain(expected);
			expect(state.reads).toBe(1);
			expect(state.cancelled).toBe(true);
		});
	}

	test("malformed SSE JSON never exposes the engine's truncated input excerpt", async () => {
		mockResponse([`data: ${FAKE_KEY} is not JSON\n\n`]);
		const error = await errorFromChat();
		expect(error).toContain("Invalid SSE JSON");
		expect(error).not.toContain(FAKE_KEY.slice(0, 8));
	});

	for (const status of [200, 401]) {
		test(`AbortSignal cancels a stalled ${status === 200 ? "SSE" : "HTTP error"} body`, async () => {
			const controller = new AbortController();
			let cancelled = false;
			const response = new Response(
				new ReadableStream<Uint8Array>(
					{
						pull() {
							queueMicrotask(() => controller.abort());
						},
						cancel() {
							cancelled = true;
						},
					},
					{ highWaterMark: 0 },
				),
				{ status },
			);
			fetchSpy.mockResolvedValue(response);
			const error = await errorFromChat(provider(), controller.signal);
			expect(error).toStartWith("AbortError:");
			expect(cancelled).toBe(true);
			expect(response.body?.locked).toBe(false);
		}, 1000);
	}

	test("an already-aborted request does not call fetch", async () => {
		const controller = new AbortController();
		controller.abort(new Error(`Cancelled with ${FAKE_KEY}`));
		const error = await errorFromChat(provider(), controller.signal);
		expect(error).not.toContain(FAKE_KEY);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	for (const status of [200, 401]) {
		test(`a stalled cancel hook cannot delay a ${status} error diagnostic`, async () => {
			const state = mockResponse(
				status === 200
					? [sse({ type: "error", error: { message: FAKE_KEY } })]
					: [`Bearer ${"x".repeat(12_000)}`],
				status,
				true,
			);
			const error = await errorFromChat();
			expect(error).toContain("[REDACTED]");
			expect(state.cancelled).toBe(true);
		}, 1000);
	}
});

describe("redactExperimentError pure helper", () => {
	test("redacts full known credentials before every output cutoff", () => {
		for (let limit = 0; limit < FAKE_KEY.length + 15; limit++) {
			const error = redactExperimentError(`deny ${FAKE_KEY} now`, [FAKE_KEY], limit);
			expect(error.length).toBeLessThanOrEqual(limit);
			expect(error).not.toContain(FAKE_KEY.slice(0, 1));
		}
	});

	test("withholds all possible prefixes at an already-bounded input edge", () => {
		for (let cut = 1; cut < FAKE_KEY.length; cut++) {
			const error = redactExperimentError(`deny@${FAKE_KEY.slice(0, cut)}`, [FAKE_KEY]);
			expect(error).toBe("deny@[REDACTED]");
		}
	});

	test("JSON escape cut points withhold the entire key prefix, including punctuation", () => {
		const key = 'fake-quoted-"credential\\x-test-only';
		const escaped = JSON.stringify(key).slice(1, -1);
		const unicode = [...key]
			.map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join("");
		for (const representation of [escaped, unicode]) {
			for (let cut = 1; cut < representation.length; cut++) {
				expect(redactExperimentError(`padding${representation.slice(0, cut)}`, [key])).toBe(
					"padding[REDACTED]",
				);
			}
		}
	});

	test("withholds short and long fragments split between JSON fields", () => {
		for (let cut = 1; cut < FAKE_KEY.length; cut++) {
			const error = redactExperimentError(
				JSON.stringify({ prefixField: FAKE_KEY.slice(0, cut), suffixField: FAKE_KEY.slice(cut) }),
				[FAKE_KEY],
			);
			expect(error).toBe('{"prefixField":"[REDACTED]","suffixField":"[REDACTED]"}');
		}
	});

	test("known fragment matching respects ordinary-word boundaries", () => {
		const message = "diagnostic: pre_fake-experiment_post";
		expect(redactExperimentError(message, [FAKE_KEY])).toBe(message);
	});

	test("raw, JSON, nested JSON and alternate Unicode escape spellings are safe", () => {
		const key = 'fake-/quoted-"key\\test\n-only';
		const unicode = [...key]
			.map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join("");
		for (const input of [key, JSON.stringify(key), JSON.stringify(JSON.stringify(key)), unicode]) {
			const error = redactExperimentError(input, [key]);
			expect(error).toContain("[REDACTED]");
			expect(error).not.toContain("fake-");
			expect(error).not.toContain("quoted-");
			expect(error).not.toContain("\\u0066");
		}
	});

	test("Bearer removal works before known fragments and after JSON decoding", () => {
		for (const message of ["Bearer fake-unregistered", "Bearer\\t\\u0066ake-unregistered"]) {
			const error = redactExperimentError(message, ["fake-Bearer-config-key"]);
			expect(error).toContain("[REDACTED]");
			expect(error).not.toContain("fake-unregistered");
		}
	});

	test("Error values use String semantics and repeated redaction is stable", () => {
		for (const key of [FAKE_KEY, "D", "REDACTED"]) {
			const once = redactExperimentError(new Error(`denied: ${key}`), [key]);
			expect(once).toStartWith("Error:");
			expect(redactExperimentError(once, [key])).toBe(once);
		}
	});

	test("all public output sizes have a hard upper bound", () => {
		const message = "x".repeat(30_000);
		expect(redactExperimentError(message, []).length).toBe(1800);
		expect(redactExperimentError(message, [], 1_000_000).length).toBe(12_000);
		expect(redactExperimentError(message, [], Number.NaN).length).toBe(1800);
		expect(redactExperimentError(message, [], -1)).toBe("");
	});

	test("oversized/unprintable inputs and oversized secret collections fail closed", () => {
		expect(redactExperimentError(FAKE_KEY + "x".repeat(2_000_000), [FAKE_KEY])).toContain("budget");
		expect(redactExperimentError(FAKE_KEY, ["x".repeat(4097), FAKE_KEY])).toContain("budget");
		expect(
			redactExperimentError(
				{
					toString: () => {
						throw new Error(FAKE_KEY);
					},
				},
				[FAKE_KEY],
			),
		).not.toContain(FAKE_KEY);
		let inspected = 0;
		function* manySecrets() {
			for (;;) {
				inspected++;
				yield "";
			}
		}
		expect(redactExperimentError(FAKE_KEY, manySecrets())).toContain("budget");
		expect(inspected).toBe(65);
	});
});
