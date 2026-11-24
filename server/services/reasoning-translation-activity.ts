import {
	isReasoningTranslationId,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";

const MAX_CHECKPOINTS = 256;
const CHECKPOINT_TTL_MS = 120_000;

/** Server-owned authorization for a closed prefix of an otherwise unfinished lane. */
export class ReasoningTranslationActivity {
	private readonly checkpoints = new Map<
		string,
		{
			owner: string;
			messageId: string;
			revision: number;
			end: number;
			until: number;
		}
	>();

	seal(owner: string, messageId: string, elementId: string, revision: number, end: number): void {
		if (
			![owner, messageId, elementId].every(isReasoningTranslationId) ||
			!Number.isSafeInteger(revision) ||
			revision < 0 ||
			!Number.isSafeInteger(end) ||
			end <= 0
		)
			return;
		const prior = this.checkpoints.get(elementId);
		if (
			prior &&
			(prior.owner !== owner || prior.messageId !== messageId || prior.revision > revision)
		)
			return;
		this.checkpoints.delete(elementId);
		if (this.checkpoints.size >= MAX_CHECKPOINTS) {
			const oldest = this.checkpoints.keys().next();
			if (!oldest.done) this.checkpoints.delete(oldest.value);
		}
		this.checkpoints.set(elementId, {
			owner,
			messageId,
			revision,
			end,
			until: Date.now() + CHECKPOINT_TTL_MS,
		});
	}

	end(target: ReasoningTranslationVisibilityTarget, revision: number | undefined): number {
		const grant = this.checkpoints.get(target.elementId);
		return grant &&
			grant.owner === target.ownerNarratorId &&
			grant.messageId === target.messageId &&
			grant.revision === revision &&
			grant.until > Date.now()
			? grant.end
			: 0;
	}

	clear(owner: string): void {
		for (const [elementId, grant] of this.checkpoints) {
			if (grant.owner === owner) this.checkpoints.delete(elementId);
		}
	}
}

export const reasoningTranslationActivity = new ReasoningTranslationActivity();
