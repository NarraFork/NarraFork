import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
	drainCommunicationWork,
	getCommunicationWorkStatus,
} from "../../../agent-runtime/async-work";
import { outlineStore, setOutlineStore } from "../../store";
import type { OutlineLiveUpdateRow } from "../../store/port";
import {
	OUTLINE_LIVE_REPLAY,
	replayAllLiveEpochs,
	replayLiveEpoch,
	stopOutlineLiveReplay,
} from "../replay";

afterEach(() => setOutlineStore(undefined));

test("isolated cancellation stops its replay while default startup admission remains available", async () => {
	const controller = new AbortController();
	const list = mock(async () => [{ pageBlockId: "page", epoch: 1 }]);
	const replay = mock(async () => "empty" as const);
	setOutlineStore({ ...outlineStore, listLiveEpochs: list });
	stopOutlineLiveReplay(controller);
	expect(await replayAllLiveEpochs(() => false, replay, controller.signal)).toEqual({
		committed: 0,
		kept: 0,
	});
	expect(list).not.toHaveBeenCalled();
	expect(replay).not.toHaveBeenCalled();
	expect(await replayAllLiveEpochs(() => false, replay)).toEqual({ committed: 0, kept: 0 });
	expect(list).toHaveBeenCalledTimes(1);
	expect(replay).toHaveBeenCalledTimes(1);
});

test("cancellation keeps an in-flight epoch listing owned until its real completion", async () => {
	const controller = new AbortController();
	const listed = Promise.withResolvers<Array<{ pageBlockId: string; epoch: number }>>();
	const list = mock(async () => listed.promise);
	const replay = mock(async () => "empty" as const);
	setOutlineStore({ ...outlineStore, listLiveEpochs: list });
	const before = getCommunicationWorkStatus().pending;
	const work = replayAllLiveEpochs(() => false, replay, controller.signal);
	try {
		controller.abort();
		expect(getCommunicationWorkStatus().pending).toBe(before + 1);
		await expect(drainCommunicationWork({ deadlineAt: Date.now() })).rejects.toThrow(
			"Communication database tails did not drain",
		);
		listed.resolve(
			Array.from({ length: OUTLINE_LIVE_REPLAY.epochsPerPage }, (_, epoch) => ({
				pageBlockId: "page",
				epoch,
			})),
		);
		expect(await work).toEqual({ committed: 0, kept: 0 });
		expect(list).toHaveBeenCalledTimes(1);
		expect(replay).not.toHaveBeenCalled();
		expect(getCommunicationWorkStatus().pending).toBe(before);
	} finally {
		controller.abort();
		listed.resolve([]);
		await work;
	}
});

test("cancellation waits for the active replay callback and admits no later epoch", async () => {
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const replay = mock(async () => {
		entered.resolve();
		await release.promise;
		return "committed" as const;
	});
	setOutlineStore({
		...outlineStore,
		listLiveEpochs: async () => [
			{ pageBlockId: "page", epoch: 1 },
			{ pageBlockId: "page", epoch: 2 },
		],
	});
	let settled = false;
	const work = replayAllLiveEpochs(() => false, replay, controller.signal);
	void work.then(() => {
		settled = true;
	});
	try {
		await entered.promise;
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		release.resolve();
		expect(await work).toEqual({ committed: 1, kept: 0 });
		expect(replay).toHaveBeenCalledTimes(1);
	} finally {
		controller.abort();
		release.resolve();
		await work;
	}
});

test("cancellation interrupts the between-epoch pause and clears its timer", async () => {
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const replay = mock(async () => {
		entered.resolve();
		return "empty" as const;
	});
	setOutlineStore({
		...outlineStore,
		listLiveEpochs: async () => [
			{ pageBlockId: "page", epoch: 1 },
			{ pageBlockId: "page", epoch: 2 },
		],
	});
	const timers = spyOn(globalThis, "setTimeout");
	const cleared = spyOn(globalThis, "clearTimeout");
	const work = replayAllLiveEpochs(() => false, replay, controller.signal);
	try {
		await entered.promise;
		await Promise.resolve();
		expect(timers).toHaveBeenCalledWith(expect.any(Function), OUTLINE_LIVE_REPLAY.pauseMs);
		const pauseTimer = timers.mock.results.at(-1)?.value;
		controller.abort();
		await work;
		expect(cleared).toHaveBeenCalledWith(pauseTimer);
		expect(replay).toHaveBeenCalledTimes(1);
	} finally {
		controller.abort();
		await work;
		timers.mockRestore();
		cleared.mockRestore();
	}
});

test("cancelling an epoch read leaves its log and later database writes untouched", async () => {
	const controller = new AbortController();
	const rows = Promise.withResolvers<OutlineLiveUpdateRow[]>();
	const list = mock(async () => rows.promise);
	const getBlock = mock(async () => null);
	const remove = mock(async () => 0);
	setOutlineStore({ ...outlineStore, listLiveUpdates: list, getBlock, deleteLiveUpdates: remove });
	const work = replayLiveEpoch("page", 1, controller.signal);
	let error: unknown;
	const settled = work.catch((caught: unknown) => {
		error = caught;
	});
	try {
		controller.abort(new Error("stop epoch read"));
		rows.resolve([]);
		await settled;
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "stop epoch read" });
		expect(list).toHaveBeenCalledTimes(1);
		expect(getBlock).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	} finally {
		controller.abort();
		rows.resolve([]);
		await settled;
	}
});
