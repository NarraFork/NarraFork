import { describe, expect, it } from "bun:test";
import {
	createNarratorForegroundRecoveryCoalescer,
	decideNarratorForegroundRecovery,
} from "../../frontend/lib/narrator-ws-manager";

describe("narrator foreground recovery", () => {
	it("短时隐藏且连接正常时只执行同步", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 5_000,
				socketState: "open",
				hasPendingReconnect: false,
			}),
		).toBe("sync");
	});

	it("长时隐藏后强制重连，即使旧连接仍显示为打开", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 60_000,
				socketState: "open",
				hasPendingReconnect: true,
			}),
		).toBe("reconnect");
	});

	it("连接缺失且没有有效重连任务时立即重连", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 1_000,
				socketState: "missing",
				hasPendingReconnect: false,
			}),
		).toBe("reconnect");
	});

	it("已有退避重连任务时不绕过定时器", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 1_000,
				socketState: "missing",
				hasPendingReconnect: true,
			}),
		).toBe("none");
	});

	it("连接正在建立时不重复发起连接", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 1_000,
				socketState: "connecting",
				hasPendingReconnect: false,
			}),
		).toBe("none");
	});

	it("连续前台事件只执行一次恢复动作", async () => {
		const coalescer = createNarratorForegroundRecoveryCoalescer(1);
		let recoveryCount = 0;
		expect(coalescer.schedule(() => recoveryCount++)).toBe(true);
		expect(coalescer.schedule(() => recoveryCount++)).toBe(false);
		await Bun.sleep(10);
		expect(recoveryCount).toBe(1);
		coalescer.cancel();
	});
});
