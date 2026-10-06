/**
 * injection-cadence.ts — "every N completed tool calls, do this once".
 *
 * ## Why this exists
 *
 * Three copies of this counter had grown up independently: two in
 * `narrator-session` (the Dynamic Spec digest and the behaviour fence, each with its
 * own marker field and its own lazy initialisation) and a third in
 * `subagent-executor` with its own hard-coded interval. They were near-identical and
 * disagreed on one detail that matters (see "the empty case" below).
 *
 * Injections are moving off the side-car channel onto message rows, which means the
 * cadence decision has to be separable from the delivery mechanism — a producer will
 * call `deliverInjection` directly rather than answering a `getSideCars` callback. So
 * the counter becomes its own thing first.
 *
 * ## The empty case, which is the reason to prefer one implementation
 *
 * A cadence can come due and then produce nothing: `spec://tasks.json` may have no
 * open tasks, the behaviour fence may be blank. `narrator-session` advances its marker
 * anyway, with a comment explaining why — otherwise the cadence stays permanently due
 * and re-reads the spec file from SQLite on EVERY subsequent tool result, which is a
 * synchronous main-thread read per tool call for as long as the session lives.
 * `subagent-executor` advanced only on success and therefore had exactly that problem.
 *
 * {@link InjectionCadence.due} takes the correct behaviour: asking whether the cadence
 * is due IS the act of consuming it. A caller that produces nothing has still spent
 * the tick.
 *
 * ## Interval semantics (unchanged from the settings they come from)
 *
 *   `> 0`   fire every N completed tool calls
 *   `-1`    disabled (the documented "off" value)
 *   `0`     also treated as disabled — an interval of zero would mean "every call",
 *           which no caller wants and which a mis-set config could produce
 *
 * The interval is read on every check rather than captured, because a narrator's
 * override can change mid-session and should take effect at the next boundary.
 *
 * Pure and synchronous: no DB, no settings import, no clock. Fully unit-testable.
 */

/**
 * A single "every N ticks" gate.
 *
 * One instance per (narrator, purpose). The Dynamic Spec digest and the behaviour
 * fence need separate instances precisely because they fire on different intervals and
 * must not consume each other's ticks.
 */
export class InjectionCadence {
	/**
	 * Where the last-fired tick is kept.
	 *
	 * Indirected through accessors rather than held as a field so a caller whose marker
	 * must OUTLIVE this object can supply its own storage. `narrator-session` needs
	 * exactly that: its cadence markers live on the ActiveNarrator because a session
	 * runs many loop passes and rebuilds its config each time, so a marker owned by the
	 * cadence would restart the schedule on every pass.
	 */
	private readonly read: () => number;
	private readonly write: (count: number) => void;

	/**
	 * @param resolveInterval Read live so a settings change lands at the next boundary
	 *                        instead of one interval later.
	 * @param initial         Either the tick count to start from, or external storage
	 *                        for the marker. Callers persist the completed-tool count
	 *                        across loop runs, so a resumed session must not read its
	 *                        whole history as one overdue interval and fire at once.
	 */
	constructor(
		private readonly resolveInterval: () => number,
		initial: number | { get: () => number; set: (count: number) => void } = 0,
	) {
		if (typeof initial === "number") {
			let owned = initial;
			this.read = () => owned;
			this.write = (count) => {
				owned = count;
			};
		} else {
			this.read = initial.get;
			this.write = initial.set;
		}
	}

	/**
	 * Is the cadence due at `count`? Consumes the tick when it is.
	 *
	 * Deliberately NOT a pure predicate: see the module header. Calling this twice for
	 * the same tick yields true at most once, which is what makes it safe to call from
	 * a per-tool-result path.
	 */
	due(count: number): boolean {
		const interval = this.resolveInterval();
		if (interval <= 0) return false;
		if (count - this.read() < interval) return false;
		this.write(count);
		return true;
	}

	/**
	 * Re-base the cadence without firing.
	 *
	 * For the caller that learns its true starting count only after construction —
	 * `narrator-session` initialises its markers lazily from the persisted tool count
	 * the first time a tool result arrives.
	 */
	rebase(count: number): void {
		this.write(count);
	}

	/** Tick count at which this cadence last fired. Exposed for persistence and tests. */
	get lastFired(): number {
		return this.read();
	}
}

/**
 * Normalize an interval from settings.
 *
 * A non-finite or negative value means "off"; anything else is floored to an integer
 * because the counter it is compared against is one.
 */
export function normalizeCadenceInterval(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return -1;
	if (value <= 0) return -1;
	return Math.floor(value);
}
