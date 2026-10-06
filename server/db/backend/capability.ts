/**
 * How a database backend answers "can you do this at all?".
 *
 * WHY A RESULT TYPE RATHER THAN A BOOLEAN OR A ZERO
 * ------------------------------------------------
 * The lifecycle and maintenance surfaces this repository grew are shaped by SQLite: a clean
 * shutdown MARKER written into `application_id`, a WAL to checkpoint, a freelist to measure, a
 * whole-file `VACUUM` to rewrite, a `.recover` CLI to fall back on. None of those exist on a
 * server-managed engine — not "return 0", not "no-op", but genuinely no such concept.
 *
 * The tempting shortcut is to give a second backend stub methods that return `0` / `false` /
 * `undefined`. That is worse than not having the method: `freelistBytes: 0` reads as "nothing to
 * reclaim" and `wasClean: false` reads as "the last shutdown was dirty", so a caller cannot tell a
 * measured answer from an absent one, and an operator reads a confident number that means nothing.
 *
 * So every capability whose existence is engine-dependent returns {@link CapabilityResult}: either
 * a value that was really produced, or an explicit refusal carrying a machine-readable code and a
 * human-readable reason. Callers must branch. That branch is where "this deployment cannot do X"
 * gets logged, surfaced, or turned into an error — deliberately, at the call site.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a plugin registry and not a dispatch table. {@link DatabaseBackendId} is a DIAGNOSTIC label:
 * no caller may branch on it. Branching on the id ("if sqlite then …") recreates exactly the
 * engine coupling the ports exist to remove, and it silently mis-handles any id nobody thought of.
 * Ask the capability instead.
 *
 * Only SQLite is wired today. This module states how a future backend says "not me" without
 * lying; it does not claim any other backend exists.
 */

/**
 * Diagnostic label for the engine behind a port, for logs and error text.
 *
 * Deliberately a plain string, not a closed union: a union would either have to name backends
 * that do not exist yet (announcing support nobody built) or force test doubles to lie about
 * which engine they are. Nothing dispatches on this value — see the module note above.
 */
export type DatabaseBackendId = string;

/**
 * Why a capability produced no value.
 *
 *   notApplicable  The concept does not exist for this engine. There is nothing to implement and
 *                  nothing to wait for — a server-managed engine has no local file to VACUUM.
 *   notImplemented The concept exists for this engine but this build does not do it yet. A real
 *                  gap, distinguished from the above so a reader can tell "impossible" from "todo".
 *   disabled       Supported and implemented, but switched off for this deployment (env, config,
 *                  an operator's explicit choice).
 */
export type UnsupportedCapabilityCode = "notApplicable" | "notImplemented" | "disabled";

export interface SupportedCapability<T> {
	readonly supported: true;
	readonly value: T;
}

export interface UnsupportedCapability {
	readonly supported: false;
	readonly code: UnsupportedCapabilityCode;
	/** Operator-facing explanation. Never empty — see {@link assertReason}. */
	readonly reason: string;
}

export type CapabilityResult<T> = SupportedCapability<T> | UnsupportedCapability;

/**
 * A refusal without a reason is indistinguishable from a bug, and it reaches an operator as an
 * empty log field at the exact moment they need to know why maintenance did not run. Reject it
 * where it is constructed rather than where it is read.
 */
function assertReason(reason: string): string {
	const trimmed = reason.trim();
	if (!trimmed) {
		throw new Error("An unsupported capability must carry a non-empty reason");
	}
	return trimmed;
}

export function supported<T>(value: T): SupportedCapability<T> {
	return { supported: true, value };
}

/** For capabilities that perform an action and have nothing to report but success. */
export function supportedVoid(): SupportedCapability<void> {
	return { supported: true, value: undefined };
}

export function notApplicable(reason: string): UnsupportedCapability {
	return { supported: false, code: "notApplicable", reason: assertReason(reason) };
}

export function notImplemented(reason: string): UnsupportedCapability {
	return { supported: false, code: "notImplemented", reason: assertReason(reason) };
}

export function capabilityDisabled(reason: string): UnsupportedCapability {
	return { supported: false, code: "disabled", reason: assertReason(reason) };
}

export function isSupported<T>(result: CapabilityResult<T>): result is SupportedCapability<T> {
	return result.supported;
}

/** `notApplicable: a server-managed engine has no WAL` — the shape logs and error text share. */
export function describeUnsupported(result: UnsupportedCapability): string {
	return `${result.code}: ${result.reason}`;
}

/**
 * Thrown by {@link requireCapability}.
 *
 * Carries the code separately so a caller can map it onto a status (a `disabled` capability is a
 * configuration problem the operator can undo; `notApplicable` never will be).
 */
export class UnsupportedCapabilityError extends Error {
	readonly code: UnsupportedCapabilityCode;
	readonly reason: string;
	readonly capability: string;

	constructor(capability: string, unsupported: UnsupportedCapability) {
		super(`${capability} is unavailable (${describeUnsupported(unsupported)})`);
		this.name = "UnsupportedCapabilityError";
		this.code = unsupported.code;
		this.reason = unsupported.reason;
		this.capability = capability;
	}
}

/**
 * Unwrap a capability the caller genuinely cannot proceed without.
 *
 * Use this ONLY where an absent capability is an error worth surfacing (an admin explicitly asked
 * for space reclamation on an engine that cannot do it). Where the caller can degrade — skip a
 * probe, leave a number unmeasured — branch on {@link isSupported} instead and say so in the log,
 * because turning a degradable path into a throw takes the whole feature down with it.
 */
export function requireCapability<T>(result: CapabilityResult<T>, capability: string): T {
	if (result.supported) return result.value;
	throw new UnsupportedCapabilityError(capability, result);
}
