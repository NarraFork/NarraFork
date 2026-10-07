/** Keep localhost's IPv6 resolution; replace wildcard listen addresses with loopback. */
export function desktopServerOrigin(address: {
	protocol: string;
	host: string;
	port: number;
}): string {
	const host =
		address.host === "0.0.0.0"
			? "127.0.0.1"
			: address.host === "::" || address.host === "[::]"
				? "[::1]"
				: address.host.includes(":") && !address.host.startsWith("[")
					? `[${address.host}]`
					: address.host;
	return `${address.protocol}://${host}:${address.port}`;
}

/** Native-shell adapter; deliberately independent of Electrobun and server startup. */
export interface DesktopWindow {
	activate(): void;
	show(): void;
	webview: {
		loadHTML(html: string): void;
		loadURL(url: string): void;
	};
	on(event: "close", listener: () => void): void;
}

export interface DesktopLifecycleDependencies {
	createWindow(): DesktopWindow;
	loadingHtml: string;
	shutdown(): Promise<void>;
	disposeTray(): void;
	exit(): void;
	/** Reports failures from event-triggered quit; explicit quit callers receive rejection. */
	onError?(error: unknown): void;
}

export interface DesktopLifecycle {
	readonly isQuitting: boolean;
	readonly hasWindow: boolean;
	openWindow(): DesktopWindow | null;
	setReady(origin: string): void;
	setError(html: string): void;
	/** Defaults to false. Set true only after successfully installing a background entry point. */
	setBackgroundAvailable(available: boolean): void;
	/** Concurrent callers share completion; a rejected shutdown restores the ability to retry. */
	quit(): Promise<void>;
}

type Page = { kind: "html"; value: string } | { kind: "url"; value: string };

export function createDesktopLifecycle(deps: DesktopLifecycleDependencies): DesktopLifecycle {
	let window: DesktopWindow | null = null;
	let page: Page = { kind: "html", value: deps.loadingHtml };
	let backgroundAvailable = false;
	let isQuitting = false;
	let quitPromise: Promise<void> | undefined;

	function render(target: DesktopWindow): void {
		if (page.kind === "url") target.webview.loadURL(page.value);
		else target.webview.loadHTML(page.value);
	}

	function quit(): Promise<void> {
		if (quitPromise) return quitPromise;
		isQuitting = true;
		// Defer injected code until the shared promise is assigned (also handles reentrancy).
		quitPromise = Promise.resolve().then(async () => {
			try {
				await deps.shutdown();
			} catch (error) {
				// Keep the tray and process alive: the caller can restore UI and retry shutdown.
				isQuitting = false;
				quitPromise = undefined;
				throw error;
			}
			try {
				deps.disposeTray();
			} finally {
				deps.exit();
			}
		});
		return quitPromise;
	}

	return {
		get isQuitting() {
			return isQuitting;
		},
		get hasWindow() {
			return window !== null;
		},
		openWindow() {
			if (isQuitting) return null;
			if (!window) {
				const created = deps.createWindow();
				window = created;
				created.on("close", () => {
					// Duplicate or delayed close notifications must not clear a replacement window.
					if (window !== created) return;
					window = null;
					if (!backgroundAvailable && !isQuitting) {
						void quit().catch((error: unknown) => deps.onError?.(error));
					}
				});
				render(created);
			}
			window.show();
			window.activate();
			return window;
		},
		setReady(origin) {
			if (isQuitting) return;
			page = { kind: "url", value: origin };
			if (window) render(window);
		},
		setError(html) {
			if (isQuitting) return;
			page = { kind: "html", value: html };
			if (window) render(window);
		},
		setBackgroundAvailable(available) {
			backgroundAvailable = available;
		},
		quit,
	};
}
