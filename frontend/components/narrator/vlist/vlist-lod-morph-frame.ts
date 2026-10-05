/**
 * Last committed document-space frame for LOD morphs.
 *
 * Recording a baseline is O(1), not a viewport admission pass. Only a real LOD
 * switch consumes the two frames to derive the selected planner's snapshots.
 */
import type { LodMorphGeometry } from "./vlist-lod-morph-geometry";

export interface LodMorphFrame {
	readonly narratorId: string;
	readonly geometry: LodMorphGeometry;
	readonly scrollTop: number;
	readonly viewportHeight: number;
	readonly documentRevision: number;
	readonly lod: number;
}

export interface LodMorphFramePair {
	readonly before: LodMorphFrame;
	readonly after: LodMorphFrame;
}

/** List-local, single-frame state. Commit only from the shell's layout effect. */
export function createLodMorphFrameBaseline() {
	let previous: LodMorphFrame | undefined;
	return {
		commit(frame: LodMorphFrame): LodMorphFramePair | null {
			// Copy the descriptor, not its immutable geometry. A caller reusing/mutating
			// its own descriptor must not rewrite the origin of an earlier commit.
			const after: LodMorphFrame = {
				narratorId: frame.narratorId,
				geometry: frame.geometry,
				scrollTop: frame.scrollTop,
				viewportHeight: frame.viewportHeight,
				documentRevision: frame.documentRevision,
				lod: frame.lod,
			};
			const before = previous;
			previous = after;
			// Advance even on non-switch/rebuild frames. Reduced-motion is a playback
			// gate in the shell AFTER commit, not a reason to preserve a stale baseline.
			if (
				!before ||
				before.narratorId !== after.narratorId ||
				before.documentRevision !== after.documentRevision ||
				before.lod === -1 ||
				before.lod === after.lod
			) {
				return null;
			}
			return { before, after };
		},
	};
}
