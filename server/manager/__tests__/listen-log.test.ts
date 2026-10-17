import { describe, expect, test } from "bun:test";
import { parseServiceLogLine } from "../listen-log";

describe("parseServiceLogLine", () => {
	test("解析启动日志里的地址", () => {
		const line =
			'{"msg":"NarraFork server running on http://127.0.0.1:7779","listenHost":"0.0.0.0"}';
		expect(parseServiceLogLine(line)).toEqual({
			kind: "address",
			protocol: "http",
			host: "127.0.0.1",
			port: 7779,
		});
	});

	test("热重绑使用同一句式，并保留 https 与 IPv6", () => {
		expect(parseServiceLogLine("NarraFork server running on https://[::1]:8443")).toEqual({
			kind: "address",
			protocol: "https",
			host: "[::1]",
			port: 8443,
		});
	});

	test("没有 running on 的行不当成地址", () => {
		expect(parseServiceLogLine('{"msg":"Server listener rebound","port":7780}')).toBeUndefined();
	});

	test("解析实例锁冲突", () => {
		expect(
			parseServiceLogLine(
				"Another NarraFork process (pid 4242) is already using this data directory",
			),
		).toEqual({ kind: "lock", pid: 4242 });
	});
});
