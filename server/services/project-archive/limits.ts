/** Fixed production budgets for portable project database exports and imports. */
export const PROJECT_ARCHIVE_LIMITS = Object.freeze({
	rowBytes: 4 * 1024 * 1024,
	stateBytes: 64 * 1024 * 1024,
	stateRows: 100_000,
	jobMs: 10 * 60_000,
});
