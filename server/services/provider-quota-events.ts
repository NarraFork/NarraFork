/** Only an authenticated host session can consume deployment-wide Custom API invalidations. */
export interface QuotaInvalidationSocket {
	data: { userId?: string; sessionId?: string; publicShare?: unknown };
	send(payload: string): unknown;
	getBufferedAmount?(): number;
}

export function broadcastProviderQuotaInvalidation(
	connections: Iterable<QuotaInvalidationSocket>,
	event: { providerIds: string[]; version: number },
	visibleIds: ReadonlySet<string>,
): void {
	const providerIds = [...new Set(event.providerIds)]
		.filter((id) => visibleIds.has(id))
		.slice(0, 100);
	if (!providerIds.length) return;
	const payload = JSON.stringify({
		type: "provider_quota_changed",
		providerIds,
		version: event.version,
	});
	for (const socket of connections) {
		if (socket.data.publicShare || !socket.data.userId || !socket.data.sessionId) continue;
		// A missed invalidation is repaired by HTTP SWR. Do not build an unbounded socket backlog.
		if ((socket.getBufferedAmount?.() ?? 0) > 1024 * 1024) continue;
		try {
			socket.send(payload);
		} catch {
			/* The normal heartbeat owns socket cleanup. */
		}
	}
}
