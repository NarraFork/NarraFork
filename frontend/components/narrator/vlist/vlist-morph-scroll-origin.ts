/**
 * Reuse a native scroll sample only while its committed document geometry still
 * describes the viewport. Reading scrollTop after mounting a new window can force
 * style/layout synchronously; the scroll frame already read that same position.
 * The host opts in only for whole-viewport jumps, retaining the original layout
 * read order for fine scrolling (which can otherwise shift work into the next rAF).
 *
 * This is not a scroll-position owner. Pending native events, explicit writes and
 * resize observations invalidate the sample. Semantic/layout changes reject it by
 * identity, and the caller retains the live DOM fallback for those commits.
 */
export interface MorphScrollGeometry {
	readonly narratorId: string;
	readonly viewport: object;
	readonly items: readonly unknown[];
	readonly layout: object;
	readonly viewportHeight: number;
	readonly footerHeight: number;
	readonly footer: unknown;
}

export function createVListMorphScrollOrigin() {
	let sample: (MorphScrollGeometry & { readonly scrollTop: number }) | null = null;
	return {
		record(geometry: MorphScrollGeometry, scrollTop: number) {
			sample = Number.isFinite(scrollTop) ? { ...geometry, scrollTop } : null;
		},
		invalidate() {
			sample = null;
		},
		read(geometry: MorphScrollGeometry, readLive: () => number): number {
			if (
				sample &&
				sample.narratorId === geometry.narratorId &&
				sample.viewport === geometry.viewport &&
				sample.items === geometry.items &&
				sample.layout === geometry.layout &&
				sample.viewportHeight === geometry.viewportHeight &&
				sample.footerHeight === geometry.footerHeight &&
				sample.footer === geometry.footer
			) {
				return sample.scrollTop;
			}
			return readLive();
		},
	};
}
