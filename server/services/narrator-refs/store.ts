import { selectReadBackend } from "../../db/backend/read-selector";
import { assertWriteBackendMatchesRead, selectWriteBackend } from "../../db/backend/write-selector";
import type { NarratorMessageRefsPort } from "./port";

export type NarratorRefsBinding =
	| { backend: "sqlite" }
	| { backend: "postgres"; port: NarratorMessageRefsPort };
let binding: NarratorRefsBinding | undefined;

/** Composition root owns installation and disposal. Never casts the global SQLite handle. */
export function bindNarratorMessageRefs(value: NarratorRefsBinding | undefined): void {
	binding = value;
}

/** Resolved at call time so PG composition can bind before the first domain operation. */
export function getNarratorMessageRefsPort(): NarratorMessageRefsPort | undefined {
	if (binding) return binding.backend === "postgres" ? binding.port : undefined;
	const write = selectWriteBackend(process.env.NF_WRITE_BACKEND, { postgresAvailable: false });
	assertWriteBackendMatchesRead(write, selectReadBackend(process.env.NF_READ_BACKEND));
	return undefined;
}

export function assertSqliteNarratorOperation(operation: string): void {
	if (getNarratorMessageRefsPort())
		throw new Error(`PostgreSQL narrator operation unavailable: ${operation}`);
}
