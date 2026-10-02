import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryHistory } from "@tanstack/react-router";
import enNarrator from "../locales/en/narrator.json";
import en from "../locales/en/publicShare.json";
import zhNarrator from "../locales/zh-CN/narrator.json";
import zh from "../locales/zh-CN/publicShare.json";
import { isPublicNarratorSharePath } from "./app-path-classify";
import { getNamespacesForPath } from "./i18n";

const entrySource = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");

describe("public narrator share entry isolation", () => {
	test("isolates valid and malformed links, not similarly named private routes", () => {
		for (const path of [
			"/shared/narrators",
			"/shared/narrators/",
			"/shared/narrators/example",
			"/shared/narrators/example#token=secret",
			"/shared/narrators/example/unknown",
		])
			expect(isPublicNarratorSharePath(path)).toBe(true);
		for (const path of ["/narrators/example", "/shared/narrators-other", "/login", "/"])
			expect(isPublicNarratorSharePath(path)).toBe(false);
	});
	test("strips only the actual deployment prefix", () => {
		expect(isPublicNarratorSharePath("/nf/shared/narrators/example", "/nf/")).toBe(true);
		expect(isPublicNarratorSharePath("/proxy/7778/shared/narrators/example", "/proxy/7778")).toBe(
			true,
		);
		expect(isPublicNarratorSharePath("/nf-other/shared/narrators/example", "/nf")).toBe(false);
		expect(isPublicNarratorSharePath("/nf/narrators/example", "/nf")).toBe(false);
	});
	test("history covers entering and leaving the isolated surface", () => {
		const history = createMemoryHistory({ initialEntries: ["/nf/login"] });
		const states: boolean[] = [];
		const unsubscribe = history.subscribe(() =>
			states.push(isPublicNarratorSharePath(history.location.pathname, "/nf")),
		);
		history.push("/nf/shared/narrators/a#token=first");
		history.push("/nf/shared/narrators/b#token=second");
		history.push("/nf/login");
		expect(states).toEqual([true, true, false]);
		unsubscribe();
		expect(history.subscribers.size).toBe(0);
	});
	test("root bypass does not depend on whether an existing JWT is valid", () => {
		const root = entrySource("components/AppRootLayout.tsx");
		expect(root).toContain(
			"isLoginPage || isOAuthConsentPage || isPublicNarratorSharePath(location.pathname)",
		);
		expect(root).not.toContain("isPublicNarratorSharePath(location.pathname) && !getToken()");
	});
	test("public bootstrap does not install authenticated hosts", () => {
		const main = entrySource("main.tsx");
		expect(main).toContain("if (!isPublicShare) installHostBridge()");
		expect(main).toContain("if (!isPublicShare) void syncPluginUiContributions()");
		expect(main).toContain("if (!isPublicShare) cleanupStaleNarratorDockLayouts()");
	});
	test("plugin hosts and existing internal notifications stay outside the public branch", () => {
		const app = entrySource("App.tsx");
		expect(app).toContain("React.useSyncExternalStore(");
		expect(app).toContain("history.subscribe(notify)");
		expect(app).toMatch(/isPublicShare \? \(\s*routeContent\s*\) : \(\s*<>\s*<PluginThemeInjector/);
		expect(app).toContain("!isPublicShare && <AppNotifications />");
	});
});

function keys(value: object, prefix = ""): string[] {
	return Object.entries(value)
		.flatMap(([key, child]) => {
			const path = prefix ? `${prefix}.${key}` : key;
			return child && typeof child === "object" ? keys(child, path) : [path];
		})
		.sort();
}

describe("public share wiring guards", () => {
	test("public route uses only its independent namespace bundle", () => {
		expect(getNamespacesForPath("/shared/narrators/id")).toEqual([
			"common",
			"errors",
			"publicShare",
		]);
		expect(getNamespacesForPath("/narrators/id")).toContain("narrator");
	});
	test("public and management copy have matching English and Chinese keys", () => {
		expect(keys(en)).toEqual(keys(zh));
		expect(keys(enNarrator.publicShares)).toEqual(keys(zhNarrator.publicShares));
	});
	test("public module graph contains no private UI, token, file, terminal or auth imports", async () => {
		const paths = [
			"../components/public-share/PublicSharedNarratorPage.tsx",
			"../hooks/usePublicSharedNarrator.ts",
			"./public-share-api.ts",
			"./public-share-session.ts",
			"../routes/shared.narrators.$shareId.tsx",
		];
		for (const path of paths) {
			const source = await readFile(new URL(path, import.meta.url), "utf8");
			const imports = source
				.split("\n")
				.filter((line) => /from ["']/.test(line))
				.join("\n");
			expect(imports).not.toMatch(
				/api\/client|lib\/api["']|useAuth|useChat|NarratorPanel|ChatRoomView|UserAvatar|terminal|query-client|useNarratorPublicShares/,
			);
			expect(source).not.toMatch(
				/api\/client|lib\/api["']|useAuth|useChat|NarratorPanel|ChatRoomView|UserAvatar|terminal|query-client|useNarratorPublicShares/,
			);
		}
	});
});
