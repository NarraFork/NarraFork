import { describe, expect, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { ACCESS_PAGE_SIZE, GitAccessScan } from "./git-workspace-access-scan";

const rows = Array.from({ length: 300 }, (_, i) => ({
	id: String(i).padStart(4, "0"),
	gitPath: `/fixture/${i}`,
}));
const unavailable = { statusCode: 503, code: "GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE" };

describe("Git access scan bounds", () => {
	test("a reused scan tightens its remaining budget without extending the shared deadline", () => {
		let elapsed = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
		const wall = spyOn(Date, "now").mockImplementation(() => 1_000_000 + elapsed);
		const scan = new GitAccessScan(undefined, 30_000);
		const signal = scan.signal;
		try {
			elapsed = 1000;
			scan.limitRemaining(5000);
			expect(scan.readOptions().timeoutMs).toBe(5000);
			expect(scan.deadlineAt).toBe(1_006_000);
			elapsed = 5000;
			scan.limitRemaining(5000);
			expect(scan.readOptions().timeoutMs).toBe(1000);
			expect(scan.signal).toBe(signal);
			elapsed = 6000;
			expect(() => scan.check()).toThrow();
			expect(signal.reason).toMatchObject(unavailable);
		} finally {
			scan.dispose();
			clock.mockRestore();
			wall.mockRestore();
		}
	});

	test("late scans inherit the total remaining deadline and successful cleanup keeps the signal usable", () => {
		let elapsed = 0;
		const monotonic = spyOn(performance, "now").mockImplementation(() => elapsed);
		const wall = spyOn(Date, "now").mockImplementation(() => 1_000_000 + elapsed);
		const total = new GitAccessScan(undefined, 30_000);
		let scan: GitAccessScan | undefined;
		try {
			elapsed = 28_000;
			scan = new GitAccessScan(total.signal, 5000, total.deadlineAt);
			expect(scan.readOptions().deadlineAt).toBe(total.deadlineAt);
			expect(scan.readOptions().timeoutMs).toBe(2000);
			elapsed = 29_000;
			expect(scan.readOptions().timeoutMs).toBe(1000);
			scan.dispose(false);
			total.dispose(false);
			expect(scan.signal.aborted).toBe(false);
			expect(total.signal.aborted).toBe(false);
		} finally {
			scan?.dispose(false);
			total.dispose(false);
			monotonic.mockRestore();
			wall.mockRestore();
		}
	});
	test("worker page budgets decrease from the same deadline and dispose cancels their signal", async () => {
		let elapsed = 100;
		const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
		const wallClock = spyOn(Date, "now").mockImplementation(() => 1_000_000 + elapsed);
		const parent = new AbortController();
		const added = spyOn(parent.signal, "addEventListener");
		const removed = spyOn(parent.signal, "removeEventListener");
		const scan = new GitAccessScan(parent.signal);
		const options: ReturnType<GitAccessScan["readOptions"]>[] = [];
		try {
			for await (const _page of scan.pagesOf(async (cursor) => {
				options.push(scan.readOptions());
				elapsed += 1000;
				return cursor ? [] : rows.slice(0, ACCESS_PAGE_SIZE);
			})) {
				// The loader has the only clock advances, without waiting on wall time.
			}
			expect(options.map(({ timeoutMs }) => timeoutMs)).toEqual([5000, 4000]);
			expect(options[0].signal).toBe(options[1].signal);
			expect(options[0].signal).not.toBe(parent.signal);
			expect(options[0].signal.aborted).toBe(false);
			scan.dispose();
			expect(options[0].signal.aborted).toBe(true);
			expect(parent.signal.aborted).toBe(false);
			expect(added.mock.calls).toHaveLength(1);
			expect(removed.mock.calls).toEqual([["abort", added.mock.calls[0][1]]]);
		} finally {
			scan.dispose();
			clock.mockRestore();
			wallClock.mockRestore();
			added.mockRestore();
			removed.mockRestore();
		}
	});

	for (const reason of ["abort", "deadline"] as const) {
		test(`${reason} cancels a pending page before any later pages or visits`, async () => {
			let elapsed = 100;
			const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
			const parent = new AbortController();
			const scan = new GitAccessScan(parent.signal);
			let entered!: () => void;
			const entry = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let options!: ReturnType<GitAccessScan["readOptions"]>;
			let loads = 0,
				visits = 0,
				aborts = 0;
			try {
				const work = (async () => {
					for await (const _page of scan.pagesOf(() => {
						loads++;
						options = scan.readOptions();
						entered();
						return new Promise<typeof rows>((_, reject) => {
							options.signal.addEventListener(
								"abort",
								() => {
									aborts++;
									reject(new Error("worker cancelled"));
								},
								{ once: true },
							);
						});
					}))
						visits++;
				})();
				await entry;
				if (reason === "abort") parent.abort();
				else {
					elapsed += 5000;
					expect(() => scan.check()).toThrow();
				}
				await expect(work).rejects.toMatchObject(unavailable);
				expect(options.signal.aborted).toBe(true);
				expect(options.timeoutMs).toBeGreaterThan(0);
				expect(options.timeoutMs).toBeLessThanOrEqual(5000);
				expect(aborts).toBe(1);
				expect(loads).toBe(1);
				expect(visits).toBe(0);
			} finally {
				scan.dispose();
				clock.mockRestore();
			}
		});
	}

	test("the registered deadline callback aborts outstanding Worker reads", async () => {
		const timers = spyOn(globalThis, "setTimeout");
		const scan = new GitAccessScan();
		try {
			const { signal } = scan.readOptions();
			const deadline = timers.mock.calls.find(([, timeout]) => timeout === 5000)?.[0];
			expect(typeof deadline).toBe("function");
			if (typeof deadline !== "function") throw new Error("Missing scan deadline callback");
			deadline();
			expect(signal.aborted).toBe(true);
			await expect(scan.run(async () => true)).rejects.toMatchObject(unavailable);
		} finally {
			scan.dispose();
			timers.mockRestore();
		}
	});

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
