import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
	__resetGitStagingFolderPrefsCache,
	GIT_STAGING_FOLDER_PREFS_KEY,
	useGitStagingFolderPrefs,
} from "./useGitStagingFolderPrefs";

const scopeA = JSON.stringify(["narrator-a", "workspace-a", "user-a"]);
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let storage: Map<string, string>;
let readBlocked: boolean;
let writeBlocked: boolean;
let latest: Record<string, ReturnType<typeof useGitStagingFolderPrefs>>;
function Probe({ scope, name }: { scope: string; name: string }) {
	const prefs = useGitStagingFolderPrefs(scope);
	latest[name] = prefs;
	return <output data-probe={name}>{JSON.stringify([prefs.groups, prefs.folders])}</output>;
}
async function render(scopes = [scopeA]) {
	await act(async () => {
		root.render(
			<>
				{scopes[0] !== undefined && <Probe name="0" scope={scopes[0]} />}
				{scopes[1] !== undefined && <Probe name="1" scope={scopes[1]} />}
			</>,
		);
	});
}
async function update(action: () => void) {
	await act(async () => action());
}
function saved() {
	return JSON.parse(storage.get(GIT_STAGING_FOLDER_PREFS_KEY) ?? "{}");
}
beforeEach(() => {
	__resetGitStagingFolderPrefsCache();
	latest = {};
	storage = new Map();
	readBlocked = false;
	writeBlocked = false;
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const sessionStorage = {
		getItem: (key: string) => {
			if (readBlocked) throw new Error("Storage access denied");
			return storage.get(key) ?? null;
		},
		setItem: (key: string, value: string) => {
			if (writeBlocked) throw new DOMException("Storage is full", "QuotaExceededError");
			storage.set(key, value);
		},
	};
	Object.assign(window, { sessionStorage });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(window.document.getElementById("root") as HTMLElement);
});
afterEach(async () => {
	await act(async () => root.unmount());
	__resetGitStagingFolderPrefsCache();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

test("starts collapsed and returns stable expansion references on unchanged renders", async () => {
	await render();
	const first = latest[0];
	expect(first.groups).toEqual([]);
	expect(first.folders).toEqual({});
	await render();
	expect(latest[0].groups).toBe(first.groups);
	expect(latest[0].folders).toBe(first.folders);
	expect(storage.size).toBe(0);
});

test("same-scope readers immediately share atomic group and folder updates", async () => {
	await render([scopeA, scopeA]);
	await update(() => {
		latest[0].toggleGroup("A");
		latest[1].toggleGroup("B");
		latest[0].toggleFolder("A", "src/lib");
	});
	expect(latest[0].groups).toEqual(["A", "B"]);
	expect(latest[1].groups).toBe(latest[0].groups);
	expect(latest[1].folders).toBe(latest[0].folders);
	expect(latest[1].folders.A).toEqual(["src/lib", "src"]);
	expect(document.querySelectorAll("output")[0].textContent).toBe(
		document.querySelectorAll("output")[1].textContent,
	);
});

test.each([
	["narrator-b", "workspace-a", "user-a"],
	["narrator-a", "workspace-b", "user-a"],
	["narrator-a", "workspace-a", "user-b"],
])("scope A/B/A restores independent state for %j", async (...identity) => {
	const scopeB = JSON.stringify(identity);
	await render();
	await update(() => {
		latest[0].toggleGroup("same-list");
		latest[0].toggleFolder("same-list", "src");
	});
	await render([scopeB]);
	expect(latest[0].groups).toEqual([]);
	expect(latest[0].folders).toEqual({});
	await update(() => latest[0].toggleFolder("same-list", "tests"));
	await render([scopeA]);
	expect(latest[0].groups).toEqual(["same-list"]);
	expect(latest[0].folders["same-list"]).toEqual(["src"]);
	await render([scopeB]);
	expect(latest[0].groups).toEqual([]);
	expect(latest[0].folders["same-list"]).toEqual(["tests"]);
});

test("folders are list-local and closing a group preserves its folder choices", async () => {
	await render();
	await update(() => {
		latest[0].toggleGroup("A");
		latest[0].toggleFolder("A", "src");
		latest[0].toggleFolder("B", "tests");
		latest[0].toggleGroup("A");
	});
	expect(latest[0].groups).toEqual([]);
	expect(latest[0].folders).toEqual({ A: ["src"], B: ["tests"] });
	await update(() => latest[0].toggleGroup("A"));
	expect(latest[0].folders.A).toEqual(["src"]);
});

test("compact folders open ancestors, while collapse removes only that subtree", async () => {
	storage.set(
		GIT_STAGING_FOLDER_PREFS_KEY,
		JSON.stringify({ [scopeA]: { groups: ["A"], folders: { A: ["src/lib/deep", "tests"] } } }),
	);
	await render();
	await update(() => latest[0].toggleFolder("A", "src/lib"));
	expect(latest[0].folders.A).toEqual(["src", "tests"]);
	await update(() => latest[0].toggleFolder("A", "src"));
	expect(latest[0].folders.A).toEqual(["tests"]);
	await render([]);
	__resetGitStagingFolderPrefsCache();
	await render();
	expect(latest[0].folders.A).toEqual(["tests"]);
	await update(() => latest[0].toggleFolder("A", "src/new"));
	expect(latest[0].folders.A).toEqual(["tests", "src/new", "src"]);
});

test("unmount and page-cache reset restore the session document using a dedicated key", async () => {
	storage.set("narrafork_git_expanded_folders", "ordinary-git-preferences");
	await render();
	await update(() => {
		latest[0].toggleGroup("A");
		latest[0].toggleFolder("A", "src");
	});
	await render([]);
	await render();
	expect(latest[0].groups).toEqual(["A"]);
	await render([]);
	__resetGitStagingFolderPrefsCache();
	await render();
	expect(latest[0].groups).toEqual(["A"]);
	expect(latest[0].folders.A).toEqual(["src"]);
	expect(saved()).toEqual({ [scopeA]: { groups: ["A"], folders: { A: ["src"] } } });
	expect(storage.get("narrafork_git_expanded_folders")).toBe("ordinary-git-preferences");
});

test.each([
	"blocked",
	"quota",
])("%s storage retains interactive memory across remounts", async (mode) => {
	storage.set(
		GIT_STAGING_FOLDER_PREFS_KEY,
		JSON.stringify({ [scopeA]: { groups: ["old"], folders: {} } }),
	);
	readBlocked = mode === "blocked";
	writeBlocked = true;
	await render();
	await update(() => {
		if (latest[0].groups.includes("old")) latest[0].toggleGroup("old");
		latest[0].toggleGroup("A");
		latest[0].toggleFolder("A", "src/lib");
	});
	expect(latest[0].groups).toEqual(["A"]);
	await render([]);
	await render();
	expect(latest[0].groups).toEqual(["A"]);
	expect(latest[0].folders.A).toEqual(["src/lib", "src"]);
	await update(() => latest[0].toggleFolder("A", "src"));
	expect(latest[0].folders.A).toEqual([]);
	await update(() => latest[0].toggleGroup("A"));
	expect(latest[0].groups).toEqual([]);
});

test.each([
	"{",
	"null",
	"[]",
	"42",
	JSON.stringify({ [scopeA]: null }),
	JSON.stringify({ [scopeA]: [] }),
	JSON.stringify({ [scopeA]: { groups: ["A", 2], folders: { A: ["src", false] } } }),
	JSON.stringify({ [scopeA]: { groups: "A", folders: [] } }),
])("malformed preferences remain safe and can be toggled: %s", async (raw) => {
	storage.set(GIT_STAGING_FOLDER_PREFS_KEY, raw);
	await render();
	expect(latest[0].groups).toEqual([]);
	expect(Object.values(latest[0].folders).flat()).toEqual([]);
	await update(() => {
		latest[0].toggleGroup("A");
		latest[0].toggleFolder("A", "src");
	});
	expect(latest[0].groups).toEqual(["A"]);
	expect(latest[0].folders.A).toEqual(["src"]);
});

test("deduplicates strings and bounds malformed or oversized preference inputs", async () => {
	storage.set(
		GIT_STAGING_FOLDER_PREFS_KEY,
		JSON.stringify({
			[scopeA]: { groups: ["A", "A"], folders: { A: ["src", "src"], B: ["x".repeat(4097)] } },
		}),
	);
	await render();
	expect(latest[0].groups).toEqual(["A"]);
	expect(latest[0].folders).toEqual({ A: ["src"], B: [] });
	const longPath = "x".repeat(4097);
	await update(() => latest[0].toggleFolder("A", longPath));
	expect(latest[0].folders.A).toEqual(["src", longPath]);
	expect(saved()[scopeA].folders.A).toEqual(["src", "src"]);
	await update(() => latest[0].toggleFolder("A", longPath));
	expect(latest[0].folders.A).toEqual(["src"]);
	await render([]);
	storage.set(GIT_STAGING_FOLDER_PREFS_KEY, " ".repeat(256 * 1024 + 1));
	__resetGitStagingFolderPrefsCache();
	await render();
	expect(latest[0].groups).toEqual([]);
	await update(() => latest[0].toggleGroup("A"));
	expect(latest[0].groups).toEqual(["A"]);
});

test("keeps only expansion fields when persisting parsed preferences", async () => {
	storage.set(
		GIT_STAGING_FOLDER_PREFS_KEY,
		JSON.stringify({
			[scopeA]: {
				groups: ["A"],
				folders: { A: ["src"] },
				selection: ["old-unit"],
				fileData: "old content",
				token: "old credential",
				canWrite: true,
			},
		}),
	);
	await render();
	await update(() => latest[0].toggleGroup("B"));
	expect(saved()).toEqual({ [scopeA]: { groups: ["A", "B"], folders: { A: ["src"] } } });
});

test("full storage documents retain new-scope toggles and shared memory across remounts", async () => {
	const folders = Array.from({ length: 64 }, (_, index) => `${index}-${"x".repeat(4080)}`);
	const original = { [scopeA]: { groups: ["A"], folders: { A: folders } } };
	folders.push("p".repeat(256 * 1024 - JSON.stringify(original).length - 3 - 8));
	const raw = JSON.stringify(original);
	expect(raw.length).toBe(256 * 1024 - 8);
	storage.set(GIT_STAGING_FOLDER_PREFS_KEY, raw);
	const scopeB = JSON.stringify(["narrator-b", "workspace-b", "user-b"]);
	await render([scopeB, scopeB]);
	await update(() => {
		latest[0].toggleGroup("B");
		latest[1].toggleFolder("B", "src/lib");
	});
	expect(latest[0].groups).toEqual(["B"]);
	expect(latest[1].groups).toBe(latest[0].groups);
	expect(latest[1].folders.B).toEqual(["src/lib", "src"]);
	expect(storage.get(GIT_STAGING_FOLDER_PREFS_KEY)).toBe(raw);
	await render([]);
	await render([scopeB, scopeB]);
	expect(latest[0].groups).toEqual(["B"]);
	expect(latest[0].folders.B).toEqual(["src/lib", "src"]);
	await update(() => {
		latest[0].toggleFolder("B", "src");
		latest[1].toggleGroup("B");
	});
	expect(latest[0].groups).toEqual([]);
	expect(latest[1].folders.B).toEqual([]);
	await render([scopeA]);
	expect(latest[0].folders.A).toEqual(folders);
	await update(() => latest[0].toggleFolder("A", folders[0]));
	expect(latest[0].folders.A).toHaveLength(64);
	expect(storage.get(GIT_STAGING_FOLDER_PREFS_KEY)?.length).toBeLessThanOrEqual(256 * 1024);
	await render([]);
	__resetGitStagingFolderPrefsCache();
	await render([scopeA, scopeB]);
	expect(latest[0].folders.A).toHaveLength(64);
	expect(latest[1].groups).toEqual([]);
	expect(latest[1].folders.B).toEqual([]);
});

test.each([
	"groups",
	"folders",
])("the 2049th expanded %s remains shared and interactive in memory", async (kind) => {
	const entries = Array.from({ length: 2048 }, (_, index) => `dir-${index}`);
	const original = {
		[scopeA]: {
			groups: kind === "groups" ? entries : ["A"],
			folders: kind === "folders" ? { A: entries } : {},
		},
	};
	const raw = JSON.stringify(original);
	storage.set(GIT_STAGING_FOLDER_PREFS_KEY, raw);
	await render([scopeA, scopeA]);
	const toggle = (index: number) =>
		kind === "groups"
			? latest[0].toggleGroup(`dir-${index}`)
			: latest[0].toggleFolder("A", `dir-${index}`);
	const expanded = (reader = "0") =>
		kind === "groups" ? latest[reader].groups : latest[reader].folders.A;
	await update(() => toggle(2048));
	expect(expanded()).toHaveLength(2049);
	expect(expanded()).toContain("dir-2048");
	expect(expanded("1")).toBe(expanded());
	expect(storage.get(GIT_STAGING_FOLDER_PREFS_KEY)).toBe(raw);
	await render([]);
	await render([scopeA, scopeA]);
	expect(expanded()).toHaveLength(2049);
	await update(() => toggle(0));
	expect(expanded()).toHaveLength(2048);
	expect(expanded()).not.toContain("dir-0");
	expect(expanded("1")).toBe(expanded());
	await render([]);
	__resetGitStagingFolderPrefsCache();
	await render();
	expect(expanded()).toHaveLength(2048);
	expect(expanded()).toContain("dir-2048");
	expect(expanded()).not.toContain("dir-0");
});

test("oversized external arrays are rejected while fresh choices remain usable", async () => {
	const entries = Array.from({ length: 2049 }, (_, index) => `dir-${index}`);
	storage.set(
		GIT_STAGING_FOLDER_PREFS_KEY,
		JSON.stringify({
			[scopeA]: { groups: entries, folders: { A: entries } },
		}),
	);
	await render();
	expect(latest[0].groups).toEqual([]);
	expect(latest[0].folders.A).toEqual([]);
	await update(() => {
		latest[0].toggleGroup("A");
		latest[0].toggleFolder("A", "src");
	});
	await render([]);
	__resetGitStagingFolderPrefsCache();
	await render();
	expect(latest[0].groups).toEqual(["A"]);
	expect(latest[0].folders.A).toEqual(["src"]);
});

test("server rendering without window leaves every folder collapsed", () => {
	const currentWindow = window;
	Reflect.deleteProperty(globalThis, "window");
	try {
		const html = renderToString(<Probe name="ssr" scope={scopeA} />);
		expect(html).toContain("[[],{}]");
		expect(storage.size).toBe(0);
	} finally {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			writable: true,
			value: currentWindow,
		});
	}
});
