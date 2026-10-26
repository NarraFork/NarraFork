import { describe, expect, test } from "bun:test";
import { ServiceHealthMonitor } from "../service-health-monitor";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture(probe: () => Promise<boolean> = async () => false) {
	let active = true;
	let lost = 0;
	const monitor = new ServiceHealthMonitor({
		isActive: () => active,
		probe,
		onLost: () => {
			lost++;
			active = false;
		},
	});
	return {
		monitor,
		deactivate: () => {
			active = false;
		},
		get lost() {
			return lost;
		},
	};
}

describe("adopted service health", () => {
	test("连续三次失败才恢复操作入口，不因单次抖动判停", async () => {
		const f = fixture();
		await f.monitor.check();
		await f.monitor.check();
		expect(f.lost).toBe(0);
		await f.monitor.check();
		expect(f.lost).toBe(1);
		await f.monitor.check();
		expect(f.lost).toBe(1);
	});

	test("成功探测重置失败计数", async () => {
		const responses = [false, false, true, false, false, false];
		const f = fixture(async () => responses.shift() ?? false);
		for (let i = 0; i < 5; i++) await f.monitor.check();
		expect(f.lost).toBe(0);
		await f.monitor.check();
		expect(f.lost).toBe(1);
	});

	test("定时回调不能重叠执行探测", async () => {
		const response = deferred<boolean>();
		let calls = 0;
		const f = fixture(() => {
			calls++;
			return response.promise;
		});
		const first = f.monitor.check();
		await f.monitor.check();
		await f.monitor.check();
		expect(calls).toBe(1);
		response.resolve(true);
		await first;
	});

	test("停止或重新认领后，迟到失败不污染新轮次", async () => {
		const response = deferred<boolean>();
		let calls = 0;
		const f = fixture(async () => (++calls === 3 ? response.promise : false));
		await f.monitor.check();
		await f.monitor.check();
		const pending = f.monitor.check();
		f.monitor.reset();
		response.resolve(false);
		await pending;
		expect(f.lost).toBe(0);
		await f.monitor.check();
		await f.monitor.check();
		expect(f.lost).toBe(0);
	});

	test("离开 adopted 状态后忽略迟到的响应", async () => {
		const response = deferred<boolean>();
		const f = fixture(() => response.promise);
		const pending = f.monitor.check();
		f.deactivate();
		response.resolve(false);
		await pending;
		await f.monitor.check();
		expect(f.lost).toBe(0);
	});

	test("探测抛错等同失败且不产生未处理拒绝", async () => {
		const f = fixture(async () => {
			throw new Error("connection refused");
		});
		await f.monitor.check();
		await f.monitor.check();
		await f.monitor.check();
		expect(f.lost).toBe(1);
	});
});
