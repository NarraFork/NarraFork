import type { narrators } from "../../db/schema";
import { AppError } from "../../lib/errors";

export type RuntimeSourceObservation = Pick<
	typeof narrators.$inferSelect,
	"runtimeRegistrationJson" | "ownerUserId" | "policySourceNarratorId"
>;

export function assertRuntimeSourceUnchanged(
	expected: RuntimeSourceObservation,
	current:
		| (Omit<RuntimeSourceObservation, "runtimeRegistrationJson"> & {
				runtimeRegistrationJson: unknown;
		  })
		| undefined,
): void {
	if (
		!current ||
		current.ownerUserId !== expected.ownerUserId ||
		current.policySourceNarratorId !== expected.policySourceNarratorId ||
		JSON.stringify(current.runtimeRegistrationJson) !==
			JSON.stringify(expected.runtimeRegistrationJson)
	)
		throw new RuntimeReadConflictError();
}

export class RuntimeReadConflictError extends AppError {
	constructor() {
		super("Runtime state changed while reading", 409, "RUNTIME_READ_CONFLICT");
	}
}
