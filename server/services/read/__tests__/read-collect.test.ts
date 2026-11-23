import { expect, test } from "bun:test";
import { collectKeysetRows } from "../read-collect";

test("keysets collect every page in order, including an empty result", async () => {
	const pages = [[{ id: "a" }, { id: "b" }], [{ id: "c" }], []];
	const cursors: (string | null)[] = [];
	expect(
		await collectKeysetRows(
			async (after) => {
				cursors.push(after);
				return pages[cursors.length - 1];
			},
			(row) => row.id,
		),
	).toEqual(pages.flat());
	expect(cursors).toEqual([null, "b", "c"]);
	expect(
		await collectKeysetRows(
			async () => [],
			(row: { id: string }) => row.id,
		),
	).toEqual([]);
});

test("keysets propagate read errors rather than return an incomplete success", async () => {
	const failure = new Error("reader unavailable");
	const result = await collectKeysetRows(
		async (after) => {
			if (after === null) return [{ id: "a" }];
			throw failure;
		},
		(row) => row.id,
	).catch((error) => error);
	expect(result).toBe(failure);
});

test.each(["a", "0"])("keysets reject a non-advancing cursor %s", async (id) => {
	const result = await collectKeysetRows(
		async (after) => [{ id: after === null ? "a" : id }],
		(row) => row.id,
	).catch((error) => error);
	expect(result).toMatchObject({ message: "Database keyset cursor did not advance" });
});

test("keysets stop at the fixed page budget", async () => {
	let pages = 0;
	const result = await collectKeysetRows(
		async () => [{ id: (++pages).toString().padStart(5, "0") }],
		(row) => row.id,
	).catch((error) => error);
	expect(pages).toBe(20_000);
	expect(result).toMatchObject({ message: "Database keyset read exceeded its page budget" });
});
