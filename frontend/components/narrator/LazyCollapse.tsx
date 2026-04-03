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
 */
export function LazyCollapse({ in: opened, children }: LazyCollapseProps) {
	const [mounted, setMounted] = useState(opened);
	const [reveal, setReveal] = useState(opened);
	const didInitialize = useRef(false);

	// When opened goes true: mount first, reveal next frame
	useEffect(() => {
		// Skip effect on initial mount when opened=true: useState(opened) already
		// set mounted=true and reveal=true, so no state changes are needed.
		// Without this guard, requestAnimationFrame would schedule a redundant
		// setReveal(true) for every instance. When many LazyCollapse mount at once
		// (e.g. reasoning blocks), the accumulated raf callbacks can trigger React's
		// nested-update counter (limit 50) during the commit phase.
		if (!didInitialize.current) {
			didInitialize.current = true;
			if (opened && mounted) return;
		}

		if (opened && !mounted) {
			setMounted(true);
		}
		if (opened && mounted) {
			// Delay reveal to next frame so Collapse starts from height 0
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
