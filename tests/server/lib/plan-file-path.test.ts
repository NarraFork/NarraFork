import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetPathSemantics } from "../../../server/lib/agent/execution/path-semantics";
import {
	buildLegacyPlanFileRelPath,
	buildPlanFileRelPath,
	isInsidePlansDir,
	isSafePlanFileIdForPath,
	PLAN_DIR_REL,
	resolveExistingPlanFileRelPath,
} from "../../../server/lib/plan-file-path";

const posix = targetPathSemantics("posix");
const windows = targetPathSemantics("windows");

describe("plan file paths", () => {
	it("builds the canonical path under the plan directory", () => {
		expect(buildPlanFileRelPath("happy-cat--0123")).toBe(`${PLAN_DIR_REL}/plan-happy-cat--0123.md`);
		expect(buildLegacyPlanFileRelPath("happy-cat--0123")).toBe(
			".narrafork/plan-happy-cat--0123.md",
		);
	});

	it("refuses plan identities that could escape the plan directory", () => {
		expect(isSafePlanFileIdForPath("plain-id")).toBe(true);
		expect(isSafePlanFileIdForPath("../escape")).toBe(false);
		expect(isSafePlanFileIdForPath("nested/id")).toBe(false);
		expect(isSafePlanFileIdForPath("nested\\id")).toBe(false);
		expect(isSafePlanFileIdForPath(undefined)).toBe(false);
	});
});

describe("isInsidePlansDir", () => {
	it("accepts paths inside the plan directory, relative or absolute", () => {
		expect(isInsidePlansDir(posix, "/work", ".narrafork/plans/design.md")).toBe(true);
		expect(isInsidePlansDir(posix, "/work", "/work/.narrafork/plans/nested/design.md")).toBe(true);
	});

	it("rejects paths outside it, including traversal back out", () => {
		expect(isInsidePlansDir(posix, "/work", "docs/plan.md")).toBe(false);
		expect(isInsidePlansDir(posix, "/work", ".narrafork/plan-legacy.md")).toBe(false);
		expect(isInsidePlansDir(posix, "/work", ".narrafork/plans/../../escape.md")).toBe(false);
		expect(isInsidePlansDir(posix, "/work", "/elsewhere/plan.md")).toBe(false);
	});

	it("judges a remote target with its own path grammar", () => {
		// A Windows executor's paths must not be measured with POSIX semantics.
		expect(isInsidePlansDir(windows, "C:\\work", ".narrafork\\plans\\design.md")).toBe(true);
		expect(isInsidePlansDir(windows, "C:\\work", "C:\\WORK\\.narrafork\\plans\\design.md")).toBe(
			true,
		);
		expect(isInsidePlansDir(windows, "C:\\work", "C:\\work\\docs\\plan.md")).toBe(false);
	});
});

/**
 * The migration probe. Its whole job is to keep a plan cycle that started before the
 * move pointed at the file its content is actually in.
 */
describe("resolveExistingPlanFileRelPath", () => {
	function makeWorkdir(): string {
		return mkdtempSync(join(tmpdir(), "narrafork-plan-path-"));
	}

	it("prefers the canonical path when nothing exists yet", async () => {
		const cwd = makeWorkdir();
		try {
			expect(await resolveExistingPlanFileRelPath(cwd, "fresh")).toBe(
				buildPlanFileRelPath("fresh"),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("stays on the legacy path while that is where the plan content is", async () => {
		const cwd = makeWorkdir();
		try {
			mkdirSync(join(cwd, ".narrafork"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", "plan-resumed.md"), "# In-progress plan\n");

			expect(await resolveExistingPlanFileRelPath(cwd, "resumed")).toBe(
				buildLegacyPlanFileRelPath("resumed"),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("prefers the canonical path once it holds content, even beside a legacy file", async () => {
		const cwd = makeWorkdir();
		try {
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", "plan-both.md"), "# Legacy\n");
			writeFileSync(join(cwd, ".narrafork", "plans", "plan-both.md"), "# Current\n");

			expect(await resolveExistingPlanFileRelPath(cwd, "both")).toBe(buildPlanFileRelPath("both"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("ignores an empty legacy file, which is not planning work", async () => {
		const cwd = makeWorkdir();
		try {
			mkdirSync(join(cwd, ".narrafork"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", "plan-blank.md"), "");

			expect(await resolveExistingPlanFileRelPath(cwd, "blank")).toBe(
				buildPlanFileRelPath("blank"),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns nothing for an unsafe identity and never probes", async () => {
		let probed = 0;
		const result = await resolveExistingPlanFileRelPath("/work", "../escape", async () => {
			probed += 1;
			return true;
		});
		expect(result).toBeUndefined();
		expect(probed).toBe(0);
	});

	it("skips probing entirely for a non-absolute cwd", async () => {
		let probed = 0;
		const result = await resolveExistingPlanFileRelPath("relative/dir", "id", async () => {
			probed += 1;
			return true;
		});
		expect(result).toBe(buildPlanFileRelPath("id"));
		expect(probed).toBe(0);
	});

	it("probes at most twice", async () => {
		const probes: string[] = [];
		await resolveExistingPlanFileRelPath("/work", "bounded", async (_cwd, relPath) => {
			probes.push(relPath);
			return false;
		});
		expect(probes).toEqual([
			buildPlanFileRelPath("bounded"),
			buildLegacyPlanFileRelPath("bounded"),
		]);
	});
});
