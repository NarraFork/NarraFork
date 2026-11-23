import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as bridge from "../../../db/worker-read";
import { readKnowledgeIds, readKnowledgePages } from "../sqlite-read-pages";

const query = () =>
	Object.assign(Promise.resolve<unknown[]>([]), {
		toSQL: () => ({ sql: "SELECT 1", params: [] }),
	});
afterEach(() => mock.restore());

test("pages preserve rows, the final partial page and the caller's cancellation budget", async () => {
	const read = spyOn(bridge, "readQuery").mockResolvedValueOnce([1, 2]).mockResolvedValueOnce([3]);
	const signal = new AbortController().signal,
		deadlineAt = Date.now() + 10_000;
	expect(await readKnowledgePages(5, 2, query, { signal, deadlineAt })).toEqual([1, 2, 3]);
	expect(read).toHaveBeenCalledTimes(2);
	for (const call of read.mock.calls)
		expect(call[1]).toMatchObject({
			signal,
			deadlineAt,
			maxRows: 2,
			executionPolicy: "worker-required",
		});
});

test("empty windows do not submit reads and invalid budgets fail explicitly", async () => {
	const read = spyOn(bridge, "readQuery");
	expect(await readKnowledgePages(0, 1, query)).toEqual([]);
	for (const [limit, size] of [
		[-1, 1],
		[10_001, 1],
		[1, 0],
		[1, 129],
	]) {
		let error: unknown;
		try {
			await readKnowledgePages(limit, size, query);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
	}
	expect(read).not.toHaveBeenCalled();
});

test("cumulative page bytes fail instead of returning a truncated successful window", async () => {
	const read = spyOn(bridge, "readQuery").mockResolvedValue(["x".repeat(8 * 1024 * 1024)]);
	let error: unknown;
	try {
		await readKnowledgePages(10, 1, query);
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "DB_READ_BUDGET" });
	expect(read).toHaveBeenCalledTimes(8);
});

test("identity batches deduplicate, preserve the complete result and bound inputs", async () => {
	const ids = Array.from({ length: 201 }, (_, i) => String(i));
	const batches: string[][] = [];
	expect(
		await readKnowledgeIds([...ids, ...ids], async (batch) => {
			batches.push(batch);
			return batch;
		}),
	).toEqual(ids);
	expect(batches.map((batch) => batch.length)).toEqual([100, 100, 1]);
	expect(
		await readKnowledgeIds([], async () => {
			throw new Error("Unexpected read");
		}),
	).toEqual([]);
	let error: unknown;
	try {
		await readKnowledgeIds(Array(10_001).fill("id"), async () => []);
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "DB_READ_BUDGET" });
});
