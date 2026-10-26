import { expect, test } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { refreshPretextDocumentWindow } from "./pretext-document-loader";

const row = (id: string, seq: number) => rowWithElements({ id, seq }, []) as unknown as TreeMessage;
const previous = {
	messages: [row("source", 1), row("tail", 2)],
	messageVersion: 7,
	oldestLoadedSeq: 1,
	hasPrev: true,
};
const canonical = [row("source", 1), row("B", 2), row("A", 3), row("tail", 4)];
const page = (
	messages = canonical,
	messageVersion = 9,
	hasNext = false,
): PretextDocumentPageResult => ({
	messages,
	messageVersion,
	hasNext,
	hasPrev: true,
	minSeq: messages[0]?.seq ?? null,
	maxSeq: messages.at(-1)?.seq ?? null,
});

test("refresh gets canonical B/A ordering by stable first ID without seeking ask source", async () => {
	const result = await refreshPretextDocumentWindow("n", previous, {
		locateMessage: async (_id, messageId) => {
			expect(messageId).toBe("source");
			return { seq: 1 };
		},
		fetchPage: async (_id, options) => {
			expect(options.afterSeq).toBe(0);
			expect(options.limit).toBe(100);
			expect(options.signal).toBeDefined();
			return page();
		},
	});
	expect(result?.messages.map((m) => m.id)).toEqual(["source", "B", "A", "tail"]);
	expect(result?.messageVersion).toBe(9);
	expect(previous.messages.map((m) => m.id)).toEqual(["source", "tail"]);
});

test("refresh rejects a version drift instead of mixing pages", async () => {
	let reads = 0;
	const result = await refreshPretextDocumentWindow("n", previous, {
		locateMessage: async () => ({ seq: 1 }),
		fetchPage: async (_id, options) => {
			reads++;
			if (reads === 1) return page([row("source", 1)], 9, true);
			expect(options.messageVersion).toBe(9);
			return page([row("tail", 4)], 10);
		},
	});
	expect(result).toBeUndefined();
	expect(reads).toBe(2);
});

test("refresh stops at five pages and never publishes a partial window", async () => {
	let reads = 0;
	const result = await refreshPretextDocumentWindow("n", previous, {
		locateMessage: async () => ({ seq: 1 }),
		fetchPage: async () => {
			reads++;
			return page([row(reads === 1 ? "source" : `m${reads}`, reads)], 9, true);
		},
	});
	expect(reads).toBe(5);
	expect(result).toBeUndefined();
});

for (const count of [501, 3500]) {
	test(`refresh supports a ${count}-row historical window without losing its tail`, async () => {
		const oldRows = Array.from({ length: count }, (_, i) =>
			row(i === 0 ? "source" : `old-${i}`, i + 1),
		);
		const canonicalRows = [
			oldRows[0],
			row("new-ask", 2),
			...oldRows.slice(1).map((m) => ({ ...m, seq: (m.seq ?? 0) + 1 })),
		];
		let reads = 0;
		const result = await refreshPretextDocumentWindow(
			"n",
			{ ...previous, messages: oldRows },
			{
				locateMessage: async () => ({ seq: 1 }),
				fetchPage: async (_id, options) => {
					reads++;
					expect(options.maxResponseBytes).toBeGreaterThan(0);
					const messages = canonicalRows
						.filter((m) => (m.seq ?? 0) > (options.afterSeq ?? 0))
						.slice(0, options.limit);
					return page(messages, 9, messages.at(-1)?.id !== oldRows.at(-1)?.id);
				},
			},
		);
		expect(reads).toBe(Math.ceil((count + 1) / 100));
		expect(result?.messages).toHaveLength(count + 1);
		expect(result?.messages.at(-1)?.id).toBe(oldRows.at(-1)?.id);
		expect(result?.messages[1]?.id).toBe("new-ask");
	});
}

test("refresh enforces a cumulative byte budget across pages", async () => {
	let reads = 0;
	const result = await refreshPretextDocumentWindow("n", previous, {
		locateMessage: async () => ({ seq: 1 }),
		fetchPage: async (_id, options) => {
			reads++;
			if (reads === 1) {
				expect(options.maxResponseBytes).toBe(32 * 1024 * 1024);
				options.onResponseBytes?.(32 * 1024 * 1024 - 100);
				return page([row("source", 1)], 9, true);
			}
			expect(options.maxResponseBytes).toBe(100);
			options.onResponseBytes?.(101);
			return page([row("tail", 4)], 9);
		},
	});
	expect(reads).toBe(2);
	expect(result).toBeUndefined();
});

test("refresh rejects a locate/fetch race and an oversized existing window", async () => {
	const options = {
		locateMessage: async () => ({ seq: 1 }),
		fetchPage: async () => page([row("new-before-source", 1)]),
	};
	expect(await refreshPretextDocumentWindow("n", previous, options)).toBeUndefined();
	let located = false;
	expect(
		await refreshPretextDocumentWindow(
			"n",
			{ ...previous, messages: Array.from({ length: 10_001 }, (_, i) => row(`m${i}`, i)) },
			{
				...options,
				locateMessage: async () => {
					located = true;
					return { seq: 0 };
				},
			},
		),
	).toBeUndefined();
	expect(located).toBe(false);
});

test("a pre-aborted window never calls either transport", async () => {
	const controller = new AbortController();
	controller.abort();
	let reads = 0;
	await expect(
		refreshPretextDocumentWindow("n", previous, {
			signal: controller.signal,
			locateMessage: async () => {
				reads++;
				return { seq: 1 };
			},
			fetchPage: async () => {
				reads++;
				return page();
			},
		}),
	).rejects.toHaveProperty("name", "AbortError");
	expect(reads).toBe(0);
});

test("parent abort settles a window even when its custom transport ignores the signal", async () => {
	const controller = new AbortController();
	let opened = () => {};
	let signal: AbortSignal | undefined;
	const started = new Promise<void>((resolve) => {
		opened = resolve;
	});
	const result = refreshPretextDocumentWindow("n", previous, {
		signal: controller.signal,
		locateMessage: async () => ({ seq: 1 }),
		fetchPage: async (_id, options) => {
			signal = options.signal;
			opened();
			return new Promise<PretextDocumentPageResult>(() => {});
		},
	});
	const outcome = result.catch((error: Error) => error);
	await started;
	controller.abort();
	expect(((await outcome) as Error).name).toBe("AbortError");
	expect(signal?.aborted).toBe(true);
});

test("a shared window deadline rejects an abort-ignoring transport", async () => {
	await expect(
		refreshPretextDocumentWindow("n", previous, {
			windowTimeoutMs: 10,
			locateMessage: async () => ({ seq: 1 }),
			fetchPage: async () => new Promise<PretextDocumentPageResult>(() => {}),
		}),
	).rejects.toHaveProperty("name", "TimeoutError");
});

test("overlapping pages and malformed stable locations fail closed", async () => {
	let reads = 0;
	expect(
		await refreshPretextDocumentWindow("n", previous, {
			locateMessage: async () => ({ seq: 1 }),
			fetchPage: async () => {
				reads++;
				return reads === 1
					? page([row("source", 1), row("duplicate", 2)], 9, true)
					: page([row("duplicate", 3), row("tail", 4)]);
			},
		}),
	).toBeUndefined();
	expect(reads).toBe(2);
	for (const seq of [NaN, Infinity, -1, 1.5]) {
		expect(
			await refreshPretextDocumentWindow("n", previous, {
				locateMessage: async () => ({ seq }),
				fetchPage: async () => {
					throw new Error("invalid locations must not fetch pages");
				},
			}),
		).toBeUndefined();
	}
});
