import { describe, expect, test } from "bun:test";
import type { PendingPermission } from "@frontend/types/narrator";
import {
	reconcilePendingPermissions,
	upsertPendingPermissionMap,
} from "./pending-permissions-reconcile";

// Execute the actual hook callbacks with a deferred state queue. This exercises
// race guards without mocking React or the panel's unrelated WS dependencies.
const hookSource = await Bun.file(new URL("./useNarratorPanelWS.ts", import.meta.url)).text();
const callbackStart = hookSource.indexOf("\tconst upsertPendingPermission = useCallback(");
const callbackEnd = hookSource.indexOf("\n\t// Reset the permission lifecycle", callbackStart);
if (callbackStart < 0 || callbackEnd < 0)
	throw new Error("Permission callback boundaries not found");
const callbackCode = new Bun.Transpiler({ loader: "ts" }).transformSync(
	hookSource.slice(callbackStart, callbackEnd),
);

type PermissionMap = Map<string, PendingPermission>;
function permissionCallbacks(initial: PermissionMap) {
	const generation = { current: 0 };
	const lifecycle = { current: 0 };
	const resolved = { current: new Set<string>() };
	const queue: Array<(previous: PermissionMap) => PermissionMap> = [];
	const scope = {
		useCallback: <T>(callback: T) => callback,
		permissionGenerationRef: generation,
		permissionLifecycleRef: lifecycle,
		resolvedPermissionIdsRef: resolved,
		bumpPermissionGeneration: () => generation.current++,
		setPendingPermsByRequestId: (update: (previous: PermissionMap) => PermissionMap) =>
			queue.push(update),
		reconcilePendingPermissions,
		upsertPendingPermissionMap,
	};
	const factory = new Function(
		...Object.keys(scope),
		`${callbackCode}\nreturn { upsertPendingPermission, removePendingPermission, replacePendingPermissions };`,
	);
	const callbacks = factory(...Object.values(scope)) as {
		upsertPendingPermission: (permission: PendingPermission) => void;
		removePendingPermission: (id: string) => void;
		replacePendingPermissions: (
			permissions: PendingPermission[],
			generation: number,
			lifecycle: number,
		) => boolean;
	};
	let state = initial;
	return {
		...callbacks,
		generation,
		lifecycle,
		resolved,
		flush() {
			for (const update of queue.splice(0)) state = update(state);
			return state;
		},
	};
}

const unresolved = new Set<string>();
const permission = (id = "first"): PendingPermission => ({
	id,
	toolName: "Bash",
	inputJson: { command: "pwd", nested: { values: [1, null, { enabled: true }] } },
	suggestions: [{ type: "allow", scopes: ["session", "project"] }],
});
const mapOf = (...permissions: PendingPermission[]) =>
	new Map(permissions.map((item) => [item.id, item]));

// Covers every current permission field; adding a field requires an explicit case.
const changes = {
	id: "other-id",
	toolName: "Read",
	toolUseId: "tool-2",
	parentToolUseId: "parent-2",
	subagentNarratorId: "child-2",
	ownerNarratorId: "owner-2",
	inputJson: { command: "pwd", nested: { values: [1, null, { enabled: false }] } },
	decisionReason: "needs approval",
	suggestions: [{ type: "allow", scopes: ["session"] }],
	executionDeviceId: "remote-2",
	executionCwd: "/workspace",
	resolvedFilePath: "/workspace/file",
	executionTarget: { deviceId: "local", cwd: "/workspace", runtimeGeneration: 2 },
	executionTargets: [{ deviceId: "remote", cwd: "/workspace", pathFlavor: "posix" }],
	deviceSelectionSource: "explicit",
	suppressNotifications: true,
	reflectionDeadline: 1234,
} satisfies Required<PendingPermission>;

describe("reconcilePendingPermissions", () => {
	test("empty snapshots reuse the empty map", () => {
		const previous = mapOf();
		expect(reconcilePendingPermissions(previous, [], unresolved)).toBe(previous);
	});

	test("deep-equal snapshots reuse the map and entries regardless of object key order", () => {
		const first = permission();
		const second = permission("second");
		const previous = mapOf(first, second);
		const copy = structuredClone(first);
		copy.inputJson = { nested: { values: [1, null, { enabled: true }] }, command: "pwd" };
		const next = reconcilePendingPermissions(previous, [copy, structuredClone(second)], unresolved);
		expect(next).toBe(previous);
		expect(next.get(first.id)).toBe(first);
		expect(next.get(second.id)).toBe(second);
	});

	for (const [field, value] of Object.entries(changes)) {
		test(`updates semantic field ${field} while retaining unchanged entries`, () => {
			const first = permission();
			const second = permission("second");
			const previous = mapOf(first, second);
			const changed = { ...structuredClone(first), [field]: value };
			const next = reconcilePendingPermissions(
				previous,
				[changed, structuredClone(second)],
				unresolved,
			);
			expect(next).not.toBe(previous);
			expect(next.get(changed.id)).toEqual(changed);
			expect(next.get(changed.id)).not.toBe(first);
			expect(next.get(second.id)).toBe(second);
			expect(previous.get(first.id)).toBe(first);
		});
	}

	test("unknown future fields participate without a field allowlist", () => {
		const first = { ...permission(), futureMetadata: { revision: 1 } };
		const previous = mapOf(first);
		const changed = { ...first, futureMetadata: { revision: 2 } };
		const next = reconcilePendingPermissions(previous, [changed], unresolved);
		expect(next).not.toBe(previous);
		expect(next.get(first.id)).toEqual(changed);
	});

	test("preserves equal nested data when only one scalar changes", () => {
		const first = permission();
		const previous = mapOf(first);
		const next = reconcilePendingPermissions(
			previous,
			[{ ...structuredClone(first), decisionReason: "updated" }],
			unresolved,
		);
		expect(next.get(first.id)?.inputJson).toBe(first.inputJson);
		expect(next.get(first.id)?.suggestions).toBe(first.suggestions);
	});

	test("reordering entries changes the map but retains entry identities", () => {
		const first = permission();
		const second = permission("second");
		const previous = mapOf(first, second);
		const next = reconcilePendingPermissions(
			previous,
			[structuredClone(second), first],
			unresolved,
		);
		expect(next).not.toBe(previous);
		expect([...next.keys()]).toEqual([second.id, first.id]);
		expect(next.get(first.id)).toBe(first);
		expect(next.get(second.id)).toBe(second);
		expect([...previous.keys()]).toEqual([first.id, second.id]);
	});

	test("addition, deletion and clearing preserve retained entries without mutating previous", () => {
		const first = permission();
		const second = permission("second");
		const previous = mapOf(first);
		const added = reconcilePendingPermissions(previous, [first, second], unresolved);
		expect([...added.keys()]).toEqual([first.id, second.id]);
		expect(added.get(first.id)).toBe(first);
		const removed = reconcilePendingPermissions(added, [structuredClone(second)], unresolved);
		expect([...removed.keys()]).toEqual([second.id]);
		expect(removed.get(second.id)).toBe(second);
		const cleared = reconcilePendingPermissions(removed, [], unresolved);
		expect(cleared.size).toBe(0);
		expect(reconcilePendingPermissions(cleared, [], unresolved)).toBe(cleared);
		expect(previous.size).toBe(1);
		expect(added.size).toBe(2);
	});

	test("duplicate ids retain first position and last value", () => {
		const first = permission();
		const second = permission("second");
		const previous = mapOf(first, second);
		const changed = { ...first, decisionReason: "new" };
		const next = reconcilePendingPermissions(previous, [first, second, changed], unresolved);
		expect([...next.keys()]).toEqual([first.id, second.id]);
		expect(next.get(first.id)).toEqual(changed);
		expect(reconcilePendingPermissions(previous, [changed, second, first], unresolved)).toBe(
			previous,
		);
	});

	test("resolved ids and finished reflections cannot resurrect permissions", () => {
		const first = permission();
		const previous = mapOf(first);
		const resolved = new Set(["resolved"]);
		const snapshots = [first, permission("resolved")];
		for (const status of ["confirmed", "cancelled", "aborted", "failed", "allow", "deny"]) {
			snapshots.push({
				...permission(status),
				suggestions: [{ type: "danger_reflection", status }],
			});
		}
		expect(reconcilePendingPermissions(previous, snapshots, resolved)).toBe(previous);
		expect(reconcilePendingPermissions(mapOf(), snapshots.slice(1), resolved).size).toBe(0);
	});

	test("active reflection status and nested suggestion changes are retained", () => {
		const first = {
			...permission(),
			suggestions: [{ type: "danger_reflection", status: "running", danger: { level: 1 } }],
		};
		const previous = mapOf(first);
		for (const status of ["running", "awaiting_user"]) {
			const changed = {
				...first,
				suggestions: [{ type: "danger_reflection", status, danger: { level: 2 } }],
			};
			const next = reconcilePendingPermissions(previous, [changed], unresolved);
			expect(next).not.toBe(previous);
			expect(next.get(first.id)).toEqual(changed);
		}
	});

	test("removing optional metadata and clearing reflection deadlines are real changes", () => {
		const first = { ...permission(), reflectionDeadline: 123, decisionReason: "review" };
		const previous = mapOf(first);
		const cleared = { ...first, reflectionDeadline: undefined };
		expect(reconcilePendingPermissions(previous, [cleared], unresolved).get(first.id)).toEqual(
			cleared,
		);
		const removed = permission();
		expect(reconcilePendingPermissions(previous, [removed], unresolved).get(first.id)).toEqual(
			removed,
		);
	});

	test("shared large inputs use reference equality without reading payload contents", () => {
		const inputJson = { content: "x".repeat(1024 * 1024) };
		Object.defineProperty(inputJson, "mustNotRead", {
			enumerable: true,
			get: () => {
				throw new Error("shared input must not be traversed or serialized");
			},
		});
		const first = { ...permission(), inputJson };
		const previous = mapOf(first);
		expect(reconcilePendingPermissions(previous, [{ ...first }], unresolved)).toBe(previous);
	});
});

describe("permission callback race guards", () => {
	test("equal replacement and upsert keep state identity but WS still advances generation", () => {
		const first = permission();
		const previous = mapOf(first);
		const harness = permissionCallbacks(previous);
		expect(harness.replacePendingPermissions([structuredClone(first)], 0, 0)).toBe(true);
		expect(harness.flush()).toBe(previous);
		harness.upsertPendingPermission(structuredClone(first));
		expect(harness.flush()).toBe(previous);
		expect(harness.generation.current).toBe(1);
		expect(harness.replacePendingPermissions([], 0, 0)).toBe(false);
		expect(harness.flush()).toBe(previous);
	});

	test("resolution rejects stale REST snapshots and repeated WS upserts", () => {
		const first = permission();
		const harness = permissionCallbacks(mapOf(first));
		harness.removePendingPermission(first.id);
		expect(harness.replacePendingPermissions([first], 0, 0)).toBe(false);
		harness.upsertPendingPermission(first);
		const empty = harness.flush();
		expect(empty.size).toBe(0);
		expect(harness.replacePendingPermissions([first], harness.generation.current, 0)).toBe(true);
		expect(harness.flush()).toBe(empty);
	});

	test("a WS update invalidates an already queued REST snapshot", () => {
		const first = permission();
		const harness = permissionCallbacks(mapOf(first));
		expect(harness.replacePendingPermissions([permission("stale")], 0, 0)).toBe(true);
		const changed = { ...first, decisionReason: "live" };
		harness.upsertPendingPermission(changed);
		const next = harness.flush();
		expect([...next.keys()]).toEqual([first.id]);
		expect(next.get(first.id)).toEqual(changed);
	});

	test("narrator lifecycle invalidates both arriving and queued snapshots", () => {
		const previous = mapOf(permission());
		const harness = permissionCallbacks(previous);
		expect(harness.replacePendingPermissions([], 0, 0)).toBe(true);
		harness.lifecycle.current++;
		expect(harness.replacePendingPermissions([], 0, 0)).toBe(false);
		expect(harness.flush()).toBe(previous);
	});
});

describe("upsertPendingPermissionMap", () => {
	test("deep-equal upserts reuse the previous map", () => {
		const first = permission();
		const previous = mapOf(first);
		expect(upsertPendingPermissionMap(previous, structuredClone(first))).toBe(previous);
	});

	test("updates retain position and unaffected references; new ids append", () => {
		const first = permission();
		const second = permission("second");
		const previous = mapOf(first, second);
		const changed = { ...first, reflectionDeadline: 456 };
		const next = upsertPendingPermissionMap(previous, changed);
		expect(next).not.toBe(previous);
		expect([...next.keys()]).toEqual([first.id, second.id]);
		expect(next.get(first.id)).toEqual(changed);
		expect(next.get(second.id)).toBe(second);
		const third = permission("third");
		expect([...upsertPendingPermissionMap(next, third).keys()]).toEqual([
			first.id,
			second.id,
			third.id,
		]);
		expect(previous.get(first.id)).toBe(first);
	});
});
