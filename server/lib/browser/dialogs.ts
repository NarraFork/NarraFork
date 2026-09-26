import type { BrowserContext, CDPSession, Target } from "puppeteer-core";

const DIALOG_TIMEOUT_MS = 3_000;
const MAX_DIALOG_TEXT = 2_000;
interface Protection {
	record: (text: string) => void;
	ready: Promise<void>;
	attach: (target: Target) => Promise<void>;
}
const protections = new WeakMap<BrowserContext, Protection>();
const hookedManagers = new WeakSet<object>();

// One browser-level hook, with only weak context lookups: closed sessions must not be retained.
function onTargetAvailable(target: Target): void {
	const state = protections.get(target.browserContext());
	if (!state) return;
	void state.attach(target).catch((error) => {
		state.record(
			`Failed to install native dialog protection: ${String(error).slice(0, MAX_DIALOG_TEXT)}`,
		);
	});
}

/** Chromium keeps pending dialogs per CDP session. A fresh createCDPSession() cannot
 * dismiss an earlier dialog, and target.page() can block while initializing behind it.
 * Isolate this Puppeteer CDP-specific adapter here; fail explicitly if it changes.
 * This is a BORROWED session: never detach it or disable its Page domain.
 */
function dialogClient(target: Target): CDPSession {
	const cdpTarget = target as Target & { _session?: () => CDPSession | undefined };
	const client = cdpTarget._session?.();
	if (!client)
		throw new Error("Puppeteer target has no existing CDP session for dialog protection");
	return client;
}

/** Install before navigation and before resolving popup Page objects. */
export function installDialogProtection(
	context: BrowserContext,
	record: (text: string) => void,
): Promise<void> {
	const existing = protections.get(context);
	if (existing) {
		existing.record = record;
		return existing.ready;
	}
	// Public targetcreated/popup events wait for target initialization; window.open can
	// already block its opener by then. TargetManager emits before resuming the renderer.
	const browser = context.browser() as ReturnType<BrowserContext["browser"]> & {
		_targetManager?: () => {
			on(event: "targetAvailable", handler: (target: Target) => void): unknown;
		};
	};
	const manager = browser._targetManager?.();
	if (!manager) {
		return Promise.reject(new Error("Puppeteer target manager unavailable for dialog protection"));
	}
	const state: Protection = { record, ready: Promise.resolve(), attach: () => Promise.resolve() };
	protections.set(context, state);
	const attached = new WeakMap<Target, Promise<void>>();
	const cleanups = new Set<() => void>();
	const targetCleanups = new WeakMap<Target, () => void>();
	const onTargetDestroyed = (target: Target) => {
		const cleanup = targetCleanups.get(target);
		if (!cleanup) return;
		cleanup();
		cleanups.delete(cleanup);
		targetCleanups.delete(target);
	};
	context.on("targetdestroyed", onTargetDestroyed);
	const attach = (target: Target): Promise<void> => {
		if (target.type() !== "page") return Promise.resolve();
		const pending = attached.get(target);
		if (pending) return pending;
		const setup = (async () => {
			const client = dialogClient(target);
			const dismiss = async (summary: string) => {
				try {
					await client.send(
						"Page.handleJavaScriptDialog",
						{ accept: false },
						{ timeout: DIALOG_TIMEOUT_MS },
					);
					state.record(`Automatically dismissed native dialog (${summary})`);
				} catch (error) {
					// Expected for the probe, or if a user/another CDP client won the race.
					if (String(error).includes("No dialog is showing")) return;
					throw error;
				}
			};
			const onDialog = (event: { type: string; message: string }) => {
				const summary = `${event.type}: ${event.message.slice(0, MAX_DIALOG_TEXT)}`;
				void dismiss(summary).catch((error) => {
					state.record(
						`Failed to dismiss native dialog (${summary}): ${String(error).slice(0, MAX_DIALOG_TEXT)}`,
					);
				});
			};
			client.on("Page.javascriptDialogOpening", onDialog);
			const cleanup = () => client.off("Page.javascriptDialogOpening", onDialog);
			cleanups.add(cleanup);
			// Release references when a popup closes instead of accumulating all past targets.
			targetCleanups.set(target, cleanup);
			try {
				// Enqueue Page.enable synchronously while TargetManager still pauses a new target.
				// Awaiting anything first lets its Runtime.runIfWaitingForDebugger win the race.
				await Promise.all([
					client.send("Page.enable", undefined, { timeout: DIALOG_TIMEOUT_MS }),
					dismiss("already open at attachment; type and message unavailable"),
				]);
			} catch (error) {
				cleanup();
				cleanups.delete(cleanup);
				targetCleanups.delete(target);
				throw error;
			}
		})();
		attached.set(target, setup);
		return setup;
	};
	state.attach = attach;
	// Register before enumerating to cover targets created during installation.
	if (!hookedManagers.has(manager)) {
		manager.on("targetAvailable", onTargetAvailable);
		hookedManagers.add(manager);
	}
	state.ready = Promise.all(context.targets().map(attach)).then(
		() => {},
		(error: unknown) => {
			context.off("targetdestroyed", onTargetDestroyed);
			for (const cleanup of cleanups) cleanup();
			cleanups.clear();
			protections.delete(context);
			throw new Error(
				`Native dialog protection could not be initialized. Dismiss any existing browser dialog and retry. ${String(error).slice(0, MAX_DIALOG_TEXT)}`,
			);
		},
	);
	return state.ready;
}
