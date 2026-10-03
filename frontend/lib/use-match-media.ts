/**
 * use-match-media.ts — one media query, read synchronously on the first render.
 *
 * A pointer that cannot hover makes every reveal-on-hover contract unreachable,
 * so touch surfaces paint their affordances permanently instead. Both facts are
 * properties of the DEVICE, not of the content, which is why they come from a
 * media query rather than from the render tree.
 *
 * `hover: none` alone would miss a coarse pointer that still reports hover
 * support, and `pointer: coarse` alone would miss a hoverless fine pointer (a TV
 * remote) — the disjunction is the query NarratorPanel uses for its own touch
 * branch.
 */
import { useEffect, useState } from "react";

/** A pointer that cannot hover (touchscreens, remotes). */
export const TOUCH_POINTER_MEDIA_QUERY = "(hover: none), (pointer: coarse)";

/**
 * Deliberately NOT Mantine's `useMediaQuery`: several vlist suites replace the
 * whole `@mantine/hooks` module with a stub that hardcodes `useMediaQuery: () =>
 * false`, and `mock.module` leaks across files under `bun test`. Depending on it
 * would make the touch branch untestable — and, worse, silently dead in
 * whichever suites happen to run after such a mock. The subscription is six
 * lines, so owning it costs less than the coupling.
 *
 * The first value is read during render (not in an effect) because a phone
 * reader would otherwise watch the affordance appear one frame late.
 */
export function useMatchMedia(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia?.(query).matches === true;
	});
	useEffect(() => {
		const list = window.matchMedia?.(query);
		if (!list) return;
		setMatches(list.matches);
		const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
		// `addListener` is the Safari < 14 spelling; both are optional on the stubs
		// the test suites install, hence the guards.
		list.addEventListener?.("change", onChange);
		return () => list.removeEventListener?.("change", onChange);
	}, [query]);
	return matches;
}
