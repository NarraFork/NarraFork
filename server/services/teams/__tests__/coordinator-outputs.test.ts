/**
 * Where a coordinator's saved tool outputs live and how long (Project Teams P2, review S1):
 * per narrator under the data directory, capped (oldest first), removed with the narrator,
 * swept when orphaned, counted on the storage page; split into parts Read returns whole.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-coordinator-outputs-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

await import("../../../db");
const { coordinatorOutputsDir, coordinatorOutputsRoot } = await import(
	"../../../lib/coordinator-outputs-path"
);
const { narratorService } = await import("../../narrator-service");
const outputs = await import("../coordinator-outputs");
const {
	COORDINATOR_OUTPUT_LIMITS,
	saveCoordinatorOutput,
	setCoordinatorOutputCapForTests,
	splitForRead,
	resetCoordinatorOutputIndexes,
} = outputs;
const { startCoordinatorMaintenance, sweepOrphanCoordinatorOutputs } = await import(
	"../coordinator-maintenance"
);
const { scanStorageCategory } = await import("../../storage-service");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

let narratorId: string;
beforeAll(async () => {
	mkdirSync(join(testHome, "repo"), { recursive: true });
	narratorId = (await narratorService.create({ title: "saver", cwd: join(testHome, "repo") })).id;
});

afterEach(() => {
	setCoordinatorOutputCapForTests(null);
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("splitForRead", () => {
	test("one part when it fits; parts join back to the text exactly", () => {
		expect(splitForRead("a\nb\n")).toEqual(["a\nb\n"]);
		const text = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"q".repeat(30)}`).join("\n");
		const parts = splitForRead(text);
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.join("")).toBe(text);
		for (const part of parts) {
			const cost = part
				.replace(/\n$/, "")
				.split("\n")
				.reduce((sum, line) => sum + line.length + COORDINATOR_OUTPUT_LIMITS.lineOverhead, 0);
			expect(cost).toBeLessThanOrEqual(COORDINATOR_OUTPUT_LIMITS.partChars);
		}
	});

	test("a line longer than a part is split between parts, never a surrogate pair", () => {
		const text = `head\n${"😀".repeat(60_000)}\ntail`;
		const parts = splitForRead(text);
		expect(parts.join("")).toBe(text);
		for (const part of parts) expect(part.isWellFormed()).toBe(true);
	});
});

describe("the directory", () => {
	test("under the data directory, one per narrator", async () => {
		const paths = (await saveCoordinatorOutput(narratorId, "hello\n")) as string[];
		expect(paths).toHaveLength(1);
		expect(paths[0]?.startsWith(`${coordinatorOutputsDir(narratorId)}/`)).toBe(true);
		expect(coordinatorOutputsRoot().startsWith(testHome)).toBe(true);
		expect(readFileSync(paths[0] as string, "utf8")).toBe("hello\n");
		expect(await saveCoordinatorOutput("../escape", "x")).toBeNull();
	});

	test("over the cap the oldest files go first, never the one just saved", async () => {
		resetCoordinatorOutputIndexes();
		rmSync(coordinatorOutputsDir(narratorId) as string, { recursive: true, force: true });
		setCoordinatorOutputCapForTests(25_000);
		const saved: string[] = [];
		for (const letter of ["a", "b", "c"]) {
			saved.push(
				((await saveCoordinatorOutput(narratorId, letter.repeat(10_000))) as string[])[0] as string,
			);
			await pause(5);
		}
		expect(existsSync(saved[0] as string)).toBe(false);
		expect(existsSync(saved[1] as string)).toBe(true);
		expect(existsSync(saved[2] as string)).toBe(true);
		// One text larger than the cap is still saved (and is the only one left).
		const big = ((await saveCoordinatorOutput(narratorId, "d".repeat(30_000))) as string[])[0];
		expect(readFileSync(big as string, "utf8")).toBe("d".repeat(30_000));
		expect(existsSync(saved[2] as string)).toBe(false);
	});

	test("removed when the narrator is deleted; orphans are swept", async () => {
		const stop = startCoordinatorMaintenance();
		try {
			const doomed = (
				await narratorService.create({ title: "doomed", cwd: join(testHome, "repo") })
			).id;
			const paths = (await saveCoordinatorOutput(doomed, "bye")) as string[];
			expect(existsSync(paths[0] as string)).toBe(true);
			await narratorService.remove(doomed);
			for (let i = 0; i < 50 && existsSync(coordinatorOutputsDir(doomed) as string); i++)
				await pause(10);
			expect(existsSync(coordinatorOutputsDir(doomed) as string)).toBe(false);

			const orphan = join(coordinatorOutputsRoot(), "noSuchNarrator123");
			mkdirSync(orphan, { recursive: true });
			writeFileSync(join(orphan, "x.txt"), "x");
			expect(await sweepOrphanCoordinatorOutputs()).toBe(1);
			expect(existsSync(orphan)).toBe(false);
			expect(existsSync(coordinatorOutputsDir(narratorId) as string)).toBe(true);
		} finally {
			stop();
		}
	});

	test("counted on the storage page", async () => {
		await saveCoordinatorOutput(narratorId, "counted ".repeat(100));
		const category = await scanStorageCategory("coordinatorOutputs");
		expect(category.key).toBe("coordinatorOutputs");
		expect(category.sizeBytes).toBeGreaterThan(0);
		expect(category.details).toMatchObject({ narratorDirs: 1 });
	});
});
