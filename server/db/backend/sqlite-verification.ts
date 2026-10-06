/**
 * The SQLite implementation of {@link DatabaseVerificationPort}.
 *
 * SQLite can be verified, but only OUT OF PROCESS. `PRAGMA quick_check` / `integrity_check` read
 * every page and `bun:sqlite` is synchronous, so an in-process scan stalls all HTTP/WS/agent traffic
 * for its whole duration (measured: 77s on a 5.3 GB file). The probe therefore runs in a read-only
 * subprocess (`integrity-probe-worker.ts`), which can neither write nor take the write lock.
 *
 * This module deliberately describes the probe instead of running it: the schedule, the timeout, the
 * output cap and the verdict bookkeeping stay in `integrity-check.ts`, which is where the
 * hot-reload-safe state and the pending-repair marker already live.
 *
 * The reason this is a capability at all: on a server-managed engine the honest answer is
 * `notApplicable` — that engine verifies itself on its own schedule and an operator owns the backup
 * policy. A stub probe that always answered "ok" would silently retire the entire
 * corruption-detection path while looking perfectly healthy.
 */

import { SQLITE_BACKEND_ID } from "./backend-ids";
import { type CapabilityResult, supported } from "./capability";
import type { DatabaseVerificationPort } from "./lifecycle-port";

export function createSqliteVerification(): DatabaseVerificationPort {
	return {
		backendId: SQLITE_BACKEND_ID,
		outOfBandProbe(): CapabilityResult<{ description: string; readOnly: boolean }> {
			return supported({
				description: "read-only integrity probe subprocess",
				readOnly: true,
			});
		},
	};
}

/** The single instance the startup path uses. Stateless, so sharing it is free. */
export const sqliteVerificationPort: DatabaseVerificationPort = createSqliteVerification();
