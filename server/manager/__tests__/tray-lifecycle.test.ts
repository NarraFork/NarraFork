import { describe, expect, test } from "bun:test";
import { TrayLifecycle } from "../tray-lifecycle";

function fixture() {
	let canAdd = true;
	let adds = 0;
	let removes = 0;
	let shown = 0;
	const tray = new TrayLifecycle({
		add: () => {
			adds++;
			return canAdd;
		},
		remove: () => {
			removes++;
		},
		onUnavailable: () => {
			shown++;
		},
	});
	return {
		tray,
		fail: () => {
			canAdd = false;
		},
		get counts() {
			return { adds, removes, shown };
		},
	};
}

describe("manager tray lifecycle", () => {
	test("每次任务栏重建都重新注册图标", () => {
		const f = fixture();
		f.tray.restore();
		f.tray.restore();
		f.tray.restore();
		expect(f.counts).toEqual({ adds: 3, removes: 0, shown: 0 });
		expect(f.tray.added).toBe(true);
	});

	test("重建失败清除过期 added 并显示管理器", () => {
		const f = fixture();
		f.tray.restore();
		f.fail();
		f.tray.restore();
		expect(f.tray.added).toBe(false);
		expect(f.counts.shown).toBe(1);
	});

	test("退出/交接后迟到的任务栏广播不能复活图标", () => {
		const f = fixture();
		f.tray.restore();
		f.tray.dispose();
		f.tray.restore();
		f.tray.dispose();
		expect(f.counts).toEqual({ adds: 1, removes: 1, shown: 0 });
		expect(f.tray.added).toBe(false);
	});

	test("从未添加成功的图标无需删除", () => {
		const f = fixture();
		f.fail();
		f.tray.restore();
		f.tray.dispose();
		expect(f.counts).toEqual({ adds: 1, removes: 0, shown: 1 });
	});
});
