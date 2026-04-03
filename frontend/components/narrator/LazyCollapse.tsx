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

	useEffect(() => {
		// On initial mount, mounted and reveal are already set correctly by
		// useState(opened). Skip all setState calls — this is the React-recommended
		// "derive state from props" pattern. The Collapse renders directly at its
		// final state (collapsed or expanded) without an intermediate render pass.
		if (isFirstMount.current) {
			isFirstMount.current = false;
			return;
		}

		if (opened && !mounted) {
			setMounted(true);
		}
		if (opened && mounted) {
			const raf = requestAnimationFrame(() => setReveal(true));
			return () => cancelAnimationFrame(raf);
		}
		if (!opened) {
			setReveal(false);
		}
	}, [opened, mounted]);

	const handleTransitionEnd = useCallback(() => {
		if (!opened) {
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
