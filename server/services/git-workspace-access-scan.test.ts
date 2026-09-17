import { describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { ACCESS_PAGE_SIZE, GitAccessScan } from "./git-workspace-access-scan";

const rows = Array.from({ length: 300 }, (_, i) => ({
	id: String(i).padStart(4, "0"),
	gitPath: `/fixture/${i}`,
}));
const unavailable = { statusCode: 503, code: "GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE" };

describe("Git access scan bounds", () => {
	test("stable cursor pages visit all rows with at most eight realpaths", async () => {
		const scan = new GitAccessScan();
		let active = 0,
			peak = 0,
			visited = 0;
		const cursors: (string | undefined)[] = [];
		try {
			for await (const page of scan.pagesOf(async (cursor) => {
				cursors.push(cursor);
				return rows.filter((row) => !cursor || row.id > cursor).slice(0, ACCESS_PAGE_SIZE);
			})) {
				await scan.canonicalize(
					page,
					() => {
						visited++;
					},
					async (path) => {
						peak = Math.max(peak, ++active);
						await setImmediate();
						active--;
						return path;
					},
				);
			}
			expect(visited).toBe(300);
			expect(peak).toBe(8);
			expect(cursors).toEqual([undefined, "0127", "0255"]);
		} finally {
			scan.dispose();
		}
	});

	test("never-resolving realpath times out, without scheduling more rows", async () => {
		const scan = new GitAccessScan(undefined, 20);
		let calls = 0;
		try {
			await expect(
				scan.canonicalize(
					rows,
					() => {},
					() => {
						calls++;
						return new Promise(() => {});
					},
				),
			).rejects.toMatchObject(unavailable);
			expect(calls).toBe(8);
		} finally {
			scan.dispose();
		}
	});

	test("abort prevents further pages, visits and scheduling; late rejection stays handled", async () => {
		const controller = new AbortController();
		const scan = new GitAccessScan(controller.signal);
		const rejects: ((error: Error) => void)[] = [];
		let loads = 0,
			visits = 0;
		const rejected: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			rejected.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const work = (async () => {
				for await (const page of scan.pagesOf(async () => {
					loads++;
					return rows.slice(0, ACCESS_PAGE_SIZE);
				})) {
					await scan.canonicalize(
						page,
						() => {
							visits++;
						},
						() =>
							new Promise((_, reject) => {
								rejects.push(reject);
							}),
					);
				}
			})();
			await setImmediate();
			controller.abort();
			await expect(work).rejects.toMatchObject(unavailable);
			for (const reject of rejects) reject(new Error("late failure"));
			await setImmediate();
			expect(rejects).toHaveLength(8);
			expect(loads).toBe(1);
			expect(visits).toBe(0);
			expect(rejected).toEqual([]);
		} finally {
			scan.dispose();
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	test("only missing registrations are skipped; uncertain errors fail closed with 503", async () => {
		for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EIO", "ABORT_ERR"]) {
			const scan = new GitAccessScan();
			try {
				const work = scan.canonicalize(
					rows.slice(0, 1),
					() => {
						throw new Error("must not visit");
					},
					async () => {
						throw Object.assign(new Error(code), { code });
					},
				);
				if (code === "ENOENT" || code === "ENOTDIR") await work;
				else await expect(work).rejects.toMatchObject(unavailable);
			} finally {
				scan.dispose();
			}
		}
	});

	test("shared deadline also bounds ACL work and prevents late authorization", async () => {
		const scan = new GitAccessScan(undefined, 20);
		let finish!: (value: boolean) => void;
		let authorized = false;
		try {
			const work = (async () => {
				await scan.run(
					() =>
						new Promise<boolean>((resolve) => {
							finish = resolve;
						}),
				);
				scan.check();
				authorized = true;
			})();
			await expect(work).rejects.toMatchObject(unavailable);
			finish(true);
			await setImmediate();
			expect(authorized).toBe(false);
		} finally {
			scan.dispose();
		}
	});
});
