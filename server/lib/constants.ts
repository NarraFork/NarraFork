/** Priority ranking for container statuses — higher = more "active". */
export const CONTAINER_STATUS_PRIORITY: Record<string, number> = {
	removed: 0,
	created: 1,
	stopped: 2,
	paused: 3,
	running: 4,
};
