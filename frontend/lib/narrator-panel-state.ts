import type { NarratorPanelStateOptions, NarratorPanelStateResponse } from "./api/narrators";

/** The missing endpoint and transient transport failures retain compatibility with older servers. */
export function shouldFallbackPanelState(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return false;
	const status = (error as { status?: unknown } | null)?.status;
	return (
		status === undefined ||
		status === 404 ||
		status === 413 ||
		(typeof status === "number" && status >= 500)
	);
}

export interface PanelConnectionState {
	scope: string;
	started: boolean;
	connectedOnce: boolean;
	connected: boolean;
}

/** Every connection edge refreshes the snapshot: an initial pre-connect REST read has an event gap. */
export function panelConnectionRead(
	previous: PanelConnectionState | null,
	scope: string,
	connected: boolean,
): { state: PanelConnectionState; read: "initial" | "fresh" | null } {
	const state =
		previous?.scope === scope
			? previous
			: {
					scope,
					started: false,
					connectedOnce: false,
					connected: false,
				};
	const read = !state.started ? "initial" : connected && !state.connected ? "fresh" : null;
	return {
		state: { scope, started: true, connectedOnce: state.connectedOnce || connected, connected },
		read,
	};
}

export const PANEL_RECONCILE_RESTART_BUDGET = {
	minimumDelayMs: 250,
	windowMs: 10_000,
	maximumRestarts: 3,
} as const;

export interface PanelReconcileRestartScheduler {
	schedule(): void;
	cancel(): void;
	dispose(): void;
}

/** Coalesce bursts; after three fast restarts, retry at the next bounded-rate window, never drop it. */
export function createPanelReconcileRestartScheduler(
	run: () => void,
	isCurrent: () => boolean,
	clock: { now: () => number; defer: (callback: () => void, delayMs: number) => () => void } = {
		now: Date.now,
		defer: (callback, delayMs) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	},
): PanelReconcileRestartScheduler {
	let pending: (() => void) | null = null;
	let windowStartedAt = clock.now();
	let restarts = 0;
	let disposed = false;
	const { minimumDelayMs, windowMs, maximumRestarts } = PANEL_RECONCILE_RESTART_BUDGET;
	const resetWindow = () => {
		if (clock.now() - windowStartedAt >= windowMs) {
			windowStartedAt = clock.now();
			restarts = 0;
		}
	};
	const cancel = () => {
		pending?.();
		pending = null;
	};
	return {
		schedule() {
			if (disposed || pending) return;
			resetWindow();
			const delay =
				restarts >= maximumRestarts
					? Math.max(minimumDelayMs, windowMs - (clock.now() - windowStartedAt))
					: minimumDelayMs;
			pending = clock.defer(() => {
				pending = null;
				if (disposed || !isCurrent()) return;
				resetWindow();
				restarts++;
				run();
			}, delay);
		},
		cancel,
		dispose() {
			disposed = true;
			cancel();
		},
	};
}

/** Walk independent bounded pages, showing the first page immediately rather than hiding permissions. */
export async function reconcilePanelStatePages(
	readPage: (options: NarratorPanelStateOptions) => Promise<NarratorPanelStateResponse>,
	onPage: (snapshot: NarratorPanelStateResponse) => void,
	options: NarratorPanelStateOptions = {},
): Promise<void> {
	const permissions = new Map<string, NarratorPanelStateResponse["permissions"][number]>();
	const buffer = new Map<string, NarratorPanelStateResponse["buffer"][number]>();
	const seenPermissions = new Set<string>();
	const seenBuffer = new Set<string>();
	let permissionsCursor: string | undefined;
	let bufferCursor: string | undefined;
	let first = true;
	const deadline = Date.now() + 10_000;
	for (let pageCount = 0; ; pageCount++) {
		if (options.signal?.aborted)
			throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
		if (pageCount >= 256 || Date.now() > deadline)
			throw new Error("Panel state pagination budget exceeded");
		const page = await readPage({
			...options,
			fresh: first && options.fresh,
			permissionsCursor,
			bufferCursor,
		});
		const permissionPage = first || permissionsCursor !== "end";
		const bufferPage = first || bufferCursor !== "end";
		if (permissionPage)
			for (const permission of page.permissions) permissions.set(permission.id, permission);
		if (bufferPage) for (const message of page.buffer) buffer.set(message.id, message);
		const morePermissions = permissionPage && page.hasMore.permissions;
		const moreBuffer = bufferPage && page.hasMore.buffer;
		onPage({
			...page,
			permissions: [...permissions.values()],
			buffer: [...buffer.values()],
			hasMore: { permissions: morePermissions, buffer: moreBuffer },
		});
		permissionsCursor = morePermissions ? page.nextCursor?.permissions : "end";
		bufferCursor = moreBuffer ? page.nextCursor?.buffer : "end";
		if (morePermissions && (!permissionsCursor || seenPermissions.has(permissionsCursor)))
			throw new Error("Permission page cursor did not advance");
		if (moreBuffer && (!bufferCursor || seenBuffer.has(bufferCursor)))
			throw new Error("Buffer page cursor did not advance");
		if (morePermissions && permissionsCursor) seenPermissions.add(permissionsCursor);
		if (moreBuffer && bufferCursor) seenBuffer.add(bufferCursor);
		if (!morePermissions && !moreBuffer) return;
		first = false;
	}
}
