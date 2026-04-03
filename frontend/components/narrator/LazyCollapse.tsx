import { Collapse } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";

interface LazyCollapseProps {
	in: boolean;
	children: React.ReactNode;
}

/**
 * A wrapper around Mantine's Collapse that unmounts children when collapsed.
 * Children are mounted when `in` becomes true, and unmounted after the
 * collapse transition finishes when `in` becomes false.
 *
 * To preserve the expand animation, mounting and opening happen in two frames:
 * frame 1 — mount the Collapse with `in={false}` so it measures height 0,
 * frame 2 — flip to `in={true}` to trigger the CSS transition.
 *
 * On initial mount with `in={true}`, the two-step animation is skipped —
 * the Collapse renders directly with `in={true}` so content is immediately
 * visible. This avoids setState-in-useEffect on mount, which React 19's
 * `set-state-in-effect` lint rule flags and which causes "Maximum update
 * depth exceeded" when many LazyCollapse instances mount simultaneously.
 */
export function LazyCollapse({ in: opened, children }: LazyCollapseProps) {
	const [mounted, setMounted] = useState(opened);
	const [reveal, setReveal] = useState(opened);
	const isFirstMount = useRef(true);
	const mountedRef = useRef(opened);

	useEffect(() => {
		// On initial mount, mounted and reveal are already set correctly by
		// useState(opened). Skip all setState calls — this is the React-recommended
		// "derive state from props" pattern. The Collapse renders directly at its
		// final state (collapsed or expanded) without an intermediate render pass.
		if (isFirstMount.current) {
			isFirstMount.current = false;
			return;
		}

		// Use mountedRef to track mounted state WITHOUT including `mounted` in deps.
		// When `opened` toggles true, the old code ran setMounted(true) then re-ran
		// the effect (because `mounted` changed) to schedule setReveal(true) — two
		// state updates from one prop change. With many LazyCollapse instances
		// reacting simultaneously, the accumulated updates exceeded React 19's
		// nested-update limit (50), producing "Maximum update depth exceeded".
		// The `opened && reveal` guard prevents re-triggering when the effect
		// re-runs only because `reveal` changed.

		// Guard: if already open and revealed, nothing to do
		if (opened && reveal) return;

		let cleanup: (() => void) | undefined;

		if (opened) {
			if (!mountedRef.current) {
				// First open: mount children, reveal on next frame
				mountedRef.current = true;
				setMounted(true);
			}
			// Reveal on next frame (Collapse starts from height 0 → full height)
			const raf = requestAnimationFrame(() => setReveal(true));
			cleanup = () => cancelAnimationFrame(raf);
		} else {
			setReveal(false);
			// Unmount children after transition completes (~200ms)
			const timeout = setTimeout(() => {
				mountedRef.current = false;
				setMounted(false);
			}, 250);
			cleanup = () => clearTimeout(timeout);
		}

		return cleanup;
	}, [opened, reveal]);

	const handleTransitionEnd = useCallback(() => {
		if (!opened) {
			mountedRef.current = false;
			setMounted(false);
		}
	}, [opened]);

	if (!mounted) return null;

	return (
		<Collapse in={reveal} onTransitionEnd={handleTransitionEnd}>
			{children}
		</Collapse>
	);
}
