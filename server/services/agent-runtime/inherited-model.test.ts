import { describe, expect, mock, test } from "bun:test";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import type { ActiveNarrator } from "../narrator-session-state";
import {
	createInheritedModelRuntime,
	type InheritedModelNarrator,
	type InheritedModelResolution,
} from "./inherited-model";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function fixture() {
	const active = {
		narratorId: "child",
		alive: true,
		model: "provider:old",
		provider: "provider",
		_modelRef: "provider:old",
		_currentUserId: "frozen-principal",
		abortController: new AbortController(),
		_modelUnavailableWaitCancel: mock(() => {}),
	} as unknown as ActiveNarrator;
	const sessions = new Map([[active.narratorId, active]]);
	const childRow = {
		model: FOLLOW_PARENT_MODEL,
		parentNarratorId: "parent",
		subagentType: "general",
	};
	const rows = new Map<string, InheritedModelNarrator>([["child", childRow]]);
	const resolutions: ReturnType<typeof deferred<InheritedModelResolution>>[] = [];
	const resolve = mock(() => {
		const job = deferred<InheritedModelResolution>();
		resolutions.push(job);
		return job.promise;
	});
	const readNarrator = mock(async (id: string) => {
		const row = rows.get(id);
		return row ? { ...row } : undefined;
	});
	const applied: InheritedModelResolution[] = [];
	const reportError = mock(() => {});
	const runtime = createInheritedModelRuntime({
		getActive: (id) => sessions.get(id),
		activeValues: () => sessions.values(),
		readNarrator,
		resolve,
		apply: (target, result) => {
			applied.push(result);
			target.model = result.model;
			target._modelRef = result.modelRef;
		},
		reportError,
	});
	runtime.select(active, FOLLOW_PARENT_MODEL, "parent");
	return {
		active,
		sessions,
		rows,
		childRow,
		resolutions,
		resolve,
		readNarrator,
		applied,
		reportError,
		runtime,
	};
}

const selected = (model: string, modelRef = model): InheritedModelResolution => ({
	model,
	modelRef,
});

describe("inherited runtime model refresh", () => {
	test("preserves the raw follower selection and pool-approved default/aggregation reference", async () => {
		for (const ref of ["__default__", "__agg__:allowed"]) {
			const f = fixture();
			f.runtime.refresh(f.active);
			await Promise.resolve();
			expect(f.resolve).toHaveBeenCalledWith(f.rows.get("child"), "frozen-principal", "provider");
			f.resolutions[0].resolve(selected("provider:allowed", ref));
			await f.runtime.settle(f.active);
			expect(f.active.model).toBe("provider:allowed");
			expect(f.active._modelRef).toBe(ref);
			expect(f.active._modelSelectionRef).toBe(FOLLOW_PARENT_MODEL);
			expect(f.rows.get("child")?.model).toBe(FOLLOW_PARENT_MODEL);
			expect(f.active._modelUnavailableWaitCancel).toHaveBeenCalledTimes(1);
			expect(f.active.abortController.signal.aborted).toBe(false);
		}
	});

	test("parent updates only resolve active followers, including nested followers", async () => {
		const f = fixture();
		for (const [id, parentId, ref] of [
			["grandchild", "child", FOLLOW_PARENT_MODEL],
			["unrelated", "other", FOLLOW_PARENT_MODEL],
			["pinned", "parent", "provider:pinned"],
			["dead", "parent", FOLLOW_PARENT_MODEL],
		]) {
			const active = { ...f.active, narratorId: id, alive: id !== "dead" };
			f.runtime.select(active, ref, parentId);
			f.sessions.set(id, active);
			f.rows.set(id, { model: ref, parentNarratorId: parentId });
		}
		f.rows.set("historical", { model: FOLLOW_PARENT_MODEL, parentNarratorId: "parent" });
		f.runtime.parentChanged("parent");
		await Promise.resolve();
		expect(f.readNarrator.mock.calls.map(([id]) => id)).toEqual(["child", "grandchild"]);
		expect(f.resolve).toHaveBeenCalledTimes(2);
		for (const pending of f.resolutions) pending.resolve(selected("provider:next"));
		await Promise.all([...f.sessions.values()].map((active) => f.runtime.settle(active)));
		expect(f.applied).toHaveLength(2);
	});

	test("a later parent update wins even when the first resolution completes last", async () => {
		const f = fixture();
		f.runtime.parentChanged("parent");
		await Promise.resolve();
		const oldPending = f.active._modelRefreshPending;
		f.runtime.parentChanged("parent");
		await Promise.resolve();
		f.resolutions[1].resolve(selected("provider:latest"));
		await f.runtime.settle(f.active);
		f.resolutions[0].resolve(selected("provider:stale"));
		await oldPending;
		expect(f.active.model).toBe("provider:latest");
		expect(f.applied).toHaveLength(1);
	});

	test("a request boundary waits for the replacement generation too", async () => {
		const f = fixture();
		f.runtime.refresh(f.active);
		await Promise.resolve();
		let settled = false;
		const boundary = f.runtime.settle(f.active).then(() => {
			settled = true;
		});
		f.runtime.parentChanged("parent");
		await Promise.resolve();
		f.resolutions[0].resolve(selected("provider:stale"));
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		f.resolutions[1].resolve(selected("provider:latest"));
		await boundary;
		expect(f.active.model).toBe("provider:latest");
	});

	test("manual pinning invalidates pending inheritance without aborting a request", async () => {
		const f = fixture();
		f.runtime.refresh(f.active);
		await Promise.resolve();
		const pending = f.active._modelRefreshPending;
		f.childRow.model = "provider:manual";
		f.runtime.select(f.active, "provider:manual");
		f.active.model = "provider:manual";
		f.resolutions[0].resolve(selected("provider:obsolete"));
		await pending;
		expect(f.active.model).toBe("provider:manual");
		expect(f.active._followParentNarratorId).toBeUndefined();
		expect(f.applied).toHaveLength(0);
		expect(f.active.abortController.signal.aborted).toBe(false);
	});

	test("DB selection changes are rejected even before their notification arrives", async () => {
		const f = fixture();
		f.runtime.refresh(f.active);
		await Promise.resolve();
		f.childRow.model = "provider:manual";
		f.resolutions[0].resolve(selected("provider:obsolete"));
		await expect(f.runtime.settle(f.active)).rejects.toThrow("selection changed during");
		expect(f.applied).toHaveLength(0);
	});

	test("permission failures fail closed once, then a later boundary can recover", async () => {
		const f = fixture();
		f.runtime.refresh(f.active);
		await Promise.resolve();
		f.resolutions[0].reject(new Error("pool policy denied"));
		await expect(f.runtime.settle(f.active)).rejects.toThrow("pool policy denied");
		expect(f.active.model).toBe("provider:old");
		expect(f.active._modelUnavailableWaitCancel).toHaveBeenCalledTimes(1);
		expect(f.active.abortController.signal.aborted).toBe(false);
		// Fail-closed is one-shot: the error must not stick and block every later boundary.
		await f.runtime.settle(f.active);
		f.runtime.refresh(f.active);
		await Promise.resolve();
		f.resolutions[1].resolve(selected("provider:recovered"));
		await f.runtime.settle(f.active);
		expect(f.active.model).toBe("provider:recovered");
		expect(f.applied).toHaveLength(1);
	});

	test("obsolete failures cannot poison a newer successful parent resolution", async () => {
		const f = fixture();
		f.runtime.refresh(f.active);
		await Promise.resolve();
		const oldPending = f.active._modelRefreshPending;
		f.runtime.parentChanged("parent");
		await Promise.resolve();
		f.resolutions[1].resolve(selected("provider:latest"));
		await f.runtime.settle(f.active);
		f.resolutions[0].reject(new Error("obsolete policy failure"));
		await oldPending;
		await f.runtime.settle(f.active);
		expect(f.reportError).not.toHaveBeenCalled();
	});

	test("a replaced active session is never mutated by an earlier resolution", async () => {
		const f = fixture();
		f.runtime.refresh(f.active);
		await Promise.resolve();
		f.sessions.set("child", { ...f.active });
		f.resolutions[0].resolve(selected("provider:obsolete"));
		await f.runtime.settle(f.active);
		expect(f.applied).toHaveLength(0);
	});

	test("the parent sentinel cannot become a provider model or runtime ref", async () => {
		for (const result of [
			selected(FOLLOW_PARENT_MODEL),
			selected("provider:model", FOLLOW_PARENT_MODEL),
		]) {
			const f = fixture();
			f.runtime.refresh(f.active);
			await Promise.resolve();
			f.resolutions[0].resolve(result);
			await expect(f.runtime.settle(f.active)).rejects.toThrow("unresolved parent reference");
			expect(f.applied).toHaveLength(0);
		}
	});

	test("temporary pin and restoration rejoin inheritance without stale writes", async () => {
		const f = fixture();
		const restoreRef = f.childRow.model;
		f.childRow.model = "provider:temporary";
		f.runtime.select(f.active, "provider:temporary");
		f.runtime.parentChanged("parent");
		expect(f.resolve).not.toHaveBeenCalled();
		f.childRow.model = restoreRef;
		f.runtime.select(f.active, restoreRef);
		f.runtime.refresh(f.active);
		await Promise.resolve();
		f.resolutions[0].resolve(selected("provider:new-parent"));
		await f.runtime.settle(f.active);
		expect(f.active.model).toBe("provider:new-parent");
		expect(f.active._modelSelectionRef).toBe(FOLLOW_PARENT_MODEL);
	});
});
