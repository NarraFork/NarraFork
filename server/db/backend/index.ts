/**
 * The database backend boundary.
 *
 * Import from HERE rather than from an adapter module: the ports and the capability vocabulary are
 * the stable surface, the `sqlite-*` implementations are not. Only SQLite is wired today; this
 * namespace exists so a second backend can be added as new adapter modules plus one wiring change,
 * instead of as edits scattered through lifecycle, maintenance and cleanup code.
 *
 * Not exported on purpose: the `sqlite-*` factories. Reaching an adapter directly is how "the
 * boundary exists" quietly becomes "the boundary is bypassed"; the one place that chooses an
 * implementation is `server/db/index.ts`.
 */

export { SQLITE_BACKEND_ID } from "./backend-ids";
export {
	type CapabilityResult,
	capabilityDisabled,
	type DatabaseBackendId,
	describeUnsupported,
	isSupported,
	notApplicable,
	notImplemented,
	requireCapability,
	type SupportedCapability,
	supported,
	supportedVoid,
	type UnsupportedCapability,
	type UnsupportedCapabilityCode,
	UnsupportedCapabilityError,
} from "./capability";
export type {
	DatabaseLifecyclePort,
	DatabaseRepairOutcome,
	DatabaseStartupReport,
	DatabaseStartupState,
	DatabaseVerificationPort,
	MigrationRunOutcome,
} from "./lifecycle-port";
export type {
	BackgroundUpkeepPlan,
	CheckpointRequest,
	DatabaseMaintenancePort,
	DatabaseUpkeepPort,
	MaintenanceFailure,
	MaintenanceFailureKind,
	ReusableSpaceReport,
} from "./maintenance-port";
