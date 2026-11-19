import {
	MAX_REASONING_TRANSLATION_COMPLETED_RANGES,
	type ReasoningTranslationActivity,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";

interface ActiveReasoning extends ReasoningTranslationActivity {
	target?: ReasoningTranslationVisibilityTarget;
	/** Only lengths and identities survive checkpoints, never reasoning bodies. */
	persistedRevision?: number;
	persistedLength?: number;
	/** Prefix still valid after newer raw deltas that have not reached persistence yet. */
	persistedValidLength?: number;
	part?: { id: string; index: number };
	pendingSeals?: Array<{ start: number; end: number; part?: { id: string; index: number } }>;
}

/** One live display lane per author, independent of durable translation completion. */
export class ReasoningTranslationActivities {
	private readonly authors = new Map<string, ActiveReasoning>();
	private readonly closed = new Map<string, ActiveReasoning>();
	private readonly retired = new Map<string, { elementId: string; messageId?: string }>();

	get(author: string): ReasoningTranslationActivity | null {
		const active = this.authors.get(author);
		return active
			? {
					elementId: active.elementId,
					revision: active.revision,
					completedRanges: active.completedRanges.map((range) => ({ ...range })),
					displayTailStart: active.displayTailStart ?? 0,
				}
			: null;
	}

	start(
		author: string,
		elementId: string,
		revision: number,
		textOffset?: number,
		part?: { id: string; index: number },
	): ReasoningTranslationVisibilityTarget | undefined {
		const previous = this.authors.get(author);
		this.retired.delete(author);
		if (previous?.elementId === elementId) {
			if (revision <= previous.revision) return undefined;
			previous.revision = revision;
			if (textOffset != null) {
				previous.completedRanges = previous.completedRanges
					.map((range) => ({ start: range.start, end: Math.min(range.end, textOffset) }))
					.filter((range) => range.end > range.start);
				previous.pendingSeals = previous.pendingSeals?.filter((range) => range.end <= textOffset);
				previous.persistedValidLength = Math.min(
					previous.persistedValidLength ?? previous.persistedLength ?? textOffset,
					textOffset,
				);
				previous.displayTailStart = Math.min(previous.displayTailStart ?? 0, textOffset);
			}
			if (part && (!previous.part || part.index > previous.part.index)) {
				const handedOff = !!previous.part && previous.part.id !== part.id;
				previous.part = part;
				const promoted = (previous.pendingSeals ?? []).filter(
					(range) => range.part && range.part.id !== part.id && range.part.index < part.index,
				);
				previous.pendingSeals = previous.pendingSeals?.filter((range) => !promoted.includes(range));
				const displayTailStart = previous.displayTailStart ?? 0;
				if (handedOff) previous.displayTailStart = Math.max(displayTailStart, textOffset ?? 0);
				if (this.promote(previous, promoted) || previous.displayTailStart !== displayTailStart)
					return previous.target;
			}
			return undefined;
		}
		const closed = this.closed.get(author);
		const reopened = closed?.elementId === elementId ? closed : undefined;
		if (reopened && revision <= reopened.revision) return undefined;
		const end = Math.min(reopened?.persistedLength ?? 0, textOffset ?? Number.MAX_SAFE_INTEGER);
		this.authors.set(author, {
			...reopened,
			elementId,
			revision,
			part,
			pendingSeals: [],
			persistedValidLength: end,
			displayTailStart: Math.min(
				reopened?.displayTailStart ?? 0,
				textOffset ?? Number.MAX_SAFE_INTEGER,
			),
			completedRanges: end > 0 ? [{ start: 0, end }] : [],
		});
		if (previous) this.closed.set(author, previous);
		return previous?.target;
	}

	/** The caller has verified this exact revision/length against its durable source. */
	checkpoint(
		author: string,
		target: ReasoningTranslationVisibilityTarget,
		revision: number,
		length: number,
		completed?: boolean,
	): boolean {
		if (
			target.ownerNarratorId !== author ||
			!target.elementId ||
			!Number.isSafeInteger(revision) ||
			revision < 0 ||
			!Number.isSafeInteger(length) ||
			length < 0
		)
			return false;
		let active = this.authors.get(author);
		const retired = this.retired.get(author);
		if (
			!active &&
			retired?.elementId === target.elementId &&
			(retired.messageId === undefined || retired.messageId === target.messageId)
		)
			return false;
		const closed = this.closed.get(author);
		const matchingClosed =
			closed?.elementId === target.elementId &&
			(!closed.target || closed.target.messageId === target.messageId)
				? closed
				: undefined;
		if (!active && !matchingClosed) {
			active = {
				elementId: target.elementId,
				revision,
				completedRanges: [],
				pendingSeals: [],
				displayTailStart: 0,
			};
			this.authors.set(author, active);
		}
		if (!active || active.elementId !== target.elementId) {
			// A real lane switch/termination can precede its durable acknowledgement.
			if ((matchingClosed?.persistedRevision ?? -1) > revision) return false;
			this.closed.set(author, {
				...matchingClosed,
				elementId: target.elementId,
				revision: Math.max(matchingClosed?.revision ?? revision, revision),
				persistedRevision: revision,
				persistedLength: length,
				target,
				completedRanges: [],
			});
			return true;
		}
		if (
			(active.target && active.target.messageId !== target.messageId) ||
			(active.persistedRevision ?? -1) > revision
		)
			return false;
		active.target = target;
		active.persistedRevision = revision;
		active.persistedLength = length;
		if (revision < active.revision) {
			active.persistedValidLength = Math.min(active.persistedValidLength ?? 0, length);
			return false;
		}
		active.persistedValidLength = length;
		if (revision > active.revision && completed !== true) {
			// Without a corresponding raw delta, no append boundary was observed.
			// A checkpoint-only rewrite must not inherit eligibility from old text.
			active.completedRanges = [];
			active.pendingSeals = [];
			active.displayTailStart = 0;
		}
		if (length < (active.completedRanges.at(-1)?.end ?? 0))
			active.completedRanges = active.completedRanges.filter((range) => range.end <= length);
		active.displayTailStart = Math.min(active.displayTailStart ?? 0, length);
		active.revision = revision;
		// Completion grants translation, never a display handoff or an activity clear.
		return completed === true && length > 0
			? this.promote(active, [{ start: 0, end: length }])
			: false;
	}

	seal(
		author: string,
		elementId: string,
		revision: number,
		start: number,
		end: number,
		part?: { id: string; index: number },
	): ReasoningTranslationVisibilityTarget | undefined {
		const active = this.authors.get(author);
		if (
			!active ||
			active.elementId !== elementId ||
			!active.target ||
			revision !== active.persistedRevision ||
			revision > active.revision ||
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end <= start ||
			end > (active.persistedValidLength ?? active.persistedLength ?? 0)
		)
			return undefined;
		if (part && active.part && active.part.index > part.index && active.part.id !== part.id) {
			const displayTailStart = active.displayTailStart ?? 0;
			active.displayTailStart = Math.max(displayTailStart, end);
			return this.promote(active, [{ start, end }]) || active.displayTailStart !== displayTailStart
				? active.target
				: undefined;
		}
		active.pendingSeals ??= [];
		const previous = active.pendingSeals.findIndex((range) =>
			part ? range.part?.id === part.id : !range.part && range.start === start,
		);
		if (previous >= 0) active.pendingSeals[previous] = { start, end, part };
		else if (active.pendingSeals.length < MAX_REASONING_TRANSLATION_COMPLETED_RANGES)
			active.pendingSeals.push({ start, end, part });
		return undefined;
	}

	private promote(
		active: ActiveReasoning,
		ranges: readonly { start: number; end: number }[],
	): boolean {
		if (!ranges.length) return false;
		const candidates = [...active.completedRanges, ...ranges].sort((a, b) => a.start - b.start);
		const merged: ReasoningTranslationActivity["completedRanges"] = [];
		for (const range of candidates) {
			const previous = merged.at(-1);
			if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
			else merged.push({ start: range.start, end: range.end });
		}
		if (merged.length > MAX_REASONING_TRANSLATION_COMPLETED_RANGES) return false;
		const changed = JSON.stringify(merged) !== JSON.stringify(active.completedRanges);
		active.completedRanges = merged;
		return changed;
	}

	finish(author: string, forget = false): ReasoningTranslationVisibilityTarget | undefined {
		const active = this.authors.get(author);
		this.authors.delete(author);
		if (forget) {
			const ended = active ?? this.closed.get(author);
			if (ended)
				this.retired.set(author, {
					elementId: ended.elementId,
					messageId: ended.target?.messageId,
				});
			this.closed.delete(author);
		} else if (active) this.closed.set(author, active);
		return active?.target;
	}

	/** Exact durable scope at a completion event, without retaining source bodies. */
	completedRanges(
		target: ReasoningTranslationVisibilityTarget,
	): Array<{ start: number; end: number }> | undefined {
		const active = this.authors.get(target.ownerNarratorId);
		if (
			active &&
			active.elementId === target.elementId &&
			active.target?.messageId === target.messageId
		)
			return active.completedRanges.map((range) => ({ ...range }));
		const closed = this.closed.get(target.ownerNarratorId);
		if (
			!closed ||
			closed.elementId !== target.elementId ||
			closed.target?.messageId !== target.messageId ||
			closed.persistedLength == null
		)
			return undefined;
		return closed.persistedLength > 0 ? [{ start: 0, end: closed.persistedLength }] : [];
	}

	ranges(
		target: ReasoningTranslationVisibilityTarget,
		length: number,
	): Array<{ start: number; end: number }> {
		const active = this.authors.get(target.ownerNarratorId);
		if (
			!active ||
			active.elementId !== target.elementId ||
			(active.target && active.target.messageId !== target.messageId)
		)
			return length ? [{ start: 0, end: length }] : [];
		return active.completedRanges
			.filter((range) => range.end <= length)
			.map((range) => ({ ...range }));
	}

	allows(target: ReasoningTranslationVisibilityTarget, start: number, end: number): boolean {
		return this.ranges(target, Number.MAX_SAFE_INTEGER).some(
			(range) => range.start <= start && end <= range.end,
		);
	}
}

export const reasoningTranslationActivities = new ReasoningTranslationActivities();
