/**
 * Diagnostic backend labels.
 *
 * These are for logs, reports and error text ONLY. Nothing may branch on them: a caller that
 * writes `if (backendId === SQLITE_BACKEND_ID)` has re-created the engine coupling the ports
 * exist to remove, and will mis-handle any id it does not recognise. Ask the capability instead
 * (see `capability.ts`).
 */

import type { DatabaseBackendId } from "./capability";

export const SQLITE_BACKEND_ID: DatabaseBackendId = "sqlite";
