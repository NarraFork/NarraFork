import { describe, expect, test } from "bun:test";
import { parse } from "postcss";
import { GIT_CHANGES_ROW_HEIGHT } from "./git-changes-list-model";

const stylesheet = parse(
	await Bun.file(new URL("./GitChangesTab.module.css", import.meta.url)).text(),
);

describe("Git staging mobile style boundaries", () => {
	test("row and safe-area rules apply independently of reduced-motion preferences", () => {
		for (const selector of [".changesPanel", ".touchAction", ".safeModal", ".modalTitle"]) {
			const rule = stylesheet.nodes.find(
				(node) => node.type === "rule" && node.selector === selector,
			);
			expect(rule?.parent?.type).toBe("root");
		}
	});

	test("the virtual list uses compact 30px rows", () => {
		expect(GIT_CHANGES_ROW_HEIGHT).toBe(30);
	});

	test("compact action controls remain directly visible for every screen and input size", () => {
		const declarations: [string, string][] = [];
		stylesheet.walkDecls((declaration) => {
			declarations.push([declaration.prop, declaration.value]);
		});
		expect(declarations).not.toContainEqual(["display", "none"]);
		expect(declarations).not.toContainEqual(["visibility", "hidden"]);
		expect(declarations).not.toContainEqual(["min-height", "44px"]);
		expect(declarations).not.toContainEqual(["min-width", "44px"]);
	});

	test("the panel and rows remain shrinkable", () => {
		for (const [selector, property, value] of [
			[".changesPanel", "min-width", "0"],
			[".treeRow", "min-width", "0"],
		]) {
			const rule = stylesheet.nodes.find(
				(node) => node.type === "rule" && node.selector === selector,
			);
			if (rule?.type !== "rule") throw new Error(`Missing rule ${selector}`);
			expect(
				rule.nodes.some(
					(node) => node.type === "decl" && node.prop === property && node.value === value,
				),
			).toBe(true);
		}
	});

	test("reduced motion changes only the refresh animation", () => {
		const reduced = stylesheet.nodes.find(
			(node) =>
				node.type === "atrule" &&
				node.name === "media" &&
				node.params.includes("prefers-reduced-motion"),
		);
		if (!reduced || reduced.type !== "atrule")
			throw new Error("Reduced motion media query missing");
		expect(reduced.nodes).toHaveLength(1);
		const rule = reduced.nodes?.[0];
		expect(rule?.type).toBe("rule");
		if (rule?.type !== "rule") throw new Error("Refresh rule missing");
		expect(rule.selector).toBe(".refreshing");
		expect(
			rule.nodes.map((node) => (node.type === "decl" ? [node.prop, node.value] : node.type)),
		).toEqual([["animation", "none"]]);
	});
});
