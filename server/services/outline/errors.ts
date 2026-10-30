/**
 * Errors an outline transaction is rejected with. Nothing is written when one is thrown.
 */
import { AppError, ValidationError } from "@server/lib/errors";

export type OutlineWriteErrorCode =
	/** More operations than `OUTLINE_LIMITS.maxOps`. */
	| "OUTLINE_TOO_MANY_OPS"
	/** One block's content is over `OUTLINE_LIMITS.maxBodyBytes`. */
	| "OUTLINE_BODY_TOO_LARGE"
	/** All content of the transaction is over `OUTLINE_LIMITS.maxTransactionBodyBytes`. */
	| "OUTLINE_TRANSACTION_TOO_LARGE"
	/** The commit would write more than `OUTLINE_LIMITS.maxRowsTouched` rows. */
	| "OUTLINE_TOO_MANY_ROWS"
	/** A parent has more live children than `OUTLINE_LIMITS.maxSiblings`. */
	| "OUTLINE_TOO_MANY_SIBLINGS"
	/** A block would hold more distinct links than `OUTLINE_LIMITS.maxLinksPerBlock`. */
	| "OUTLINE_TOO_MANY_LINKS"
	/** An operation is malformed (bad field, unknown temp id, bad position, …). */
	| "OUTLINE_INVALID_OP"
	/** A referenced block does not exist in this space. */
	| "OUTLINE_BLOCK_NOT_FOUND"
	/** A referenced block is deleted. */
	| "OUTLINE_BLOCK_DELETED"
	/** A move would put a block under itself. */
	| "OUTLINE_CYCLE"
	/** The outline is deeper than `OUTLINE_LIMITS.maxDepth`. */
	| "OUTLINE_TOO_DEEP"
	/** Another live block of the space already has the alias. */
	| "OUTLINE_ALIAS_TAKEN"
	/** A caller-chosen block id is already in use. */
	| "OUTLINE_ID_TAKEN"
	/** The task is being done by someone else (a live claim); see `OutlineTaskClaimedError`. */
	| "OUTLINE_TASK_CLAIMED";

/** The transaction is invalid as written. `opIndex` is the offending operation, when one is. */
export class OutlineWriteError extends ValidationError {
	constructor(
		message: string,
		code: OutlineWriteErrorCode,
		readonly opIndex: number | null = null,
	) {
		super(opIndex === null ? message : `operation ${opIndex}: ${message}`, code);
		this.name = "OutlineWriteError";
	}
}

export interface OutlineVersionConflict {
	opIndex: number;
	blockId: string;
	sid: string;
	/** The `version_seq` the caller read. */
	expectedVersionSeq: number;
	/** The block's `version_seq` now. */
	actualVersionSeq: number;
}

/**
 * Blocks changed since the caller read them (`baseVersionSeq` no longer matches). The whole
 * transaction is rejected; the caller re-reads those blocks and tries again.
 */
export class OutlineConflictError extends AppError {
	constructor(readonly conflicts: OutlineVersionConflict[]) {
		super(
			`outline blocks changed since they were read: ${conflicts
				.map((c) => `${c.sid} (read ${c.expectedVersionSeq}, now ${c.actualVersionSeq})`)
				.join(", ")}`,
			409,
			"OUTLINE_VERSION_CONFLICT",
		);
		this.name = "OutlineConflictError";
	}
}

/** The space kept changing while the transaction was planned; nothing was written. */
export class OutlineBusyError extends AppError {
	constructor(spaceId: string, attempts: number) {
		super(
			`outline space ${spaceId} changed during ${attempts} attempts to write; try again`,
			503,
			"OUTLINE_SPACE_BUSY",
		);
		this.name = "OutlineBusyError";
	}
}

/** Who holds a claim: a session (with its lease end) or a person. */
export type OutlineClaimHolder =
	| { kind: "agent"; narratorId: string; expiresAt: string | null }
	| { kind: "human"; userId: string };

/**
 * Setting a task to in progress claims it, and someone else is doing it: a session whose lease
 * is still running, or a person. The whole transaction is refused; `holder` says who.
 */
export class OutlineTaskClaimedError extends OutlineWriteError {
	constructor(
		readonly blockId: string,
		readonly address: string,
		readonly holder: OutlineClaimHolder,
		opIndex: number | null,
	) {
		super(
			`task ${address} is being done by ${
				holder.kind === "agent"
					? `session ${holder.narratorId}${holder.expiresAt ? ` (lease until ${holder.expiresAt})` : ""}`
					: `user ${holder.userId}`
			}`,
			"OUTLINE_TASK_CLAIMED",
			opIndex,
		);
		this.name = "OutlineTaskClaimedError";
	}
}

/**
 * A lease expiry found claims that are no longer expired (renewed since they were listed) or no
 * longer in progress. Nothing was written; `blockIds` are the tasks to leave alone.
 */
export class OutlineLeaseNotExpiredError extends Error {
	constructor(readonly blockIds: string[]) {
		super(`outline task leases no longer expired: ${blockIds.join(", ")}`);
		this.name = "OutlineLeaseNotExpiredError";
	}
}
