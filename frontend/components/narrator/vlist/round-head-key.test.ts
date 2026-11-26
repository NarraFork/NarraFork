/**
 * round-head-key.test.ts — 轮首 key → messageId 的还原。
 *
 * 这几条用例都是从真实会话里抄下来的 key。它们的存在意义很直接：后端轮次索引
 * 按 messageId 给时长与 token，还原错了折叠条就只剩「已处理」——前后踩过两次，
 * 一次是只认 `-bubble`（子代理全失效），一次是没剥 activity 前缀（时长没了）。
 */

import { describe, expect, it } from "bun:test";
import { roundHeadMessageId } from "./round-head-key";

describe("roundHeadMessageId", () => {
	it("主会话的用户气泡", () => {
		expect(roundHeadMessageId("abc123-bubble")).toBe("abc123");
	});

	it("子代理的老式 Send 行（来源卡）", () => {
		expect(roundHeadMessageId("abc123-origin")).toBe("abc123");
	});

	it("子代理的注入气泡（块定位 + 形态后缀）", () => {
		expect(roundHeadMessageId("abc123-blk[b1]-m-legacy")).toBe("abc123");
	});

	it("块定位带偏移（同一块的第二个元素）", () => {
		expect(roundHeadMessageId("abc123-blk[b1]+1")).toBe("abc123");
	});

	it("⚠️ activity 单元里的辅助内容行（真实数据里轮首就是这个形态）", () => {
		expect(
			roundHeadMessageId("activity-a:auxiliary-sx-zNAJqES7GvU0v8F4ND-blk[_Qtj7Gl]-m-legacy"),
		).toBe("sx-zNAJqES7GvU0v8F4ND");
	});

	it("⚠️ 裸露的 auxiliary- 前缀（实测子代理轮首就是这个 key）", () => {
		// 浏览器里取到的真实值：轮首 spec 被投影成 auxiliary-content，key 没有
		// `activity-a:` 前缀，但 `auxiliaryContentKey` 自己带 `auxiliary-`。
		expect(roundHeadMessageId("auxiliary-sx-zNAJqES7GvU0v8F4ND-blk[_Qtj7Gl6MzfLEGon1oFxV]+1")).toBe(
			"sx-zNAJqES7GvU0v8F4ND",
		);
	});

	it("activity 前缀 + 块定位 + 偏移", () => {
		expect(roundHeadMessageId("activity-a:auxiliary-m1-blk[b2]+1")).toBe("m1");
	});

	it("activity 单元里的普通 segment 行", () => {
		expect(roundHeadMessageId("activity-a:segment-m2")).toBe("m2");
	});

	it("工具行不是轮首 → null（不会拿 toolUseId 去查轮次）", () => {
		expect(roundHeadMessageId("activity-t:call_00_abc")).toBeNull();
	});

	it("裸露的 messageId 原样返回", () => {
		expect(roundHeadMessageId("plainId")).toBe("plainId");
	});

	it("空 / 非字符串 → null", () => {
		expect(roundHeadMessageId("")).toBeNull();
		expect(roundHeadMessageId(undefined)).toBeNull();
		expect(roundHeadMessageId(42)).toBeNull();
	});

	it("剥离后为空 → null（不返回空串去查表）", () => {
		expect(roundHeadMessageId("-bubble")).toBeNull();
	});
});
