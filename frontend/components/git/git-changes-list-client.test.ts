import { afterEach, describe, expect, test } from "bun:test";
import {
	__setGitChangesWorkerFactory,
	GitChangesListClient,
	type GitChangesWorkerPort,
} from "./git-changes-list-client";
import type { GitChangesListWindow } from "./git-changes-list-model";
import type {
	GitChangesWorkerRequest,
	GitChangesWorkerResponse,
} from "./git-changes-list-worker-protocol";

class Port implements GitChangesWorkerPort {
	onmessage: GitChangesWorkerPort["onmessage"] = null;
	onerror: GitChangesWorkerPort["onerror"] = null;
	requests: GitChangesWorkerRequest[] = [];
	terminated = false;
	postMessage(request: GitChangesWorkerRequest) {
		this.requests.push(request);
	}
	terminate() {
		this.terminated = true;
	}
	emit(data: GitChangesWorkerResponse) {
		this.onmessage?.({ data } as MessageEvent<GitChangesWorkerResponse>);
	}
}
const window: GitChangesListWindow = {
	rows: [],
	start: 0,
	totalRows: 3,
	loadedFiles: 2,
	loadedStaged: 0,
	loadedUnstaged: 2,
	anchorDelta: 0,
};
afterEach(() => __setGitChangesWorkerFactory());

describe("Git changes Worker transport lifecycle", () => {
	test("old generations and out-of-order windows cannot replace the current view", () => {
		const port = new Port();
		__setGitChangesWorkerFactory(() => port);
		const windows: GitChangesListWindow[] = [];
		const client = new GitChangesListClient(
			"current",
			(value) => windows.push(value),
			() => {},
		);
		client.send({ type: "window", start: 0, count: 10 });
		client.send({ type: "window", start: 50, count: 10 });
		port.emit({ id: 50, generation: "old", type: "window", window });
		expect(windows).toHaveLength(0);
		port.emit({ id: 2, generation: "current", type: "window", window: { ...window, start: 50 } });
		port.emit({ id: 1, generation: "current", type: "window", window });
		expect(windows).toHaveLength(1);
		expect(windows[0]?.start).toBe(50);
		client.close();
	});

	test("window callbacks identify the request that acknowledged snapshot and statistics acceptance", () => {
		const port = new Port();
		__setGitChangesWorkerFactory(() => port);
		const accepted: { id: number; value: GitChangesListWindow }[] = [];
		const client = new GitChangesListClient(
			"current",
			(value, id) => accepted.push({ value, id }),
			() => {},
		);
		const resetId = client.send({
			type: "reset",
			config: { mode: "flat", filter: [], expanded: { staged: [], unstaged: [] } },
		});
		const source = { snapshotId: "snapshot", pageGeneration: "current", filterKey: "", epoch: "1" };
		const statsId = client.send({
			type: "page-stats",
			source,
			options: { settled: true, failed: true },
		});
		expect(resetId).toBe(1);
		expect(statsId).toBe(2);
		port.emit({
			id: 1,
			generation: "current",
			type: "window",
			window: { ...window, snapshotId: undefined },
		});
		port.emit({
			id: 2,
			generation: "current",
			type: "window",
			window: {
				...window,
				snapshotId: "snapshot",
				statsSource: source,
				statsReady: true,
				statsFailed: true,
			},
		});
		expect(accepted[0]?.value.snapshotId).toBeUndefined();
		expect(accepted[1]).toMatchObject({
			id: statsId,
			value: { snapshotId: "snapshot", statsReady: true, statsSource: source },
		});
		client.close();
	});

	test("closed Worker callbacks cannot restore a revoked snapshot", () => {
		const port = new Port();
		__setGitChangesWorkerFactory(() => port);
		const accepted: GitChangesListWindow[] = [];
		const client = new GitChangesListClient(
			"current",
			(value) => accepted.push(value),
			() => {},
		);
		const callback = port.onmessage;
		client.close();
		callback?.({
			data: {
				id: 999,
				generation: "current",
				type: "window",
				window: { ...window, snapshotId: "revoked" },
			},
		} as MessageEvent<GitChangesWorkerResponse>);
		expect(accepted).toEqual([]);
		expect(client.send({ type: "window", start: 0, count: 10 })).toBeUndefined();
		expect(port.requests).toHaveLength(0);
	});

	test("close terminates the Worker and rejects outstanding range requests", async () => {
		const port = new Port();
		__setGitChangesWorkerFactory(() => port);
		const client = new GitChangesListClient(
			"workspace",
			() => {},
			() => {},
		);
		const scope = client.scope("unstaged", "src");
		client.close();
		await expect(scope).rejects.toMatchObject({ name: "AbortError" });
		expect(port.terminated).toBe(true);
		expect(port.onmessage).toBeNull();
		await expect(client.scope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
	});

	test("full paths are returned only for explicit action scope requests", async () => {
		const port = new Port();
		__setGitChangesWorkerFactory(() => port);
		const client = new GitChangesListClient(
			"workspace",
			() => {},
			() => {},
		);
		client.send({ type: "window", start: 40, count: 20 });
		expect(port.requests[0]?.type).toBe("window");
		const promise = client.scope("staged", "src");
		const request = port.requests[1];
		expect(request?.type).toBe("scope");
		port.emit({
			id: request.id,
			generation: "workspace",
			type: "scope",
			paths: ["src/one", "src/two"],
		});
		expect(await promise).toEqual(["src/one", "src/two"]);
		client.close();
	});
});
