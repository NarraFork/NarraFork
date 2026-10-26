import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { createPreviewShell, type PreviewShellEvent } from "./gen-ui-preview-shell";

const theme = { colorScheme: "light" as const, tokenCss: "" };

test("inspection enforces offline CSP even for a project kit", () => {
	const source = { runtimeJs: "", runtimeCss: "" };
	const offline = createPreviewShell(source, theme, "failed", { kit: true, inspection: true });
	expect(offline).toContain("connect-src 'none'");
	expect(offline).toContain("worker-src 'none'");
	expect(offline).toContain("font-src 'none'");
	expect(offline).not.toContain("connect-src *");
	const normal = createPreviewShell(source, theme, "failed", { kit: true });
	expect(normal).toContain("connect-src *");
	expect(normal).toContain("worker-src blob:");
});

/** Exercise the emitted bootstrap, holding commits and animation frames explicitly. */
function harness(inspection = false, markup = false) {
	const messages: PreviewShellEvent[] = [];
	const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
	const frames: (() => void)[] = [];
	const effects: (() => void)[] = [];
	const components = new Map<string, () => unknown>();
	const states: unknown[] = [];
	let cursor = 0;
	const parent = { postMessage: (event: PreviewShellEvent) => messages.push(event) };
	const listen = (name: string, fn: (event: Record<string, unknown>) => void) => {
		listeners.set(name, [...(listeners.get(name) ?? []), fn]);
	};
	const context = createContext({
		parent,
		TextEncoder,
		performance: { now: () => 100 },
		requestAnimationFrame: (fn: () => void) => frames.push(fn),
		document: {
			getElementById: () => ({}),
			createElement: () => ({ remove() {} }),
			head: { appendChild() {} },
			documentElement: { dataset: {} },
			addEventListener: listen,
		},
		addEventListener: listen,
		__nfGenUiApp: () => null,
		__nfKit: {
			React: {
				Component: class {},
				createElement(type: string | (() => unknown), ...args: unknown[]) {
					if (typeof type === "function") components.set(type.name, type);
					return { type, args };
				},
				useEffect: (fn: () => void) => effects.push(fn),
				useState(initial: unknown) {
					const index = cursor++;
					if (!(index in states)) states[index] = initial;
					return [
						states[index],
						(next: unknown) => {
							states[index] = typeof next === "function" ? next(states[index]) : next;
						},
					];
				},
			},
			ReactDOMClient: { createRoot: () => ({ render() {} }) },
			components: {},
		},
	});
	context.window = context;
	const html = createPreviewShell({ runtimeJs: "", runtimeCss: "" }, theme, "failed", {
		kit: true,
		inspection,
		mode: markup ? "markup" : "app",
	});
	const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
	if (!script) throw new Error("Missing shell bootstrap");
	runInContext(script, context);
	return {
		messages,
		context,
		emit(name: string, event: Record<string, unknown>) {
			for (const listener of listeners.get(name) ?? []) listener(event);
		},
		tree(nodes: unknown[]) {
			for (const listener of listeners.get("message") ?? [])
				listener({ source: parent, data: { type: "narrafork:ui-tree", nodes } });
		},
		commit() {
			cursor = 0;
			components.get(markup ? "Markup" : "AppCommitted")?.();
			for (const effect of effects.splice(0)) effect();
		},
		frame() {
			for (const fn of frames.splice(0)) fn();
		},
	};
}

test("app painted waits for commit and two frames, never root.render return", () => {
	const shell = harness();
	expect(shell.messages).toEqual([]);
	shell.commit();
	expect(shell.messages).toEqual([{ type: "narrafork:ui-ready" }]);
	shell.frame();
	expect(shell.messages).toHaveLength(1);
	shell.frame();
	expect(shell.messages.at(-1)?.type).toBe("narrafork:preview-painted");
});

test("markup handshake precedes host tree, initial empty commit is not painted", () => {
	const shell = harness(true, true);
	shell.commit();
	shell.frame();
	shell.frame();
	expect(shell.messages).toEqual([{ type: "narrafork:ui-ready" }]);
	shell.tree([]);
	shell.commit();
	shell.frame();
	shell.frame();
	expect(shell.messages.at(-1)?.type).toBe("narrafork:preview-painted");
});

test("runtime errors suppress successful paint even after offline warnings", () => {
	const shell = harness(true);
	shell.commit();
	shell.emit("securitypolicyviolation", {
		effectiveDirective: "connect-src",
		blockedURI: "https://invalid",
	});
	for (let index = 0; index < 30; index++)
		shell.emit("error", { error: new Error("x".repeat(4000)) });
	shell.frame();
	shell.frame();
	const diagnostics = shell.messages.filter(
		(event) => event.type === "narrafork:preview-diagnostic",
	);
	expect(diagnostics.length).toBeLessThanOrEqual(20);
	expect(diagnostics[0].kind).toBe("csp");
	expect(diagnostics[0].severity).toBe("warning");
	expect(diagnostics[1].severity).toBe("error");
	expect(diagnostics.every((event) => Buffer.byteLength(event.message) <= 2048)).toBe(true);
	expect(
		diagnostics.reduce((sum, event) => sum + Buffer.byteLength(event.message), 0),
	).toBeLessThanOrEqual(16384);
	expect(shell.messages.some((event) => event.type === "narrafork:preview-painted")).toBe(false);
});

test("offline resource warnings preserve painted success and reserve error reporting capacity", () => {
	const shell = harness(true);
	shell.commit();
	for (let index = 0; index < 100; index++)
		shell.emit("securitypolicyviolation", {
			effectiveDirective: "img-src",
			blockedURI: "错误😀".repeat(1000),
		});
	shell.frame();
	shell.frame();
	expect(shell.messages.some((event) => event.type === "narrafork:preview-painted")).toBe(true);
	shell.emit("unhandledrejection", { reason: new Error("actual runtime failure") });
	const diagnostics = shell.messages.filter(
		(event) => event.type === "narrafork:preview-diagnostic",
	);
	expect(diagnostics.at(-1)).toMatchObject({
		severity: "error",
		message: "actual runtime failure",
	});
	expect(diagnostics.length).toBeLessThanOrEqual(20);
	expect(diagnostics.every((event) => Buffer.byteLength(event.message) <= 2048)).toBe(true);
	expect(
		diagnostics.reduce((sum, event) => sum + Buffer.byteLength(event.message), 0),
	).toBeLessThanOrEqual(16384);
});

test("inspection never forwards actions even following a trusted gesture", () => {
	for (const inspection of [false, true]) {
		const shell = harness(inspection);
		shell.emit("click", { isTrusted: true });
		runInContext('genUI.sendPrompt("hello")', shell.context);
		expect(
			shell.messages.some((event) => (event as { type: string }).type === "narrafork:ui-action"),
		).toBe(!inspection);
	}
});
