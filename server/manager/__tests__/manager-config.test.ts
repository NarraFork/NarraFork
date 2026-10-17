/**
 * 管理器的配置读写。
 *
 * 关键是「写入不能破坏其它配置」：settings.json 由 NarraFork 自己维护，面板只被允许改
 * server.host / server.port 两个字段。关闭偏好存在独立的 manager.json，不进 settings。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readNarraForkSettings,
	readPreferences,
	readServerAddress,
	settingsMtime,
	writeNarraForkSettings,
	writePreferences,
	writeServerAddress,
} from "../manager-config";

let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "nf-manager-config-"));
	process.env.NARRAFORK_HOME = home;
});

afterEach(() => {
	delete process.env.NARRAFORK_HOME;
	rmSync(home, { recursive: true, force: true });
});

function writeSettings(value: unknown): void {
	writeFileSync(join(home, "settings.json"), JSON.stringify(value, null, 2), "utf8");
}

describe("监听地址读写", () => {
	test("缺文件时回落到默认值", () => {
		expect(readServerAddress()).toEqual({ host: "127.0.0.1", port: 7779, tls: false });
	});

	test("写入只改 server.host/port，其它配置原样保留", () => {
		writeSettings({
			server: { host: "127.0.0.1", port: 7779, trustProxy: true },
			branding: { iconColor: "#123456" },
			agent: { defaultModel: "x" },
		});

		expect(writeServerAddress({ host: "0.0.0.0", port: 8080 })).toBe(true);

		const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
		expect(saved.server).toEqual({ host: "0.0.0.0", port: 8080, trustProxy: true });
		expect(saved.branding).toEqual({ iconColor: "#123456" });
		expect(saved.agent).toEqual({ defaultModel: "x" });
		expect(readServerAddress()).toEqual({ host: "0.0.0.0", port: 8080, tls: false });
	});

	test("读取 server.tls.enabled", () => {
		writeSettings({ server: { host: "127.0.0.1", port: 7779, tls: { enabled: true } } });
		expect(readServerAddress().tls).toBe(true);
	});

	test("随后写入品牌字段时保留刚保存的监听地址", () => {
		writeSettings({ server: { host: "127.0.0.1", port: 1 }, agent: { keep: true } });
		expect(writeServerAddress({ host: "0.0.0.0", port: 9 })).toBe(true);
		expect(writeNarraForkSettings({ brandName: "Lab" })).toBe(true);
		const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as {
			server: { host: string; port: number };
			branding: { name: string };
			agent: { keep: boolean };
		};
		expect(saved.server.host).toBe("0.0.0.0");
		expect(saved.server.port).toBe(9);
		expect(saved.branding.name).toBe("Lab");
		expect(saved.agent.keep).toBe(true);
	});

	test("写入后 mtime 前进，回显轮询据此发现外部修改", async () => {
		writeSettings({ server: { host: "127.0.0.1", port: 7779 } });
		const before = settingsMtime();
		await Bun.sleep(10);
		writeServerAddress({ host: "127.0.0.1", port: 9000 });
		expect(settingsMtime()).toBeGreaterThan(before);
	});
});

describe("管理器偏好", () => {
	test("缺文件时用默认值（询问、直接退出、中文、显示窗口）", () => {
		expect(readPreferences()).toEqual({
			askOnClose: true,
			closeAction: "exit",
			language: "zh-CN",
			startMinimized: false,
			autoStartBackend: false,
		});
	});

	test("往返写入后读回一致（含语言与最小化启动）", () => {
		const saved = {
			askOnClose: false,
			closeAction: "minimize" as const,
			language: "en" as const,
			startMinimized: true,
			autoStartBackend: true,
		};
		expect(writePreferences(saved)).toBe(true);
		expect(readPreferences()).toEqual(saved);
	});

	test("非法的语言值回落到中文", () => {
		writeFileSync(join(home, "manager.json"), JSON.stringify({ language: "fr" }), "utf8");
		expect(readPreferences().language).toBe("zh-CN");
	});
});

describe("NarraFork 配置同步", () => {
	test("缺文件时用与 nf 一致的默认值", () => {
		expect(readNarraForkSettings()).toEqual({
			openBrowser: "browser",
			brandName: "",
			brandColor: "",
		});
	});

	test("只覆盖关注字段，其余配置原样保留", () => {
		writeSettings({
			server: { host: "127.0.0.1", port: 7779, trustProxy: true },
			branding: { iconColor: "#123456", extra: "keep" },
			agent: { defaultModel: "x" },
		});

		expect(
			writeNarraForkSettings({
				openBrowser: "off",
				brandName: "NF公司",
				brandColor: "#abcdef",
			}),
		).toBe(true);

		const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
		expect(saved.server).toEqual({
			host: "127.0.0.1",
			port: 7779,
			trustProxy: true,
			openBrowser: "off",
		});
		expect(saved.branding).toEqual({ iconColor: "#abcdef", extra: "keep", name: "NF公司" });
		expect(saved.agent).toEqual({ defaultModel: "x" });
		expect(readNarraForkSettings()).toEqual({
			openBrowser: "off",
			brandName: "NF公司",
			brandColor: "#abcdef",
		});
	});

	test("空串表示回到默认（删除对应键）", () => {
		writeSettings({ branding: { name: "NF公司", iconColor: "#123456" } });
		expect(writeNarraForkSettings({ brandName: "", brandColor: "" })).toBe(true);
		const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
		expect(saved.branding).toEqual({});
		expect(readNarraForkSettings()).toEqual({
			openBrowser: "browser",
			brandName: "",
			brandColor: "",
		});
	});

	test("非法的 openBrowser 值回落到默认", () => {
		writeSettings({ server: { openBrowser: "weird" } });
		expect(readNarraForkSettings().openBrowser).toBe("browser");
	});
});
