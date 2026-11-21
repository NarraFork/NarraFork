/**
 * Unattended mode: when every narrator is quiet and nothing is queued, close NarraFork
 * gracefully and then switch the machine off (Issue #514).
 *
 * Design constraints that shaped this file:
 *
 * 1. **Session-scoped, never persisted.** Arming is in-memory on purpose. A persisted flag
 *    would re-arm itself on the next boot and could turn a crash loop into "boot, see no
 *    work, power off, reboot" — unrecoverable without editing files by hand.
 * 2. **Two separate timers of truth.** `armDelaySeconds` is a minimum wait after arming, so
 *    an operator who just clicked the switch has an undo window; `quietSeconds` is how long
 *    the instance must stay quiet before it counts as "all tasks finished".
 * 3. **Unknown means blocked.** Every probe failure keeps the machine on.
 * 4. **The mode never powers off on its own authority.** It asks the existing operator
 *    shutdown path (`scheduleOperatorShutdown`) to run, and only the post-shutdown hook —
 *    which runs after `performGracefulShutdown` returned — issues the power-off command.
 */

import { MIN_UNATTENDED_ARM_DELAY_SECONDS } from "../../shared/unattended";
import { eventBus } from "../lib/event-bus";
import { hotSafe, hotTimer, hotTimerClear } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { registerPostShutdownHook } from "../lib/post-shutdown-hooks";
import { resolvePowerOffPlan, runPowerOff } from "../lib/power-off";
import { scheduleOperatorShutdown } from "../lib/server-restart";
import {
	emptyUnattendedBlockers,
	isBlocked,
	probeUnattendedIdle,
	type UnattendedBlockers,
} from "./unattended-probe";

/** The shutdown reason this mode owns. Anything else is somebody else's shutdown. */
export const UNATTENDED_SHUTDOWN_REASON = "unattended_idle";

const POLL_INTERVAL_MS = 5_000;
const TIMER_KEY = "narrafork.unattendedMode.poll";
const HOOK_KEY = "unattended-mode";

export type UnattendedPhase = "off" | "waiting" | "quiet" | "shutting_down";

export interface UnattendedOptions {
	/** Power the machine off after NarraFork closes. When false only the server stops. */
	powerOff: boolean;
	/** Custom command run through the platform shell; null keeps the platform default. */
	powerOffCommand: string | null;
	/** Continuous quiet time required before shutting down. */
	quietSeconds: number;
	/** Minimum wait after arming, i.e. the operator's undo window. */
	armDelaySeconds: number;
}

/** UI-facing roll-up: booleans and counts only, safe to hand to any signed-in user. */
export interface UnattendedBlockerSummary {
	narrators: number;
	compacting: number;
	queuedDeliveries: boolean;
	backgroundTasks: boolean;
	dueScheduledTasks: boolean;
	maintenance: boolean;
	unknown: boolean;
}

/** Administrator-only detail behind the summary (ids, per-kind counters, probe errors). */
export interface UnattendedDiagnostics {
	narratorIds: string[];
	executions: UnattendedBlockers["executions"];
	dbWorkingNarrators: number;
	pendingPublications: boolean;
	error?: string;
}

export interface UnattendedStatus {
	enabled: boolean;
	options: UnattendedOptions;
	phase: UnattendedPhase;
	armedAt: string | null;
	quietSince: string | null;
	shutdownAt: string | null;
	pollIntervalMs: number;
	checkedAt: string | null;
	/** Convenience mirror of `isBlocked(blockers)`; the UI never re-derives it. */
	blocked: boolean;
	blockers: UnattendedBlockerSummary;
	/** Absent from the redacted (non-administrator) payload. */
	powerOffPlan?: { supported: boolean; command: string[] | null; note?: string };
	diagnostics?: UnattendedDiagnostics;
	lastError?: string;
}

export interface UnattendedModeLog {
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
}

export interface UnattendedModeDeps {
	now(): number;
	probe(input: { dueWithinMs: number }): Promise<UnattendedBlockers>;
	requestShutdown(reason: string): boolean;
	powerOff(command: string | null): Promise<{ ok: boolean; error?: string; unsupported?: boolean }>;
	registerHook(hook: ((context: { reason: string }) => Promise<void>) | null): void;
	/**
	 * Start the periodic evaluation; returns its cancel function. Tests inject a no-op so a
	 * unit test never leaves a 5 s interval (or a shared hot-safe timer) behind.
	 */
	schedule?(run: () => void): () => void;
	changed?(): void;
	log: UnattendedModeLog;
}

export const DEFAULT_UNATTENDED_OPTIONS: UnattendedOptions = {
	powerOff: true,
	powerOffCommand: null,
	quietSeconds: 120,
	armDelaySeconds: MIN_UNATTENDED_ARM_DELAY_SECONDS,
};

interface InternalState {
	enabled: boolean;
	phase: UnattendedPhase;
	options: UnattendedOptions;
	armedAt: number | null;
	quietSince: number | null;
	shutdownAt: number | null;
	checkedAt: number | null;
	blocked: boolean;
	blockers: UnattendedBlockers;
	lastError?: string;
	ticking: boolean;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeOptions(patch: Partial<UnattendedOptions>): UnattendedOptions {
	const command = patch.powerOffCommand;
	return {
		powerOff:
			typeof patch.powerOff === "boolean" ? patch.powerOff : DEFAULT_UNATTENDED_OPTIONS.powerOff,
		powerOffCommand: typeof command === "string" && command.trim() ? command.trim() : null,
		quietSeconds: clampInt(patch.quietSeconds, 10, 86_400, DEFAULT_UNATTENDED_OPTIONS.quietSeconds),
		armDelaySeconds: clampInt(
			patch.armDelaySeconds,
			MIN_UNATTENDED_ARM_DELAY_SECONDS,
			3_600,
			DEFAULT_UNATTENDED_OPTIONS.armDelaySeconds,
		),
	};
}

function iso(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

/** Production scheduler: one hot-safe interval, replaced after `bun --hot` re-evaluations. */
function defaultSchedule(run: () => void): () => void {
	hotTimer(TIMER_KEY, () => setInterval(run, POLL_INTERVAL_MS));
	return () => hotTimerClear(TIMER_KEY);
}

export interface UnattendedMode {
	status(): UnattendedStatus;
	enable(patch?: Partial<UnattendedOptions>): UnattendedStatus;
	disable(): { success: boolean; error?: string; status: UnattendedStatus };
	/** One evaluation. Tests call it directly; production drives it from the poll timer. */
	tick(): Promise<void>;
	revalidateIdle(): Promise<boolean>;
	deferShutdown(): void;
	/** Re-create the poll timer after a `bun --hot` module re-evaluation. */
	resume(): void;
}

export function createUnattendedMode(deps: UnattendedModeDeps): UnattendedMode {
	const state: InternalState = {
		enabled: false,
		phase: "off",
		options: { ...DEFAULT_UNATTENDED_OPTIONS },
		armedAt: null,
		quietSince: null,
		shutdownAt: null,
		checkedAt: null,
		blocked: false,
		blockers: emptyUnattendedBlockers(),
		ticking: false,
	};

	/** Active poll timer's cancel function, when one is running. */
	let cancelTimer: (() => void) | null = null;
	let generation = 0;

	function status(): UnattendedStatus {
		const plan = resolvePowerOffPlan(process.platform, state.options.powerOffCommand);
		return {
			enabled: state.enabled,
			options: { ...state.options },
			phase: state.phase,
			armedAt: iso(state.armedAt),
			quietSince: iso(state.quietSince),
			shutdownAt: iso(state.shutdownAt),
			pollIntervalMs: POLL_INTERVAL_MS,
			checkedAt: iso(state.checkedAt),
			blocked: state.blocked,
			blockers: {
				narrators: state.blockers.narrators.count,
				compacting: state.blockers.compacting,
				queuedDeliveries: state.blockers.queuedDeliveries,
				backgroundTasks: state.blockers.backgroundTasks,
				dueScheduledTasks: state.blockers.dueScheduledTasks,
				maintenance: state.blockers.maintenance,
				unknown: state.blockers.unknown,
			},
			powerOffPlan: {
				supported: state.options.powerOff && plan.supported,
				command: state.options.powerOff ? (plan.candidates[0] ?? null) : null,
				...(plan.note ? { note: plan.note } : {}),
			},
			diagnostics: {
				narratorIds: state.blockers.narrators.ids,
				executions: state.blockers.executions,
				dbWorkingNarrators: state.blockers.dbWorkingNarrators,
				pendingPublications: state.blockers.pendingPublications,
				...(state.blockers.error ? { error: state.blockers.error } : {}),
			},
			...(state.lastError ? { lastError: state.lastError } : {}),
		};
	}

	/**
	 * Runs inside the operator shutdown sequence, after teardown. It refuses any other
	 * reason: a shutdown somebody else started must never take the machine down with it.
	 */
	async function postShutdownHook({ reason }: { reason: string }): Promise<void> {
		if (reason !== UNATTENDED_SHUTDOWN_REASON) return;
		if (!state.enabled || state.phase !== "shutting_down") return;
		if (!state.options.powerOff) {
			deps.log.info("Unattended mode: power-off disabled, server stopped only");
			return;
		}
		const result = await deps.powerOff(state.options.powerOffCommand);
		if (result.ok) {
			deps.log.info("Unattended mode issued power-off");
			return;
		}
		deps.log.warn("Unattended mode could not power the machine off", {
			error: result.error,
			unsupported: result.unsupported === true,
		});
	}

	function ensureTimer(): void {
		stopTimer();
		const schedule = deps.schedule ?? defaultSchedule;
		cancelTimer = schedule(() => {
			void tick();
		});
	}

	function stopTimer(): void {
		cancelTimer?.();
		cancelTimer = null;
	}

	function trigger(): void {
		state.phase = "shutting_down";
		state.lastError = undefined;
		deps.log.warn("Unattended mode reached idle threshold; requesting graceful shutdown", {
			reason: UNATTENDED_SHUTDOWN_REASON,
			quietSeconds: state.options.quietSeconds,
			powerOff: state.options.powerOff,
		});
		if (!deps.requestShutdown(UNATTENDED_SHUTDOWN_REASON)) {
			// Either no handler is registered (tests, embedded harnesses) or another shutdown
			// is already pending. Stay armed and try again on the next tick: powering the
			// machine off without NarraFork having closed would be the worst outcome here.
			state.phase = "waiting";
			state.quietSince = null;
			state.shutdownAt = null;
			state.lastError = "shutdown_unavailable";
			deps.log.warn("Unattended shutdown could not be scheduled; staying armed");
			return;
		}
		stopTimer();
	}

	function probe(): Promise<UnattendedBlockers> {
		return deps.probe({ dueWithinMs: state.options.quietSeconds * 1000 });
	}

	async function tick(): Promise<void> {
		if (!state.enabled || state.phase === "shutting_down" || state.ticking) return;
		const probeGeneration = generation;
		const previousPhase = state.phase;
		const previousShutdownAt = state.shutdownAt;
		state.ticking = true;
		try {
			const report = await probe();
			if (probeGeneration !== generation) return;
			const now = deps.now();
			state.checkedAt = now;
			state.blockers = report;
			state.blocked = isBlocked(report);
			if (state.blocked) {
				state.quietSince = null;
				state.shutdownAt = null;
				state.phase = "waiting";
				return;
			}
			const quietSince = state.quietSince ?? now;
			const armedAt = state.armedAt ?? now;
			state.quietSince = quietSince;
			const readyAt = Math.max(
				armedAt + state.options.armDelaySeconds * 1000,
				quietSince + state.options.quietSeconds * 1000,
			);
			state.shutdownAt = readyAt;
			state.phase = "quiet";
			if (now < readyAt) return;
			trigger();
		} catch (error) {
			if (probeGeneration !== generation) return;
			// `probeUnattendedIdle` never throws, but an injected probe might: treat it as
			// "cannot prove the instance is quiet" and keep the machine on.
			state.blockers = {
				...emptyUnattendedBlockers(),
				unknown: true,
				error: error instanceof Error ? error.message : String(error),
			};
			state.blocked = true;
			state.quietSince = null;
			state.shutdownAt = null;
			state.phase = "waiting";
			state.lastError = "probe_failed";
			deps.log.warn("Unattended idle probe failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			state.ticking = false;
			if (probeGeneration !== generation) {
				void tick();
			} else if (previousPhase !== state.phase || previousShutdownAt !== state.shutdownAt) {
				deps.changed?.();
			}
		}
	}

	return {
		status,
		enable(patch = {}) {
			if (state.phase === "shutting_down") return status();
			generation++;
			state.options = normalizeOptions({ ...state.options, ...patch });
			state.enabled = true;
			state.phase = "waiting";
			state.armedAt = deps.now();
			state.quietSince = null;
			state.shutdownAt = null;
			state.checkedAt = null;
			state.blocked = false;
			state.blockers = emptyUnattendedBlockers();
			state.lastError = undefined;
			deps.registerHook(postShutdownHook);
			ensureTimer();
			deps.changed?.();
			deps.log.info("Unattended mode armed", {
				quietSeconds: state.options.quietSeconds,
				armDelaySeconds: state.options.armDelaySeconds,
				powerOff: state.options.powerOff,
			});
			void tick();
			return status();
		},
		disable() {
			if (state.phase === "shutting_down") {
				return { success: false, error: "already_shutting_down", status: status() };
			}
			generation++;
			const wasEnabled = state.enabled;
			state.enabled = false;
			state.phase = "off";
			state.armedAt = null;
			state.quietSince = null;
			state.shutdownAt = null;
			state.checkedAt = null;
			state.blocked = false;
			state.blockers = emptyUnattendedBlockers();
			state.lastError = undefined;
			stopTimer();
			deps.registerHook(null);
			if (wasEnabled) deps.changed?.();
			deps.log.info("Unattended mode disarmed");
			return { success: true, status: status() };
		},
		tick,
		async revalidateIdle() {
			return state.phase === "shutting_down" && !isBlocked(await probe());
		},
		deferShutdown() {
			if (state.phase !== "shutting_down") return;
			state.phase = "waiting";
			state.quietSince = null;
			state.shutdownAt = null;
			ensureTimer();
			deps.changed?.();
		},
		resume() {
			if (!state.enabled || state.phase === "shutting_down") return;
			deps.registerHook(postShutdownHook);
			ensureTimer();
		},
	};
}

function realDeps(): UnattendedModeDeps {
	return {
		now: () => Date.now(),
		probe: probeUnattendedIdle,
		requestShutdown: (reason) => scheduleOperatorShutdown({ reason }),
		powerOff: (command) => runPowerOff({ custom: command }),
		registerHook: (hook) => registerPostShutdownHook(HOOK_KEY, hook),
		changed: () => eventBus.emit({ type: "system:unattended_changed" }),
		log: logger,
	};
}

export const unattendedMode = hotSafe<UnattendedMode>("narrafork.unattendedMode", () =>
	createUnattendedMode(realDeps()),
);

// Bun --hot re-evaluates this module while the process keeps running. The state object is
// pinned to globalThis, but the poll timer's closure belongs to the previous evaluation, so
// re-bind it (hotTimer clears the old one) whenever the mode is still armed.
const hotState = unattendedMode.status();
if (hotState.enabled && hotState.phase !== "shutting_down") unattendedMode.resume();
