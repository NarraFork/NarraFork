/**
 * plan-file-path.ts — single source of truth for the designated plan file path.
 *
 * Plan files live under `<narrator cwd>/.narrafork/plans/`. The path is always
 * built RELATIVE to the narrator's working directory: the same relative string is
 * resolved by the tool execution layer against whatever backend actually runs the
 * write (local worktree, project git path, or a remote executor's default cwd).
 *
 * Everything that needs the path — path generation, the permission gate, the
 * plan-mode system reminder, ExitPlanMode resolution — must go through here.
 * These used to be nine separate `.narrafork/plan-${id}.md` literals, which is
 * exactly the kind of duplication where one missed site silently makes the plan
 * file invisible to either the model or the approval gate.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { TargetPathSemantics } from "./agent/execution/path-semantics";

/** Directory (relative to the narrator cwd) holding every designated plan file. */
export const PLAN_DIR_REL = ".narrafork/plans";

/** Canonical relative path of the designated plan file for a plan identity. */
export function buildPlanFileRelPath(planFileId: string): string {
	return `${PLAN_DIR_REL}/plan-${planFileId}.md`;
}

/**
 * Pre-`plans/` layout: `.narrafork/plan-<id>.md`.
 *
 * TODO(migration): delete together with the legacy resolution in
 * narrator-session.ts once no plan cycle started before the move is still open.
 */
export function buildLegacyPlanFileRelPath(planFileId: string): string {
	return `.narrafork/plan-${planFileId}.md`;
}

/**
 * Is this plan identity safe to interpolate into a path?
 *
 * Identities are generated server-side, but restored narrators carry whatever is
 * in the DB, so refuse anything that could escape the plan directory.
 */
export function isSafePlanFileIdForPath(
	planFileId: string | null | undefined,
): planFileId is string {
	if (!planFileId) return false;
	if (planFileId.includes("/") || planFileId.includes("\\")) return false;
	if (planFileId.includes("..")) return false;
	return true;
}

/**
 * Does `candidate` resolve inside `<baseCwd>/.narrafork/plans/`?
 *
 * Purely lexical, and deliberately parameterized on the TARGET's path grammar:
 * a remote Windows executor must be judged with Windows semantics, not the
 * server's. Symlink escapes are not visible here — callers that read the file
 * must re-check the canonical path returned by stat (see resolveExitPlanMode).
 */
export function isInsidePlansDir(
	paths: TargetPathSemantics,
	baseCwd: string,
	candidate: string,
): boolean {
	const plansDir = paths.resolve(baseCwd, PLAN_DIR_REL);
	return paths.contains(plansDir, paths.resolve(baseCwd, candidate));
}

/** Does this relative path hold a non-empty file under `cwd`? */
export type PlanFileContentProbe = (cwd: string, relPath: string) => Promise<boolean>;

const localPlanFileContentProbe: PlanFileContentProbe = async (cwd, relPath) => {
	try {
		const stats = await stat(resolve(cwd, relPath));
		return stats.isFile() && stats.size > 0;
	} catch {
		return false;
	}
};

/**
 * Anchor a plan cycle to the plan file that actually holds content.
 *
 * Plan files moved from `.narrafork/plan-<id>.md` into `.narrafork/plans/`. A cycle
 * already writing to the legacy path must keep using it: switching paths mid-cycle
 * would hide an in-progress plan from both the system reminder and ExitPlanMode, and
 * the model would silently start a second, empty plan.
 *
 * Bounded to at most two probes, and only called when a narrator session is created
 * for a narrator already in plan mode — never on a normal request path. A narrator
 * whose plan file lives on a remote executor sees both local probes miss and lands
 * on the canonical path: the same result the pre-move code produced by building the
 * relative path blind.
 *
 * TODO(migration): delete together with `buildLegacyPlanFileRelPath` once no plan
 * cycle started before the move is still open.
 */
export async function resolveExistingPlanFileRelPath(
	cwd: string,
	planFileId: string | null | undefined,
	probe: PlanFileContentProbe = localPlanFileContentProbe,
): Promise<string | undefined> {
	if (!isSafePlanFileIdForPath(planFileId)) return undefined;
	const canonical = buildPlanFileRelPath(planFileId);
	if (!isAbsolute(cwd)) return canonical;
	if (await probe(cwd, canonical)) return canonical;
	const legacy = buildLegacyPlanFileRelPath(planFileId);
	if (await probe(cwd, legacy)) return legacy;
	return canonical;
}
