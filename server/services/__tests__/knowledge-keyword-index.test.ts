import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as workerPool from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import {
	compileMatcher,
	getCompiledMatcher,
	type KeywordCandidate,
	matchWithCompiledMatcher,
} from "../knowledge/keyword-index";
import { knowledgeInjectionReads, knowledgeService } from "../knowledge-service";

let collectionId: string;
beforeEach(async () => {
	collectionId = (await knowledgeService.createCollection({ name: generateId() })).id;
});
afterEach(() => mock.restore());
afterAll(() => workerPool.shutdownDbWorkerPool());

function candidate(id = generateId()): KeywordCandidate {
	return {
		scope: "global",
		id,
		collectionId,
		title: "关键词索引",
		entryRevisionId: null,
		tags: [],
		keywords: ["indexneedle", "中文关键词"],
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("candidate reads and matcher construction use background workers", async () => {
	const entry = await knowledgeService.createEntry({
		collectionId,
		title: "后台索引",
		content: "不进入索引构建消息的正文",
		keywords: ["indexneedle"],
	});
	const run = spyOn(workerPool, "runReadTask");
	const matcher = await getCompiledMatcher({ collectionId });
	expect(matchWithCompiledMatcher("indexneedle", matcher).map((row) => row.id)).toEqual([entry.id]);
	const queries = run.mock.calls.map((call) => call[1]);
	expect(
		queries.some(
			(query) => query.kind === "selectRows" && query.sql.includes('"knowledge_entries"'),
		),
	).toBe(true);
	expect(queries.some((query) => query.kind === "knowledgeKeywordMatcher")).toBe(true);
	expect(JSON.stringify(queries)).not.toContain("不进入索引构建消息的正文");
});

test("simultaneous requests for the same scope share a single index refresh", async () => {
	const item = candidate();
	const gate = deferred<KeywordCandidate[]>();
	const read = spyOn(knowledgeInjectionReads, "listKeywordInjectionCandidates").mockReturnValue(
		gate.promise,
	);
	const first = getCompiledMatcher({ collectionId });
	const second = getCompiledMatcher({ collectionId });
	gate.resolve([item]);
	const [left, right] = await Promise.all([first, second]);
	expect(read).toHaveBeenCalledTimes(1);
	expect(left).toBe(right);
	expect(matchWithCompiledMatcher("中文关键词 indexneedle", left).map((row) => row.id)).toEqual([
		item.id,
	]);
});

test("an already-aborted request performs no signature read", async () => {
	const read = spyOn(knowledgeInjectionReads, "keywordInjectionCandidatesSignature");
	const signal = AbortSignal.abort(new Error("index cancelled"));
	await expect(getCompiledMatcher({ collectionId, signal })).rejects.toThrow("index cancelled");
	expect(read).not.toHaveBeenCalled();
});

test("one cancelled waiter cannot cancel another waiter's shared build", async () => {
	const item = candidate();
	const gate = deferred<KeywordCandidate[]>();
	const read = spyOn(knowledgeInjectionReads, "listKeywordInjectionCandidates").mockReturnValue(
		gate.promise,
	);
	const controller = new AbortController();
	const first = getCompiledMatcher({ collectionId, signal: controller.signal });
	const firstOutcome = first.then(
		() => "resolved",
		(error: Error) => error.message,
	);
	const second = getCompiledMatcher({ collectionId });
	controller.abort(new Error("only first cancelled"));
	gate.resolve([item]);
	expect(await firstOutcome).toBe("only first cancelled");
	expect(matchWithCompiledMatcher("indexneedle", await second).map((row) => row.id)).toEqual([
		item.id,
	]);
	expect(read).toHaveBeenCalledTimes(1);
});

test("abandoning all waiters cancels the underlying read and does not cache its result", async () => {
	const entered = deferred<void>();
	const gate = deferred<KeywordCandidate[]>();
	let signal: AbortSignal | undefined;
	spyOn(knowledgeInjectionReads, "listKeywordInjectionCandidates").mockImplementationOnce(
		(opts) => {
			signal = opts?.signal;
			entered.resolve();
			return gate.promise;
		},
	);
	const controller = new AbortController();
	const pending = getCompiledMatcher({ collectionId, signal: controller.signal });
	const outcome = pending.then(
		() => "resolved",
		(error: Error) => error.message,
	);
	await entered.promise;
	controller.abort(new Error("all cancelled"));
	gate.resolve([candidate()]);
	expect(await outcome).toBe("all cancelled");
	expect(signal?.aborted).toBe(true);
	const matcher = await getCompiledMatcher({ collectionId });
	expect(matchWithCompiledMatcher("indexneedle", matcher)).toEqual([]);
});

test("an unavailable worker never falls back to synchronous matcher construction", async () => {
	spyOn(knowledgeInjectionReads, "listKeywordInjectionCandidates").mockResolvedValue([candidate()]);
	const run = workerPool.runReadTask;
	spyOn(workerPool, "runReadTask").mockImplementation((path, params, opts) => {
		if (params.kind === "knowledgeKeywordMatcher")
			return Promise.reject(new Error("index worker unavailable"));
		return run(path, params, opts);
	});
	await expect(getCompiledMatcher({ collectionId })).rejects.toThrow("index worker unavailable");
});

test("matcher budgets reject excessive candidate and keyword input instead of building it", () => {
	const item = candidate();
	expect(() => compileMatcher(Array.from({ length: 5001 }, () => item))).toThrow(/budget/i);
	expect(() => compileMatcher([{ ...item, keywords: ["x".repeat(513)] }])).toThrow(/budget/i);
});

test("replacing an abandoned refresh cannot bypass the global job limit", async () => {
	const entered = Array.from({ length: 4 }, () => deferred<void>());
	const gate = deferred<KeywordCandidate[]>();
	let started = 0;
	spyOn(knowledgeInjectionReads, "listKeywordInjectionCandidates").mockImplementation(() => {
		entered[started++]?.resolve();
		return gate.promise;
	});
	try {
		for (let i = 0; i < 4; i++) {
			const controller = new AbortController();
			const request = getCompiledMatcher({ collectionId, signal: controller.signal });
			const cancelled = request.catch(() => undefined);
			await entered[i].promise;
			controller.abort();
			await cancelled;
		}
		const rejected = expect(getCompiledMatcher({ collectionId })).rejects.toThrow(/busy/i);
		gate.resolve([]);
		await rejected;
	} finally {
		gate.resolve([]);
		await Promise.resolve();
	}
});

test("dense repeated keyword matches have a bounded work budget", () => {
	const item = {
		...candidate(),
		keywords: Array.from({ length: 128 }, (_, i) => "中".repeat(i + 1)),
	};
	const matcher = compileMatcher([item]);
	expect(matchWithCompiledMatcher("中".repeat(8192), matcher)).toEqual([]);
});

test("an oversized live keyword edit is omitted rather than breaking injection", async () => {
	const entry = await knowledgeService.createEntry({
		collectionId,
		title: "Updated keyword",
		content: "Evidence",
		keywords: ["indexneedle"],
	});
	const { resolveInjections } = await import("../knowledge-injection");
	const { knowledgeReadStore } = await import("../knowledge/store");
	const original = knowledgeReadStore.getInjectionEvidence;
	spyOn(knowledgeReadStore, "getInjectionEvidence").mockImplementation(async (opts) => {
		const rows = await original(opts);
		return rows.map((row) =>
			row.id === entry.id ? { ...row, keywordsJson: ["indexneedle", "x".repeat(513)] } : row,
		);
	});
	expect(await resolveInjections(null, "indexneedle", { collectionId })).toEqual([]);
});
