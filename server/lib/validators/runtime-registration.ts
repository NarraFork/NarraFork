import { z } from "zod";

/**
 * Runtime registration of one narrator: who may control it, which model pool it follows
 * its source within, and what the current run is bound to. It stores relationships and
 * facts only — capability ceilings live in traits, model/permission settings in their
 * own columns, and the policy source in the indexed `policy_source_narrator_id` column.
 * Nothing here names a role; any two narrators can be related.
 */

/** Hard ceiling on the serialized registration (UTF-8 bytes). */
export const RUNTIME_REGISTRATION_MAX_BYTES = 64 * 1024;

const narratorId = z.string().min(1).max(64);
const recordId = z.string().min(1).max(128);
const attempt = z.number().int().nonnegative();

/** Control actions an agent may hold on another session; add one only with a caller. */
export const CONTROLLER_ACTIONS = ["steer", "stop", "archive"] as const;
export type ControllerAction = (typeof CONTROLLER_ACTIONS)[number];

/** The exact tool attempt a run is attached to (foreground cancel or result delivery). */
const toolAttemptSchema = z.strictObject({
	narratorId,
	toolCallId: recordId,
	attempt,
});

/**
 * Tool call that receives a run's result and hosts its transcript (foreground result
 * or task card). `toolUseId` is the provider id the display adapter groups by; the
 * exact row/attempt is recorded whenever the starting call supplied one.
 */
const deliverToSchema = z.strictObject({
	narratorId,
	toolUseId: recordId,
	toolCallId: recordId.optional(),
	attempt: attempt.optional(),
	/**
	 * The result lands on the run's background task row (Await, task card, completion
	 * notice), never on the tool call. A later run inheriting the destination keeps it.
	 */
	viaTask: z.literal(true).optional(),
});

const runBindingSchema = z.strictObject({
	/** Logical run these facts belong to; a later run never inherits them. */
	logicalRunId: recordId,
	/** Cancelling exactly this caller run/tool attempt cancels this run. */
	cancelWith: toolAttemptSchema.extend({ runId: recordId.optional() }).optional(),
	/** Tool call that receives this run's result (foreground result or task card). */
	deliverTo: deliverToSchema.optional(),
	/** Execution principal. `userId: null` is an explicit anonymous principal. */
	principal: z.strictObject({ userId: z.string().min(1).max(64).nullable() }).optional(),
	/** Absolute deadline; resume/detach never restart it. */
	deadlineAt: z.iso.datetime().optional(),
	/** First history seq that belongs to this run. */
	historyStartSeq: z.number().int().nonnegative().optional(),
});

/**
 * The outline task a subagent was sent to do (`Agent` with `task`, outline P2 PR 9a): set once
 * when it is created, kept across its runs (Send continuations, recovery). Each run's result is
 * attached under the task as a report, and the claim generation tells a late result.
 */
const delegatedTaskSchema = z.strictObject({
	spaceId: recordId,
	blockId: recordId,
	/** Claim generation the delegation's commit wrote. */
	epoch: z.number().int().positive(),
	/** The session that sent it (its root). */
	delegatorNarratorId: narratorId,
	/** The Agent call that sent it (its tool-call row). */
	toolCallId: recordId,
	/** Language of the report blocks written under the task. */
	locale: z.enum(["en", "zh-CN"]),
});

const registrationShape = {
	version: z.literal(1),
	/**
	 * Model pool (key of `custom-subagent-models` / `subagentAllowedModels`) applied when
	 * this narrator follows its source's model. Chosen once at creation; runtime never
	 * derives it from how the narrator was created.
	 */
	modelPool: z.string().min(1).max(256).optional(),
	/** Session-level control grant, independent of any run binding. */
	controller: z
		.strictObject({
			narratorId,
			actions: z.array(z.enum(CONTROLLER_ACTIONS)).min(1).max(CONTROLLER_ACTIONS.length),
		})
		.optional(),
	/** Transcript placement is durable history, not a live result-delivery relationship. */
	historyPlacement: z.strictObject({ toolUseId: recordId }).optional(),
	run: runBindingSchema.optional(),
	delegatedTask: delegatedTaskSchema.optional(),
};

export const runtimeRegistrationSchema = z.strictObject(registrationShape);

/**
 * What a stored registration is read with: the same fields, but a top-level field this version
 * does not know is dropped instead of failing every read of the narrator. A version rolled back
 * to keeps working with registrations a later version wrote (and drops what it does not know at
 * its next write); everything it does know is checked as strictly as on write.
 */
const storedRegistrationSchema = z.object(registrationShape);

export type RuntimeRegistration = z.infer<typeof runtimeRegistrationSchema>;
export type DelegatedTaskRegistration = z.infer<typeof delegatedTaskSchema>;
export type RuntimeRunBinding = z.infer<typeof runBindingSchema>;
/** Absolute deadline for a run started now with an optional timeout (0/undefined = none). */
export function runDeadlineAt(timeoutMs: number | null | undefined, now = Date.now()) {
	return timeoutMs && timeoutMs > 0 ? new Date(now + timeoutMs).toISOString() : undefined;
}
export type RunDeliverTo = z.infer<typeof deliverToSchema>;
export type RunCancelWith = NonNullable<RuntimeRunBinding["cancelWith"]>;

/** Parse a stored or proposed registration; any violation is an explicit error. */
export function parseRuntimeRegistration(value: unknown): RuntimeRegistration {
	const parsed = runtimeRegistrationSchema.parse(value);
	const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf-8");
	if (bytes > RUNTIME_REGISTRATION_MAX_BYTES) {
		throw new Error(`Runtime registration exceeds ${RUNTIME_REGISTRATION_MAX_BYTES} bytes`);
	}
	return parsed;
}

/**
 * What creating a delegation registers on the delegated narrator: the delegator controls
 * it, and following the delegator's model uses the template's pool. (The delegator is
 * also its policy source, stored in `policy_source_narrator_id`.)
 */
export function delegationRegistration(
	controllerNarratorId: string,
	modelPool: string,
): RuntimeRegistration {
	return parseRuntimeRegistration({
		version: 1,
		modelPool,
		controller: { narratorId: controllerNarratorId, actions: [...CONTROLLER_ACTIONS] },
	});
}

/** Relationship facts a caller registers when it starts a run (the run id is assigned). */
export type RunBindingInput = Omit<RuntimeRunBinding, "logicalRunId" | "historyStartSeq">;

/**
 * The registration after `logicalRunId` starts. A new run replaces the previous run's
 * facts entirely. Re-registering the same run (recovery, detach) keeps what the caller
 * does not restate; its deadline and source boundary never restart.
 */
export function registerRun(
	stored: unknown,
	logicalRunId: string,
	binding: RunBindingInput,
	historyStartSeq: number | undefined,
): RuntimeRegistration & { run: RuntimeRunBinding } {
	const current = readRuntimeRegistrationColumn(stored) ?? { version: 1 as const };
	const previous = current.run?.logicalRunId === logicalRunId ? current.run : undefined;
	const run = JSON.parse(
		JSON.stringify({
			...previous,
			...binding,
			logicalRunId,
			deadlineAt: previous ? previous.deadlineAt : binding.deadlineAt,
			historyStartSeq: previous ? previous.historyStartSeq : historyStartSeq,
		}),
	) as RuntimeRunBinding;
	return parseRuntimeRegistration({ ...current, run }) as RuntimeRegistration & {
		run: RuntimeRunBinding;
	};
}

/**
 * Read the stored column: null means nothing registered; anything invalid throws (an unknown
 * top-level field is dropped, see `storedRegistrationSchema`). The size ceiling is enforced on
 * write (`parseRuntimeRegistration`), not on every read.
 */
export function readRuntimeRegistrationColumn(value: unknown): RuntimeRegistration | null {
	return value === null || value === undefined ? null : storedRegistrationSchema.parse(value);
}
