/** 三方合并（§6.5）、排序键、diff 的单元测试（不依赖 DOM 和 Yjs）。 */
import { describe, expect, test } from "bun:test";
import { applyHunks, diffHunks, hunksToDelta, mapOffset, simpleDiff } from "../src/model/diff";
import { merge3 } from "../src/model/merge3";
import { keyBetween, keysBetween } from "../src/model/orderkey";
import { rng } from "./fuzz-util";

describe("三方合并", () => {
	test("和读取之后别人的修改不重叠就合并", () => {
		const r = merge3("我们今天讨论设计", "我们今天讨论编辑器设计", "我们明天讨论设计");
		expect(r.ok && r.result).toBe("我们明天讨论编辑器设计");
	});
	test("重叠就拒绝并返回当前内容", () => {
		const r = merge3("hello world", "hello there", "hello earth");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.current).toBe("hello earth");
	});
	test("同一位置的两个插入算重叠", () => {
		expect(merge3("ab", "aXb", "aYb").ok).toBe(false);
	});
	test("相邻但不相交的修改可以合并", () => {
		const r = merge3("one two three", "one 2 three", "one two 3");
		expect(r.ok && r.result).toBe("one 2 3");
	});
	test("补丁应用到 theirs 得到结果", () => {
		const base = "块模型是真相，编辑器文档只是投影。";
		const mine = "块模型是唯一真相，编辑器文档只是投影。";
		const theirs = "块模型是真相，编辑器文档只是投影。参见 §6.7";
		const r = merge3(base, mine, theirs);
		expect(r.ok).toBe(true);
		if (r.ok) expect(applyHunks(theirs, r.patch)).toBe(r.result);
	});
});

describe("排序键", () => {
	test("严格位于两者之间", () => {
		const r = rng(1);
		let keys = [keyBetween(null, null)];
		for (let i = 0; i < 2000; i++) {
			const at = Math.floor(r() * (keys.length + 1));
			const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
			if (at > 0) expect(k > keys[at - 1]).toBe(true);
			if (at < keys.length) expect(k < keys[at]).toBe(true);
			keys = [...keys.slice(0, at), k, ...keys.slice(at)];
		}
		expect(keysBetween("V", "k", 5)).toHaveLength(5);
	});
});

describe("diff 与偏移映射", () => {
	test("diffHunks 应用后得到目标", () => {
		const r = rng(3);
		const alpha = "ab 块中文，x";
		for (let i = 0; i < 500; i++) {
			const a = Array.from(
				{ length: Math.floor(r() * 30) },
				() => alpha[Math.floor(r() * alpha.length)],
			).join("");
			const b = Array.from(
				{ length: Math.floor(r() * 30) },
				() => alpha[Math.floor(r() * alpha.length)],
			).join("");
			expect(applyHunks(a, diffHunks(a, b))).toBe(b);
		}
	});
	test("mapOffset 经过插入和删除", () => {
		const h = simpleDiff("hello world", "hello brave world");
		const d = hunksToDelta(h ? [h] : []);
		expect(mapOffset(d, 8)).toBe(14);
		expect(mapOffset(d, 2)).toBe(2);
	});
});
