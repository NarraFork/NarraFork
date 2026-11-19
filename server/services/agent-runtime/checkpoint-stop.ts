/** Process-local unwinding, never a user cancellation or a terminal run result. */
export interface CheckpointRunIdentity {
	narratorId: string;
	logicalRunId: string;
	executionEpoch: string;
}

const trustedStops = new WeakSet<object>();
const acceptedDrains = new WeakMap<AbortSignal, CheckpointStop>();

/** Only an observed control transfer may protect failures while its results are drained. */
export function acceptCheckpointStopDrain(
	signal: AbortSignal,
	narratorId: string,
	stop: CheckpointStop,
): void {
	if (isCheckpointStop(stop) && stop.identity.narratorId === narratorId)
		acceptedDrains.set(signal, stop);
}

export function getAcceptedCheckpointStopDrain(signal: AbortSignal): CheckpointStop | undefined {
	return acceptedDrains.get(signal);
}

export function clearAcceptedCheckpointStopDrain(signal: AbortSignal): void {
	acceptedDrains.delete(signal);
}
let admissionFrozen = false;

/** Called by the run service only after new execution admission has been closed. */
export function freezeCheckpointStopAdmission(): void {
	admissionFrozen = true;
}

export function isCheckpointStopAdmissionFrozen(): boolean {
	return admissionFrozen;
}

export class CheckpointStop extends Error {
	readonly name = "CheckpointStop";
	/** A failed local flush preserves restart state, but forbids a clean marker. */
	cleanupFailure?: unknown;
	constructor(
		readonly updateEpoch: string,
		readonly identity: CheckpointRunIdentity,
	) {
		super("Process execution released to its durable restart checkpoint");
		trustedStops.add(this);
	}
}

export function isCheckpointStop(error: unknown): error is CheckpointStop {
	return typeof error === "object" && error !== null && trustedStops.has(error);
}

export function matchesCheckpointRun(
	error: unknown,
	identity: CheckpointRunIdentity,
): error is CheckpointStop {
	return (
		isCheckpointStop(error) &&
		error.identity.narratorId === identity.narratorId &&
		error.identity.logicalRunId === identity.logicalRunId &&
		error.identity.executionEpoch === identity.executionEpoch
	);
}
