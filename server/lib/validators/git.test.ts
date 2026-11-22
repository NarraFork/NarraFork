import { expect, test } from "bun:test";
import { GIT_STATUS_PAGE_MAX_BYTES, GIT_STATUS_PAGE_MAX_LIMIT } from "@shared/git-status-page";
import { gitStatusPageStatsQuerySchema } from "./git";

const row = { type: "directory", section: "unstaged", path: "src/中文 dir" } as const;
const query = (rows: unknown, filter?: string) => ({
	snapshotId: "snapshot",
	rows: JSON.stringify(rows),
	...(filter === undefined ? {} : { filter }),
});

test("statistics query preserves row identity and uses the existing filter wire format", () => {
	expect(gitStatusPageStatsQuerySchema.parse(query([row], "M,A"))).toEqual({
		snapshotId: "snapshot",
		filter: ["M", "A"],
		rows: [row],
	});
	for (const filter of [undefined, ""])
		expect(gitStatusPageStatsQuerySchema.parse(query([row], filter)).filter).toEqual([]);
});

test("statistics query accepts the existing maximum page count for directories", () => {
	const rows = Array.from({ length: GIT_STATUS_PAGE_MAX_LIMIT }, () => row);
	expect(gitStatusPageStatsQuerySchema.parse(query(rows)).rows).toHaveLength(
		GIT_STATUS_PAGE_MAX_LIMIT,
	);
	expect(gitStatusPageStatsQuerySchema.safeParse(query([...rows, row])).success).toBe(false);
});

test("statistics query accepts the exact existing page byte budget and rejects its next byte", () => {
	const rows = Array.from({ length: GIT_STATUS_PAGE_MAX_LIMIT }, () => ({
		...row,
		path: "a".repeat(1200),
	}));
	let remaining = GIT_STATUS_PAGE_MAX_BYTES - Buffer.byteLength(JSON.stringify(rows));
	expect(remaining).toBeGreaterThan(0);
	for (const entry of rows) {
		const extra = Math.min(remaining, 4096 - entry.path.length);
		entry.path += "a".repeat(extra);
		remaining -= extra;
		if (remaining === 0) break;
	}
	expect(remaining).toBe(0);
	expect(Buffer.byteLength(JSON.stringify(rows))).toBe(GIT_STATUS_PAGE_MAX_BYTES);
	expect(gitStatusPageStatsQuerySchema.safeParse(query(rows)).success).toBe(true);
	const last = rows.at(-1);
	if (!last) throw new Error("Expected boundary row fixture");
	last.path += "a";
	expect(Buffer.byteLength(JSON.stringify(rows))).toBe(GIT_STATUS_PAGE_MAX_BYTES + 1);
	expect(gitStatusPageStatsQuerySchema.safeParse(query(rows)).success).toBe(false);
});

test("statistics query measures Unicode rows in UTF-8 bytes", () => {
	const input = query(
		Array.from({ length: GIT_STATUS_PAGE_MAX_LIMIT }, () => ({
			...row,
			path: "文".repeat(600),
		})),
	);
	expect(input.rows.length).toBeLessThan(GIT_STATUS_PAGE_MAX_BYTES);
	expect(Buffer.byteLength(input.rows)).toBeGreaterThan(GIT_STATUS_PAGE_MAX_BYTES);
	expect(gitStatusPageStatsQuerySchema.safeParse(input).success).toBe(false);
});

test("statistics query shares the snapshot scope and Git read path lengths", () => {
	expect(
		gitStatusPageStatsQuerySchema.safeParse({ ...query([row]), snapshotId: "s".repeat(128) })
			.success,
	).toBe(true);
	expect(
		gitStatusPageStatsQuerySchema.safeParse({ ...query([row]), snapshotId: "s".repeat(129) })
			.success,
	).toBe(false);
	expect(
		gitStatusPageStatsQuerySchema.safeParse(query([{ ...row, path: "a".repeat(4096) }])).success,
	).toBe(true);
	expect(
		gitStatusPageStatsQuerySchema.safeParse(query([{ ...row, path: "a".repeat(4097) }])).success,
	).toBe(false);
});

for (const [name, input] of Object.entries({
	"JSON syntax": { ...query([row]), rows: "[" },
	"empty rows": query([]),
	"row type": query([{ ...row, type: "folder" }]),
	"row section": query([{ ...row, section: "all" }]),
	"row path": query([{ ...row, path: "" }]),
	"filter character": query([row], "Z"),
	"filter empty segment": query([row], "M,,A"),
	"missing snapshot": { ...query([row]), snapshotId: undefined },
})) {
	test(`statistics query rejects invalid ${name}`, () => {
		expect(gitStatusPageStatsQuerySchema.safeParse(input).success).toBe(false);
	});
}
