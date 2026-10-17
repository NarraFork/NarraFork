import { describe, expect, test } from "bun:test";
import { isManagerTokenAuthorized } from "../manager-token";

const TOKEN = "manager-token-value";

describe("isManagerTokenAuthorized", () => {
	test("回环对端加上正确令牌才放行", () => {
		expect(
			isManagerTokenAuthorized({
				peerIp: "127.0.0.1",
				authorization: `Bearer ${TOKEN}`,
				expectedToken: TOKEN,
			}),
		).toBe(true);
	});

	test("IPv4 映射的回环地址同样放行", () => {
		expect(
			isManagerTokenAuthorized({
				peerIp: "::ffff:127.0.0.1",
				authorization: `Bearer ${TOKEN}`,
				expectedToken: TOKEN,
			}),
		).toBe(true);
	});

	test("公网对端即使持有令牌也拒绝", () => {
		expect(
			isManagerTokenAuthorized({
				peerIp: "203.0.113.5",
				authorization: `Bearer ${TOKEN}`,
				expectedToken: TOKEN,
			}),
		).toBe(false);
	});

	test("回环但没有令牌拒绝", () => {
		expect(
			isManagerTokenAuthorized({
				peerIp: "127.0.0.1",
				authorization: undefined,
				expectedToken: TOKEN,
			}),
		).toBe(false);
	});

	test("服务没有配置令牌时拒绝", () => {
		expect(
			isManagerTokenAuthorized({
				peerIp: "127.0.0.1",
				authorization: `Bearer ${TOKEN}`,
				expectedToken: undefined,
			}),
		).toBe(false);
	});

	test("令牌不一致拒绝", () => {
		expect(
			isManagerTokenAuthorized({
				peerIp: "::1",
				authorization: "Bearer other-token",
				expectedToken: TOKEN,
			}),
		).toBe(false);
	});
});
