/** Shared scroll chase. Callers own intent/anchoring; this module only moves a target. */
export const SMOOTH_FOLLOW_TAU_MS = 100;
export const SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS = 4;
// Together these remove the invisible subpixel/1px-frame tail. Keep both invariants.
export const SMOOTH_FOLLOW_SETTLE_EPSILON_PX = 3;
export const SMOOTH_FOLLOW_MIN_STEP_PX = 1;
export const SMOOTH_FOLLOW_DELTA_VIEWPORT_FACTOR = 1.5;
export const SMOOTH_FOLLOW_DELTA_MIN_PX = 480;
export const SMOOTH_FOLLOW_DELTA_MAX_PX = 2000;

export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
	} catch {
		return false;
	}
}

export function smoothFollowMaxDelta(viewportHeight: number): number {
	const vh = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
	return Math.min(
		Math.max(vh * SMOOTH_FOLLOW_DELTA_VIEWPORT_FACTOR, SMOOTH_FOLLOW_DELTA_MIN_PX),
		SMOOTH_FOLLOW_DELTA_MAX_PX,
	);
}

export interface SmoothFollowGeometry {
	current: number;
	target: number;
	viewportHeight: number;
	reducedMotion: boolean;
}

/** Contents may follow a changed line ABOVE the viewport as well as an appended tail. */
export function shouldSmoothTarget(input: SmoothFollowGeometry): boolean {
	const distance = Math.abs(input.target - input.current);
	return (
		!input.reducedMotion &&
		distance > 0 &&
		Number.isFinite(distance) &&
		distance <= smoothFollowMaxDelta(input.viewportHeight)
	);
}

/** The exact message list's existing bottom-growth policy; rollback/restore still snap. */
export function shouldSmoothFollow(input: SmoothFollowGeometry): boolean {
	return input.target > input.current && shouldSmoothTarget(input);
}

export interface SmoothFollowStep {
	next: number;
	settled: boolean;
}

/** Signed, dt-aware exponential step, bounded by velocity and a one-pixel floor. */
export function resolveSmoothFollowStep(input: {
	current: number;
	target: number;
	dtMs: number;
	tauMs?: number;
	maxVelocityPxPerMs?: number;
	settleEpsilonPx?: number;
	minStepPx?: number;
}): SmoothFollowStep {
	const { current, target } = input;
	const distance = Math.abs(target - current);
	const epsilon = input.settleEpsilonPx ?? SMOOTH_FOLLOW_SETTLE_EPSILON_PX;
	if (distance <= epsilon) return { next: target, settled: true };
	const dt = Math.max(0, input.dtMs);
	if (dt === 0) return { next: current, settled: false };
	const tau = input.tauMs ?? SMOOTH_FOLLOW_TAU_MS;
	const velocity = input.maxVelocityPxPerMs ?? SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS;
	const floor = input.minStepPx ?? SMOOTH_FOLLOW_MIN_STEP_PX;
	const step = Math.min(
		distance,
		Math.max(floor, Math.min(distance * (1 - Math.exp(-dt / tau)), velocity * dt)),
	);
	const next = current + Math.sign(target - current) * step;
	return Math.abs(target - next) <= epsilon
		? { next: target, settled: true }
		: { next, settled: false };
}

export interface SmoothFollowerDeps {
	readCurrent: () => number;
	readTarget: () => number;
	getViewportHeight: () => number;
	writeInstant: (value: number) => void;
	writeChase: (value: number) => void;
	/** Content uses the bidirectional default; the message list supplies its own gate. */
	canAnimate?: (input: SmoothFollowGeometry) => boolean;
	isReducedMotion?: () => boolean;
	raf?: (callback: (time: number) => void) => number;
	cancelRaf?: (handle: number) => void;
	now?: () => number;
}

export interface SmoothFollower {
	ensure: () => void;
	cancel: () => void;
	snapToTarget: () => void;
	isActive: () => boolean;
}

export function createSmoothFollower(deps: SmoothFollowerDeps): SmoothFollower {
	const raf = deps.raf ?? requestAnimationFrame;
	const cancelRaf = deps.cancelRaf ?? cancelAnimationFrame;
	const now = deps.now ?? (() => performance.now());
	const reduced = deps.isReducedMotion ?? prefersReducedMotion;
	const canAnimate = deps.canAnimate ?? shouldSmoothTarget;
	let active = false;
	let frame: number | null = null;
	let lastTime = 0;
	const stop = () => {
		if (frame !== null) cancelRaf(frame);
		frame = null;
		active = false;
	};
	const geometry = (): SmoothFollowGeometry => ({
		current: deps.readCurrent(),
		target: deps.readTarget(),
		viewportHeight: deps.getViewportHeight(),
		reducedMotion: reduced(),
	});
	const land = ({ current, target }: SmoothFollowGeometry) => {
		stop();
		if (target !== current && Number.isFinite(target)) deps.writeInstant(target);
	};
	const tick = (time: number) => {
		frame = null;
		if (!active) return;
		const input = geometry();
		if (!canAnimate(input)) return land(input);
		const step = resolveSmoothFollowStep({ ...input, dtMs: time - lastTime });
		lastTime = time;
		if (step.settled) return land(input);
		deps.writeChase(step.next);
		if (active) frame = raf(tick);
	};
	return {
		ensure() {
			const input = geometry();
			if (!canAnimate(input)) return land(input);
			if (active) return;
			active = true;
			lastTime = now();
			frame = raf(tick);
		},
		cancel: stop,
		snapToTarget() {
			if (active) land(geometry());
		},
		isActive: () => active,
	};
}
