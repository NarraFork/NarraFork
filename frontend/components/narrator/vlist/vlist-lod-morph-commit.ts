import { DRILL_MORPH_X_OFFSET } from "./vlist-drill-morph";
import { drillBorderKeyframesFrom, drillTailKeyframesFrom } from "./vlist-drill-morph-motion";
import { cssAttrEscape } from "./vlist-exact-layout";
import { buildLodSnapshots, diffLodSnapshots } from "./vlist-lod-morph";
import { createLodMorphFrameBaseline, type LodMorphFramePair } from "./vlist-lod-morph-frame";
import {
	createLodMorphGeometryCache,
	type LodMorphGeometryInput,
} from "./vlist-lod-morph-geometry";
import { lodMorphKeyframesFrom } from "./vlist-lod-morph-motion";
import type { MorphDriver } from "./vlist-morph-driver";
import { admitPair, initialStateFor, planMorphTargets } from "./vlist-morph-plan";
import { LOD_MOTION_DURATION_MS, lodScope, type MotionScheduler } from "./vlist-motion-scheduler";
import type { VisualStateStore } from "./vlist-visual-state";

type Slot<T> = { current: T };

export interface LodMorphCommitSource extends LodMorphGeometryInput {
	readonly scrollTop: number;
	readonly viewportHeight: number;
	readonly documentRevision: number;
	readonly lod: number;
}

export interface LodMorphCommitState {
	readonly geometry: Slot<ReturnType<typeof createLodMorphGeometryCache> | null>;
	readonly frames: Slot<ReturnType<typeof createLodMorphFrameBaseline> | null>;
}

export interface LodMorphPlayback {
	readonly viewport: Pick<HTMLElement, "querySelector">;
	readonly unified: boolean;
	readonly prefersReducedMotion: () => boolean;
	readonly visualState: Pick<VisualStateStore, "isMoving" | "startFrom" | "setTarget" | "retain">;
	readonly identities: Slot<Set<string>>;
	readonly driver: Pick<MorphDriver, "kick"> | null;
	readonly motion: Pick<MotionScheduler, "begin" | "push">;
}

/** Typed planner ports: tests can observe real calls without evaluating shell source. */
export interface LodMorphCommitAlgorithms {
	readonly buildSnapshots: typeof buildLodSnapshots;
	readonly diffSnapshots: typeof diffLodSnapshots;
	readonly admit: typeof admitPair;
	readonly planTargets: typeof planMorphTargets;
}

const algorithms: LodMorphCommitAlgorithms = {
	buildSnapshots: buildLodSnapshots,
	diffSnapshots: diffLodSnapshots,
	admit: admitPair,
	planTargets: planMorphTargets,
};

/**
 * The committed-layout entry used by the list and its behaviour tests.
 * Record both world frames before any playback gate; only the selected planner
 * derives admission maps. No DOM geometry, new cache policy or React scheduling.
 */
export function commitLodMorph(
	source: LodMorphCommitSource,
	state: LodMorphCommitState,
	playback: LodMorphPlayback,
	planner: LodMorphCommitAlgorithms = algorithms,
): LodMorphFramePair | null {
	state.geometry.current ??= createLodMorphGeometryCache();
	const geometry = state.geometry.current.get(source);
	state.frames.current ??= createLodMorphFrameBaseline();
	const frames = state.frames.current.commit({
		narratorId: source.narratorId,
		geometry,
		scrollTop: source.scrollTop,
		viewportHeight: source.viewportHeight,
		documentRevision: source.documentRevision,
		lod: source.lod,
	});
	// Reduced motion is a playback gate, never a reason to keep an older frame.
	if (!frames || playback.prefersReducedMotion()) return frames;
	if (playback.unified) {
		const { before, after } = planner.admit(
			frames.before.geometry.unifiedElements,
			frames.after.geometry.unifiedElements,
			frames.after.scrollTop,
			frames.after.viewportHeight,
			frames.before.scrollTop,
		);
		const targets = planner.planTargets(
			before,
			after,
			(kind) => (kind === "tool-call" || kind === "subagent-card" ? 1 : 0),
			() => DRILL_MORPH_X_OFFSET,
		);
		const ids = new Set<string>();
		for (const plan of targets) {
			ids.add(plan.unitId);
			if (playback.visualState.isMoving(plan.unitId)) {
				// Mid-flight switches retain the current visual displacement.
				playback.visualState.setTarget(plan.unitId, plan.target);
			} else {
				// Existing but settled elements must be displaced again on every switch.
				playback.visualState.startFrom(plan.unitId, initialStateFor(plan), plan.target);
			}
		}
		playback.identities.current = ids;
		playback.visualState.retain(ids);
		playback.driver?.kick();
		return frames;
	}
	const before = planner.buildSnapshots(
		frames.before.geometry.elements,
		frames.before.scrollTop,
		frames.before.viewportHeight,
	);
	const after = planner.buildSnapshots(
		frames.after.geometry.elements,
		frames.after.scrollTop,
		frames.after.viewportHeight,
	);
	const plans = planner.diffSnapshots(before, after);
	if (plans.length === 0) return frames;
	const resolveHost = (identity: string) => {
		const escaped = cssAttrEscape(identity);
		return (
			playback.viewport.querySelector<HTMLElement>(`[data-nf-unit="${escaped}"]`) ??
			playback.viewport.querySelector<HTMLElement>(`[data-nf-row-key="${escaped}"]`)
		);
	};
	playback.motion.begin();
	playback.motion.push(
		plans.map((plan) => ({
			scope: lodScope(plan.unitId),
			resolve: () => resolveHost(plan.unitId),
			keyframes: (previous) => lodMorphKeyframesFrom(plan, previous),
		})),
		LOD_MOTION_DURATION_MS,
	);
	playback.motion.push(
		plans.flatMap((plan) => {
			if (!plan.fade) return [];
			const host = resolveHost(plan.unitId);
			if (!host) return [];
			const kind = plan.toKind === "tool-call" ? "expand" : "collapse";
			return [
				{
					scope: `${lodScope(plan.unitId)}:tail`,
					resolve: () => host.querySelector<HTMLElement>("[data-nf-card-tail]"),
					keyframes: (previous: { progress: number } | null) =>
						drillTailKeyframesFrom(kind, previous),
				},
				{
					scope: `${lodScope(plan.unitId)}:border`,
					resolve: () => host.querySelector<HTMLElement>("[data-nf-card-surface]"),
					keyframes: (previous: { progress: number } | null) =>
						drillBorderKeyframesFrom(kind, previous),
				},
			];
		}),
		LOD_MOTION_DURATION_MS,
	);
	return frames;
}

/** Preference changes hand playback ownership over without discarding world frames. */
export function resetLodMorphPlayback(
	identities: Slot<Set<string>>,
	driver: Pick<MorphDriver, "stop"> | null,
): void {
	identities.current = new Set();
	driver?.stop();
}
