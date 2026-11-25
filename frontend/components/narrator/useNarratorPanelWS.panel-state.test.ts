import { describe, expect, test } from "bun:test";
import type { NarratorPanelStateResponse } from "@frontend/lib/api/narrators";
import type { BufferMessageSummary } from "@frontend/lib/api/types";
import {
	reconcilePanelStatePages,
	shouldFallbackPanelState,
} from "@frontend/lib/narrator-panel-state";
import type { PendingPermission } from "@frontend/types/narrator";
import {
	reconcilePendingPermissions,
	upsertPendingPermissionMap,
} from "./pending-permissions-reconcile";

// Execute the shipped callbacks, including delayed React updates, without unrelated panel dependencies.
const source = await Bun.file(new URL("./useNarratorPanelWS.ts", import.meta.url)).text();
const permissionStart = source.indexOf("\tconst upsertPendingPermission = useCallback(");
const permissionEnd = source.indexOf("\n\t// Reset the permission lifecycle", permissionStart);
const reconcileStart = source.indexOf("\tconst reconcilePanelState = useCallback(");
const reconcileEnd = source.indexOf("\n\tuseEffect(() => {", reconcileStart);
if ([permissionStart, permissionEnd, reconcileStart, reconcileEnd].some((offset) => offset < 0))
	throw new Error("Panel reconcile callback boundaries not found");
const callbackCode = new Bun.Transpiler({ loader: "ts" }).transformSync(
	source.slice(permissionStart, permissionEnd) + source.slice(reconcileStart, reconcileEnd),
);

const permission = (id: string): PendingPermission => ({
	id,
	toolName: "Bash",
	inputJson: { command: "pwd" },
});
const message = (id: string): BufferMessageSummary => ({
	id,
	text: id,
	bufferedAt: "t",
	imageCount: 0,
});
const page = (
	id: string,
	overrides: Partial<NarratorPanelStateResponse> = {},
): NarratorPanelStateResponse => ({
	permissions: [permission(id)],
	buffer: [message(id)],
	draft: { hasDraft: false, revision: 0, updatedAt: null },
	hasMore: { permissions: false, buffer: false },
	...overrides,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function callbacks(
	read: (options?: { fresh?: boolean }) => Promise<NarratorPanelStateResponse>,
	fallback?: {
		permissions?: () => Promise<PendingPermission[]>;
		buffer?: () => Promise<BufferMessageSummary[]>;
	},
) {
	let permissions = new Map<string, PendingPermission>();
	let buffer: BufferMessageSummary[] = [];
	let userId = "u1";
	const updates: Array<() => void> = [];
	const generation = { current: 0 };
	const lifecycle = { current: 0 };
	const epoch = { current: 0 };
	const scope = {
		useCallback: <T>(callback: T) => callback,
		activeReconcileRef: { current: null },
		reconcilePanelStateRef: { current: async () => {} },
		requestPanelReconcileRef: { current: () => {} },
		reconcileRestartSchedulerRef: { current: { schedule: () => {}, cancel: () => {} } },
		permissionGenerationRef: generation,
		permissionLifecycleRef: lifecycle,
		bufferEpochRef: epoch,
		resolvedPermissionIdsRef: { current: new Set<string>() },
		bumpPermissionGeneration: () => {
			generation.current++;
		},
		setPendingPermsByRequestId: (
			update: (previous: Map<string, PendingPermission>) => Map<string, PendingPermission>,
		) =>
			updates.push(() => {
				permissions = update(permissions);
			}),
		setQueuedMessages: (update: (previous: BufferMessageSummary[]) => BufferMessageSummary[]) =>
			updates.push(() => {
				buffer = update(buffer);
			}),
		reconcilePendingPermissions,
		upsertPendingPermissionMap,
		reconcilePanelStatePages,
		shouldFallbackPanelState,
		narratorId: "n1",
		token: "test-token",
		getToken: () => "test-token",
		readScope: {},
		currentUser: { id: "u1" },
		qc: { getQueryData: () => ({ id: userId }) },
		api: {
			getNarratorPanelState: (_id: string, options: { fresh?: boolean }) => read(options),
			getPendingPermissions: fallback?.permissions ?? (async () => []),
			getBufferedMessages: fallback?.buffer ?? (async () => []),
		},
		onDraftMetaRef: { current: undefined },
	};
	const factory = new Function(
		...Object.keys(scope),
		`${callbackCode}\nreturn { reconcilePanelState, upsertPendingPermission, removePendingPermission };`,
	);
	const actual = factory(...Object.values(scope)) as {
		reconcilePanelState: (fresh?: boolean) => Promise<void>;
		upsertPendingPermission: (value: PendingPermission) => void;
		removePendingPermission: (id: string) => void;
	};
	return {
		...actual,
		generation,
		lifecycle,
		epoch,
		switchAccount() {
			userId = "u2";
		},
		flush() {
			for (const update of updates.splice(0)) update();
			return { permissions: [...permissions.values()], buffer };
		},
	};
}

describe("shipped panel-state reconcile callbacks", () => {
	test("waiting polling joins the active initial reconcile instead of duplicating HTTP", async () => {
		const pending = deferred<NarratorPanelStateResponse>();
		let reads = 0;
		const state = callbacks(async () => {
			reads++;
			return pending.promise;
		});
		const first = state.reconcilePanelState();
		expect(state.reconcilePanelState()).toBe(first);
		expect(reads).toBe(1);
		pending.resolve(page("p1"));
		await first;
		expect(state.flush().permissions.map((entry) => entry.id)).toEqual(["p1"]);
	});

	test("partial permission pages keep previously visible permissions until the final snapshot", async () => {
		const next = deferred<NarratorPanelStateResponse>();
		let reads = 0;
		const state = callbacks(async () =>
			++reads === 1
				? page("p1", {
						hasMore: { permissions: true, buffer: false },
						nextCursor: { permissions: "next" },
					})
				: next.promise,
		);
		state.upsertPendingPermission(permission("previous"));
		state.flush();
		const reconcile = state.reconcilePanelState();
		await Promise.resolve();
		await Promise.resolve();
		expect(state.flush().permissions.map((entry) => entry.id)).toEqual(["previous", "p1"]);
		next.resolve(page("p2", { buffer: [] }));
		await reconcile;
		expect(state.flush().permissions.map((entry) => entry.id)).toEqual(["p1", "p2"]);
	});

	test("WS permission and buffer epochs reject arriving and already queued old snapshots", async () => {
		for (const beforeResponse of [true, false]) {
			const pending = deferred<NarratorPanelStateResponse>();
			const state = callbacks(() => pending.promise);
			const reconcile = state.reconcilePanelState();
			if (beforeResponse) {
				state.removePendingPermission("old");
				state.epoch.current++;
			}
			pending.resolve(page("old"));
			await reconcile;
			if (!beforeResponse) {
				state.removePendingPermission("old");
				state.epoch.current++;
			}
			expect(state.flush()).toEqual({ permissions: [], buffer: [] });
		}
	});

	test("scope lifecycle or account changes reject a late panel reply", async () => {
		for (const account of [true, false]) {
			const pending = deferred<NarratorPanelStateResponse>();
			const state = callbacks(() => pending.promise);
			const reconcile = state.reconcilePanelState();
			if (account) state.switchAccount();
			else state.lifecycle.current++;
			pending.resolve(page("private"));
			await reconcile;
			expect(state.flush()).toEqual({ permissions: [], buffer: [] });
		}
	});

	test("reconnect fresh supersedes old read while late cleanup preserves the fresh in-flight reconcile", async () => {
		const old = deferred<NarratorPanelStateResponse>();
		const next = deferred<NarratorPanelStateResponse>();
		const options: Array<{ fresh?: boolean } | undefined> = [];
		const state = callbacks((option) => {
			options.push(option);
			return options.length === 1 ? old.promise : next.promise;
		});
		const first = state.reconcilePanelState();
		state.generation.current++;
		state.epoch.current++;
		const fresh = state.reconcilePanelState(true);
		old.resolve(page("old"));
		await first;
		expect(state.reconcilePanelState()).toBe(fresh);
		next.resolve(page("new"));
		await fresh;
		expect(options.map((entry) => entry?.fresh)).toEqual([false, true]);
		expect(state.flush().permissions.map((entry) => entry.id)).toEqual(["new"]);
		expect(state.flush().buffer.map((entry) => entry.id)).toEqual(["new"]);
	});

	test("legacy permission fallback survives an independent buffer failure", async () => {
		const state = callbacks(
			async () => {
				throw { status: 404 };
			},
			{
				permissions: async () => [permission("legacy")],
				buffer: async () => {
					throw new TypeError("offline buffer");
				},
			},
		);
		await state.reconcilePanelState();
		expect(state.flush().permissions.map((entry) => entry.id)).toEqual(["legacy"]);
	});
});
