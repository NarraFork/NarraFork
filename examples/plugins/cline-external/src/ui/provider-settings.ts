/**
 * `provider-settings` view: Cline sign-in, balance and model selection.
 *
 * ## What this page can and cannot do
 *
 * It runs in a sandboxed iframe with `connect-src 'none'`, so it cannot reach any HTTP
 * endpoint — not even the host's own admin API. Everything it does goes through
 * `commands.execute`, which the host routes to this plugin's backend.
 *
 * It never reads a credential. `status` reports whether one exists and who it belongs to; the
 * token itself is not part of any command's output. Values typed into the callback box travel
 * one way, into a command, and the box is cleared as soon as it is submitted.
 *
 * ## Field names are a contract
 *
 * `browserAuth` and its three values (`available` / `port_busy` / `unsupported`) must match
 * what `commands.ts` returns exactly. There is no shared type across the iframe boundary — the
 * payload is JSON and both sides see `unknown` — so a rename on one side is invisible to the
 * compiler and shows up only as a control that never appears. A test asserts the two artifacts
 * agree on these strings.
 *
 * ## Why plain DOM
 *
 * The iframe is a separate document, so the host's React and Mantine are unavailable.
 */

interface PluginUiSdk {
	request(method: string, params?: unknown): Promise<unknown>;
	notify(event: string, payload?: unknown): void;
	/**
	 * Host-provided translation, so this panel does not carry its own locale detection.
	 *
	 * Optional because an older host does not expose it; `text()` below falls back to the English
	 * table in that case, which is what this panel showed before the SDK existed.
	 */
	i18n?: {
		locale: string;
		t(tables: Record<string, Record<string, string>>, key: string, params?: unknown): string;
		onChange(listener: (locale: string) => void): () => void;
	};
}

/**
 * Panel copy.
 *
 * Wording is taken from the host's own `settings` namespace on purpose: this panel is meant to be
 * indistinguishable from the built-in Cline section, and paraphrasing would show up as the two
 * pages disagreeing about what the same button does. That is a one-time human comparison, not a
 * runtime dependency — the host's translation keys are internal and must not be read from here.
 */
const STRINGS = {
	en: {
		title: "Cline account",
		notSignedIn: "Not signed in.",
		signedIn: "Signed in",
		credentialsUnreadable:
			"Stored credentials are unreadable: {reason}. Sign out and sign in again.",
		tokenValid: "token valid",
		tokenExpired: "token expired",
		modelsEnabled: "{count} models enabled",
		modelsInPool: "{count} models in pool",
		signInBrowser: "Sign in with browser",
		portBusy:
			"Callback port 19876 is in use, possibly by the built-in Cline provider signing in. You can retry, or paste the callback URL below.",
		browserUnsupported:
			"This environment cannot receive a browser callback. Use the paste option below.",
		waitingCallback: "Waiting for the browser callback…",
		cancelSignIn: "Cancel sign-in",
		pastePrompt: "Or paste the callback URL your browser was redirected to:",
		importCallback: "Import callback URL",
		signOut: "Sign out",
		openToAuthorize: "Open this URL to authorize, then return here:",
		copyUrl: "Copy URL",
		urlCopied: "Authorization URL copied.",
		urlCopyFailed: "Could not copy — select the URL above instead.",
		refreshBalance: "Refresh balance",
		loadingBalance: "Loading balance…",
		// The currency symbol is part of the substituted value, not the template: `${amount}` here
		// reads as a JS template placeholder to both linters and humans, while the interpolation
		// syntax is actually `{amount}`.
		balance: "Balance: {amount}",
		noBalance: "No balance data available.",
		balanceFailed: "Balance failed: {reason}",
		models: "Models",
		modelsDesc: "Only the models you enable here are offered to the agent.",
		enabled: "Enabled",
		selectedCount: "{count} selected",
		unsavedChanges: "unsaved changes",
		saveSelection: "Save selection",
		refreshPool: "Refresh pool",
		revert: "Revert",
		recommendedAndFree: "Recommended and free",
		recommended: "Recommended",
		free: "Free",
		loading: "Loading…",
		noRecommendations: "No recommendations available.",
		recommendationsFailed: "Recommendations failed: {reason}",
		searchPool: "Search the model pool",
		searchPlaceholder: "e.g. claude sonnet",
		search: "Search",
		searching: "Searching…",
		minChars: "Type at least {count} characters to search.",
		noMatches: "No matches.",
		shownOf: "{shown} of {total} shown",
		shownOfRefine: "{shown} of {total} shown · refine the query to narrow it",
		contextSuffix: "{size}k ctx",
		alreadyEnabled: "enabled",
		nothingToImport: "Nothing to import.",
		noAccountInfo: "No account information available.",
		loadFailed: "Failed to load account: {reason}",
		actionDone: "{action} done.",
		actionFailed: "{action} failed: {reason}",
		actionBrowserSignIn: "Browser sign-in",
		actionCancelSignIn: "Cancel sign-in",
		actionImport: "Import credentials",
		actionSignOut: "Sign out",
		actionSaveModels: "Save models",
		actionRefreshPool: "Refresh pool",
	},
	"zh-CN": {
		title: "Cline 账号",
		notSignedIn: "未登录。",
		signedIn: "已登录",
		credentialsUnreadable: "存储的凭据无法读取：{reason}。请登出后重新登录。",
		tokenValid: "令牌有效",
		tokenExpired: "令牌已过期",
		modelsEnabled: "已启用 {count} 个模型",
		modelsInPool: "模型池共 {count} 个",
		signInBrowser: "使用浏览器登录",
		portBusy:
			"回调端口 19876 已被占用，可能是内置 Cline 供应商正在登录。可以重试，或在下方粘贴回调 URL。",
		browserUnsupported: "当前环境无法接收浏览器回调，请使用下方的粘贴方式。",
		waitingCallback: "等待浏览器回调…",
		cancelSignIn: "取消登录",
		pastePrompt: "或粘贴浏览器跳转到的回调 URL：",
		importCallback: "导入回调 URL",
		signOut: "登出",
		openToAuthorize: "打开此 URL 完成授权，然后返回此页：",
		copyUrl: "复制 URL",
		urlCopied: "授权 URL 已复制。",
		urlCopyFailed: "无法复制 — 请手动选中上方 URL。",
		refreshBalance: "刷新余额",
		loadingBalance: "正在加载余额…",
		balance: "余额：{amount}",
		noBalance: "暂无余额数据。",
		balanceFailed: "获取余额失败：{reason}",
		models: "模型",
		modelsDesc: "只有在此启用的模型才会提供给智能体。",
		enabled: "已启用",
		selectedCount: "已选 {count} 个",
		unsavedChanges: "有未保存的更改",
		saveSelection: "保存选择",
		refreshPool: "刷新模型池",
		revert: "撤销",
		recommendedAndFree: "推荐与免费",
		recommended: "推荐",
		free: "免费",
		loading: "加载中…",
		noRecommendations: "暂无推荐。",
		recommendationsFailed: "获取推荐失败：{reason}",
		searchPool: "搜索模型池",
		searchPlaceholder: "例如 claude sonnet",
		search: "搜索",
		searching: "搜索中…",
		minChars: "请输入至少 {count} 个字符以搜索。",
		noMatches: "无匹配结果。",
		shownOf: "显示 {shown} / {total}",
		shownOfRefine: "显示 {shown} / {total} · 细化关键词可缩小范围",
		contextSuffix: "{size}k 上下文",
		alreadyEnabled: "已启用",
		nothingToImport: "没有可导入的内容。",
		noAccountInfo: "暂无账号信息。",
		loadFailed: "加载账号失败：{reason}",
		actionDone: "{action}完成。",
		actionFailed: "{action}失败：{reason}",
		actionBrowserSignIn: "浏览器登录",
		actionCancelSignIn: "取消登录",
		actionImport: "导入凭据",
		actionSignOut: "登出",
		actionSaveModels: "保存模型",
		actionRefreshPool: "刷新模型池",
	},
};

/**
 * `zh-CN` must cover every key `en` declares.
 *
 * Both tables were `Record<string, string>`, which makes them independent: adding a key to
 * `en` and forgetting `zh-CN` compiles, and `t()` falls back to the English string. That
 * fallback is what hides the omission — one English label among Chinese ones reads as a
 * deliberate choice, so nobody reports it.
 *
 * Expressed as a type-level assertion rather than by annotating the literal, because
 * annotating it would widen the key type to `string` and make `t()`'s own key checking
 * vacuous. Unused at runtime; it exists to fail `tsc`.
 */
type _ClineStringsCovered = keyof (typeof STRINGS)["en"] extends keyof (typeof STRINGS)["zh-CN"]
	? true
	: never;
/** Reading the alias is what makes an incomplete `zh-CN` a compile error rather than dead code. */
const _clineStringsCovered: _ClineStringsCovered = true;
void _clineStringsCovered;

/** Mirrors the `status` command's output. */
interface StatusOutput {
	authenticated: boolean;
	credentialError?: string;
	email?: string;
	displayName?: string;
	expiresAt?: number;
	expired?: boolean;
	hasUserId?: boolean;
	enabledModelCount: number;
	enabledModels: string[];
	poolModelCount: number;
	browserAuth: "available" | "port_busy" | "unsupported";
	signInPending: boolean;
	/** Present only while a browser sign-in is pending, so a remount can show it again. */
	authorizeUrl?: string;
	chatBaseUrl?: string;
}

interface PoolModel {
	id: string;
	name?: string;
	contextLength?: number;
	promptPrice?: string;
	completionPrice?: string;
}

interface RecommendedModel {
	id: string;
	name: string;
	description?: string;
	tags: string[];
}

/**
 * Colours, resolved from the host's design tokens rather than hardcoded.
 *
 * The host injects `--nf-*` custom properties into this document reflecting its *current* theme,
 * so switching the colour scheme, enabling OLED, or activating a plugin-contributed theme all
 * reach this panel with no code here. Previously these were eight fixed hex values, which meant
 * the panel stayed dark-grey no matter what the rest of the app looked like.
 *
 * Each `var()` keeps a fallback equal to the old hardcoded value, so an older host that injects
 * nothing renders exactly as before instead of falling back to browser defaults.
 */
const COLORS = {
	text: "var(--nf-color-text, #e6e6e6)",
	muted: "var(--nf-color-dimmed, #8b8b8b)",
	bad: "var(--nf-color-error, #ff8a8a)",
	good: "var(--nf-color-success, #7ee0a2)",
	warn: "var(--nf-color-warning, #c9a227)",
	panel: "var(--nf-color-surface, #2a2a2e)",
	border: "var(--nf-color-border, #3a3a40)",
	input: "var(--nf-color-body, #1a1a1e)",
} as const;

/** Font stacks, likewise from the host so the panel matches its typography. */
const FONTS = {
	ui: "var(--nf-font, system-ui, sans-serif)",
	mono: "var(--nf-font-mono, ui-monospace, monospace)",
} as const;

/**
 * How often `status` is re-read while a browser sign-in is pending.
 *
 * Matches the built-in section's `refetchInterval` of 2s. Polling runs *only* while
 * `signInPending`, because that is the one state whose end is caused by something outside this
 * document (the browser hitting the loopback callback) and therefore cannot be observed any
 * other way. Every other transition here follows a click, which already refreshes.
 *
 * A steady 2s poll of an open settings page would otherwise be free-running traffic — which is
 * also why the `status` command never refreshes a token.
 */
const SIGN_IN_POLL_MS = 2_000;

/** Debounce before a typed query is sent, matching the built-in section's `useDebouncedValue`. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Shortest query that triggers a search.
 *
 * The built-in section uses the same threshold. One character matches most of a 300+ model pool,
 * so the result would be a truncated list that says nothing while costing a round trip.
 */
const MIN_SEARCH_LENGTH = 2;

(() => {
	const sdk = globalThis.narrafork as PluginUiSdk | undefined;
	if (!sdk) return;
	const root = document.body;

	/**
	 * Translate one key.
	 *
	 * Delegates to the host SDK, which owns the locale and the fallback chain. The local fallback
	 * covers an older host with no `i18n`: English text, which is what this panel showed before.
	 * Doing the lookup here rather than reimplementing detection is the whole point — a panel
	 * should not have to know that `zh-Hans` means `zh-CN`.
	 */
	function text(key: string, params?: Record<string, string | number>): string {
		if (sdk?.i18n) return sdk.i18n.t(STRINGS, key, params);
		const template = STRINGS.en?.[key] ?? key;
		if (!params) return template;
		return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
			const value = params[name];
			return value === undefined ? match : String(value);
		});
	}

	const style = (element: HTMLElement, css: Partial<CSSStyleDeclaration>): void => {
		Object.assign(element.style, css);
	};

	function element<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		css: Partial<CSSStyleDeclaration> = {},
		text?: string,
	): HTMLElementTagNameMap[K] {
		const node = document.createElement(tag);
		if (text !== undefined) node.textContent = text;
		style(node, css);
		return node;
	}

	function button(
		label: string,
		onClick: () => void,
		tone: "normal" | "bad" = "normal",
	): HTMLButtonElement {
		const node = element("button", {
			padding: "4px 10px",
			font: `12px ${FONTS.ui}`,
			color: tone === "bad" ? COLORS.bad : COLORS.text,
			background: COLORS.panel,
			border: `1px solid ${COLORS.border}`,
			borderRadius: "5px",
			cursor: "pointer",
			marginRight: "6px",
		});
		node.textContent = label;
		node.addEventListener("click", onClick);
		return node;
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	let busy = false;
	/** Models selected in this document but not yet saved. */
	let selection = new Set<string>();
	let lastStatus: StatusOutput | undefined;
	/** The pending sign-in poll, if one is running. */
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	/** Debounce timer for the search box. */
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Monotonic id of the newest search, so a slow earlier response cannot overwrite a newer one.
	 *
	 * Typing produces overlapping requests whose completion order is not guaranteed; without this
	 * the visible results can end up belonging to a prefix of what the box now says.
	 */
	let searchGeneration = 0;
	/** Whether the balance has been auto-loaded for the current sign-in. */
	let balanceLoaded = false;
	/**
	 * Set when the host language changed, so the next refresh rebuilds the recommended and search
	 * areas too.
	 *
	 * Those two are normally built once and left alone (they hold a half-typed query and a scroll
	 * position), but their labels are translated, so a language switch has to rebuild them or the
	 * panel ends up half in each language.
	 */
	let rebuildPersistentAreas = false;
	/**
	 * Last balance result, so a re-render can restore it.
	 *
	 * Needed because every `refresh()` rebuilds this area from scratch, and with the auto-load
	 * already spent the value would otherwise vanish on the next render — including on each 2s
	 * sign-in poll tick.
	 */
	let balanceText: { text: string; tone: "normal" | "bad" } | undefined;

	/**
	 * Run a backend command.
	 *
	 * The host wraps a success as `{ status, output }`; unwrap it so callers see the command's
	 * own payload.
	 */
	async function command(commandId: string, input?: Record<string, unknown>): Promise<unknown> {
		const raw = await sdk.request("commands.execute", {
			commandId,
			...(input === undefined ? {} : { input }),
		});
		if (isRecord(raw) && "output" in raw) return raw.output;
		return raw;
	}

	/**
	 * Keep the sign-in poll running exactly while it is needed.
	 *
	 * Called after every `refresh()`, so the poll starts when a flow begins and stops on the tick
	 * that observes it ended — no separate teardown path that could be missed. Re-entrancy is
	 * handled by clearing first: `refresh()` is also what the poll calls, so without that a
	 * second timer would be armed on every tick and the interval would halve each time.
	 */
	function syncSignInPoll(status: StatusOutput): void {
		if (pollTimer !== undefined) {
			clearTimeout(pollTimer);
			pollTimer = undefined;
		}
		if (!status.signInPending) return;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			// A poll must not fight the user: `refresh()` re-renders, which would rebuild the
			// controls under a click in progress. `busy` is only set during an action, and that
			// action refreshes when it settles, so skipping here loses nothing.
			if (busy) {
				if (lastStatus) syncSignInPoll(lastStatus);
				return;
			}
			void refresh().catch(() => {
				// A failed poll is not worth reporting: the flow may still complete, and replacing
				// the "waiting for callback" hint with a transport error would be actively
				// misleading. Reschedule from the last known state so a blip does not end polling.
				if (lastStatus) syncSignInPoll(lastStatus);
			});
		}, SIGN_IN_POLL_MS);
	}

	// The host disposes the iframe when the panel closes or its session is rebuilt. Timers in a
	// document being torn down would otherwise keep issuing `commands.execute` against a dead
	// session — the requests fail, but they are pure noise and keep this document alive longer
	// than the host intends.
	globalThis.addEventListener("pagehide", () => {
		if (pollTimer !== undefined) clearTimeout(pollTimer);
		if (searchTimer !== undefined) clearTimeout(searchTimer);
		pollTimer = undefined;
		searchTimer = undefined;
	});

	const header = element("div", {
		font: `600 14px/1.9 ${FONTS.ui}`,
		color: COLORS.text,
	});
	header.textContent = text("title");
	root.appendChild(header);

	const account = element("div", { font: `13px/1.7 ${FONTS.ui}` });
	root.appendChild(account);

	const signIn = element("div", { margin: "10px 0" });
	root.appendChild(signIn);

	const balanceArea = element("div", { marginTop: "12px" });
	root.appendChild(balanceArea);

	const modelsArea = element("div", { marginTop: "16px" });
	root.appendChild(modelsArea);

	/**
	 * The recommended and search areas, built once and never rebuilt.
	 *
	 * Separate containers because `renderModels` clears its own area on every refresh, and these
	 * two must not be caught by that. Before the sign-in poll existed a refresh only followed a
	 * click, so rebuilding them was merely wasteful; on a 2s timer it would be actively broken —
	 * the search box would lose what the user was typing and `recommended-models` would call
	 * upstream every two seconds for as long as the panel stayed open.
	 */
	const recommendedArea = element("div", { marginTop: "12px" });
	root.appendChild(recommendedArea);
	const searchArea = element("div", { marginTop: "12px" });
	root.appendChild(searchArea);

	const statusLine = element("div", {
		font: `12px/1.7 ${FONTS.ui}`,
		color: COLORS.muted,
		marginTop: "12px",
		minHeight: "18px",
	});
	root.appendChild(statusLine);

	function setStatus(message: string, tone: "normal" | "bad" | "good" = "normal"): void {
		statusLine.textContent = message;
		statusLine.style.color =
			tone === "bad" ? COLORS.bad : tone === "good" ? COLORS.good : COLORS.muted;
	}

	function setBusy(isBusy: boolean): void {
		busy = isBusy;
		for (const node of root.querySelectorAll("button")) {
			(node as HTMLButtonElement).disabled = isBusy;
			(node as HTMLButtonElement).style.opacity = isBusy ? "0.5" : "1";
		}
	}

	/** Wrap an action so every failure surfaces in one place instead of vanishing. */
	function run(label: string, action: () => Promise<unknown>): void {
		if (busy) return;
		setBusy(true);
		// `label` is already translated by the caller (it passes a `text(...)` result), so this
		// only appends the ellipsis rather than looking anything up.
		setStatus(`${label}…`);
		action()
			.then(() => {
				setStatus(text("actionDone", { action: label }), "good");
				return refresh();
			})
			.catch((error: unknown) => {
				setStatus(text("actionFailed", { action: label, reason: String(error) }), "bad");
			})
			.finally(() => setBusy(false));
	}

	function formatTimestamp(seconds?: number): string {
		if (!seconds) return "";
		const date = new Date(seconds < 10_000_000_000 ? seconds * 1000 : seconds);
		return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
	}

	function renderAccount(status: StatusOutput): void {
		account.replaceChildren();
		if (status.credentialError) {
			const warning = element("div", { color: COLORS.bad });
			warning.textContent = text("credentialsUnreadable", { reason: status.credentialError });
			account.appendChild(warning);
			return;
		}
		if (!status.authenticated) {
			const notSignedIn = element("div", { color: COLORS.warn });
			notSignedIn.textContent = text("notSignedIn");
			account.appendChild(notSignedIn);
			return;
		}
		const who = element("div", { color: COLORS.text });
		who.textContent = status.displayName || status.email || text("signedIn");
		account.appendChild(who);

		const facts = [
			status.email && status.email !== status.displayName ? status.email : undefined,
			status.expiresAt
				? `${text(status.expired ? "tokenExpired" : "tokenValid")} · ${formatTimestamp(status.expiresAt)}`
				: undefined,
			text("modelsEnabled", { count: status.enabledModelCount }),
			status.poolModelCount ? text("modelsInPool", { count: status.poolModelCount }) : undefined,
		].filter((value): value is string => Boolean(value));
		account.appendChild(
			element("div", { font: `12px/1.7 ${FONTS.mono}`, color: COLORS.muted }, facts.join("  ·  ")),
		);
	}

	/**
	 * Sign-in controls.
	 *
	 * The three `browserAuth` states differ only in whether the browser button is offered and
	 * what is said about it. `port_busy` keeps the button live on purpose: a taken port is
	 * transient, and the probe's answer was only true at the instant it ran, so disabling would
	 * turn a recoverable situation into a dead end. The authoritative answer comes from the
	 * real bind, which reports `PORT_IN_USE` through the status line.
	 */
	function renderSignIn(status: StatusOutput): void {
		signIn.replaceChildren();

		if (status.browserAuth !== "unsupported") {
			signIn.appendChild(
				button(text("signInBrowser"), () =>
					run(text("actionBrowserSignIn"), async () => {
						const result = await command("auth.browser");
						const url = isRecord(result) ? result.authorizeUrl : undefined;
						if (typeof url !== "string") throw new Error("No authorization URL returned");
						// Nothing to do with the URL here: `run` refreshes when this resolves, and the
						// box is rendered from `status.authorizeUrl` below. Appending it directly — as
						// this did before — put it on screen for the few milliseconds until that
						// refresh called `signIn.replaceChildren()`, so the URL the whole flow depends
						// on flashed and vanished.
					}),
				),
			);
		}

		const note = element("div", {
			font: `11px/1.6 ${FONTS.ui}`,
			color: status.browserAuth === "available" ? COLORS.muted : COLORS.warn,
			marginTop: "4px",
			marginBottom: "6px",
		});
		if (status.browserAuth === "port_busy") {
			note.textContent = text("portBusy");
		} else if (status.browserAuth === "unsupported") {
			note.textContent = text("browserUnsupported");
		} else if (status.signInPending) {
			note.textContent = text("waitingCallback");
		}
		if (note.textContent) signIn.appendChild(note);

		// Rendered from status rather than from the `auth.browser` response, so it survives the
		// refresh that follows the click and reappears if the panel is remounted mid-flow.
		if (status.authorizeUrl) showAuthorizeUrl(status.authorizeUrl);

		if (status.signInPending) {
			signIn.appendChild(
				button(text("cancelSignIn"), () =>
					run(text("actionCancelSignIn"), () => command("auth.cancel")),
				),
			);
		}

		// Always available: it is the path that does not depend on a bindable port.
		signIn.appendChild(
			element(
				"div",
				{ font: `12px/1.6 ${FONTS.ui}`, color: COLORS.muted, marginTop: "8px" },
				text("pastePrompt"),
			),
		);
		const pasteBox = element("input", {
			width: "100%",
			padding: "5px 8px",
			marginTop: "4px",
			font: `12px ${FONTS.mono}`,
			color: COLORS.text,
			background: COLORS.input,
			border: `1px solid ${COLORS.border}`,
			borderRadius: "4px",
			boxSizing: "border-box",
		}) as HTMLInputElement;
		pasteBox.placeholder = "http://localhost:19876/auth/callback?code=…";
		signIn.appendChild(pasteBox);

		const importButton = button(text("importCallback"), () => {
			const callbackUrl = pasteBox.value.trim();
			if (!callbackUrl) {
				setStatus(text("nothingToImport"), "bad");
				return;
			}
			// Cleared before the request: this box is the only place a credential exists in this
			// document, and it should not outlive the submission.
			pasteBox.value = "";
			run(text("actionImport"), () => command("auth.callback", { callbackUrl }));
		});
		style(importButton, { marginTop: "6px" });
		signIn.appendChild(importButton);

		if (status.authenticated) {
			const signOut = button(
				text("signOut"),
				() => run(text("actionSignOut"), () => command("auth.logout")),
				"bad",
			);
			style(signOut, { marginTop: "6px" });
			signIn.appendChild(signOut);
		}
	}

	/**
	 * Copy text to the clipboard, reporting whether it worked.
	 *
	 * Two mechanisms because the first is frequently unavailable here: `navigator.clipboard` is a
	 * powerful-feature API, and this document has an opaque origin (`sandbox allow-scripts`
	 * without `allow-same-origin`), so the property can be missing outright or reject. The
	 * `execCommand` path is deprecated but still the only one that works in that case.
	 *
	 * Returning a boolean rather than throwing: the caller's fallback is to tell the user to copy
	 * the text manually, which is a normal outcome here, not an error.
	 */
	async function copyText(text: string): Promise<boolean> {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			// Fall through to the legacy path.
		}
		try {
			const scratch = element("textarea", {
				position: "fixed",
				opacity: "0",
			}) as HTMLTextAreaElement;
			scratch.value = text;
			document.body.appendChild(scratch);
			scratch.select();
			const copied = document.execCommand("copy");
			scratch.remove();
			return copied;
		} catch {
			return false;
		}
	}

	/** Show the authorization URL as selectable text, since the sandbox blocks popups. */
	function showAuthorizeUrl(url: string): void {
		const existing = signIn.querySelector("[data-authorize-url]");
		if (existing) existing.remove();
		const box = element("div", {
			marginTop: "8px",
			padding: "8px 10px",
			background: COLORS.panel,
			border: `1px solid ${COLORS.border}`,
			borderRadius: "5px",
		});
		box.setAttribute("data-authorize-url", "1");
		box.appendChild(
			element("div", { font: `12px/1.6 ${FONTS.ui}`, color: COLORS.text }, text("openToAuthorize")),
		);
		const link = element("a", {
			font: `12px/1.6 ${FONTS.mono}`,
			color: COLORS.good,
			wordBreak: "break-all",
		}) as HTMLAnchorElement;
		link.href = url;
		link.target = "_blank";
		link.rel = "noreferrer";
		link.textContent = url;
		box.appendChild(link);

		// The built-in section offers copy alongside the URL, for the case the authorization has
		// to happen on another device. Not routed through `run()`: copying touches no backend, and
		// `run()` would refresh and disable every button for a local clipboard write.
		const copy = button(text("copyUrl"), () => {
			void copyText(url).then((copied) => {
				setStatus(copied ? text("urlCopied") : text("urlCopyFailed"), copied ? "good" : "bad");
			});
		});
		style(copy, { marginTop: "6px" });
		box.appendChild(copy);
		signIn.appendChild(box);
	}

	/**
	 * Fetch the balance and show it.
	 *
	 * Not routed through `run()`: it renders into its own box and must not disable the page, so
	 * that the auto-load on sign-in cannot make every other control briefly unusable.
	 */
	/** The balance box, created on demand so both the auto-load and a re-render can fill it. */
	function balanceBox(): HTMLElement {
		const existing = balanceArea.querySelector("[data-balance]");
		if (existing) existing.remove();
		const box = element("div", {
			marginTop: "6px",
			padding: "6px 10px",
			background: COLORS.panel,
			borderRadius: "5px",
			font: `12px/1.6 ${FONTS.ui}`,
			color: COLORS.muted,
		});
		box.setAttribute("data-balance", "1");
		balanceArea.appendChild(box);
		return box;
	}

	function loadBalance(): void {
		const box = balanceBox();
		box.textContent = text("loadingBalance");

		command("balance")
			.then((result) => {
				const micro = isRecord(result) ? result.balance : undefined;
				// The API reports micro-dollars (1/1,000,000 USD).
				balanceText =
					typeof micro === "number"
						? {
								text: text("balance", { amount: `$${(micro / 1_000_000).toFixed(2)}` }),
								tone: "normal",
							}
						: { text: text("noBalance"), tone: "normal" };
			})
			.catch((error: unknown) => {
				balanceText = { text: text("balanceFailed", { reason: String(error) }), tone: "bad" };
			})
			.finally(() => {
				// Re-read the box rather than closing over the one above: a refresh may have
				// replaced this area while the request was in flight, in which case writing to the
				// captured node would update an element no longer in the document.
				if (!balanceText) return;
				const target = balanceArea.querySelector("[data-balance]") ?? balanceBox();
				target.textContent = balanceText.text;
				(target as HTMLElement).style.color = balanceText.tone === "bad" ? COLORS.bad : COLORS.text;
			});
	}

	function renderBalance(status: StatusOutput): void {
		balanceArea.replaceChildren();
		if (!status.authenticated) return;
		balanceArea.appendChild(button(text("refreshBalance"), loadBalance));

		// Auto-loaded once per sign-in, like the built-in section, which queries it as soon as
		// `authenticated` turns true. Guarded by a flag rather than "is the box empty", because
		// `renderBalance` runs on every refresh — including each 2s sign-in poll — and re-fetching
		// there would turn one balance call into a stream of them.
		if (!balanceLoaded) {
			balanceLoaded = true;
			loadBalance();
			return;
		}
		// Restore the last result: this area was just cleared, and without this the balance would
		// disappear on the next unrelated refresh.
		if (balanceText) {
			const box = balanceBox();
			box.textContent = balanceText.text;
			box.style.color = balanceText.tone === "bad" ? COLORS.bad : COLORS.text;
		}
	}

	/**
	 * Re-tick the checkboxes in the persistent areas to match `selection`.
	 *
	 * The recommended and search lists outlive a refresh, so their checkboxes would otherwise keep
	 * showing whatever was true when they were built. That matters most right after a save: the
	 * enabled list above re-renders while the same model in the search results below still appears
	 * unticked, and the page contradicts itself.
	 */
	function syncModelRowChecks(): void {
		for (const area of [recommendedArea, searchArea]) {
			for (const box of area.querySelectorAll("input[type=checkbox][data-model-id]")) {
				const input = box as HTMLInputElement;
				const id = input.getAttribute("data-model-id");
				if (id) input.checked = selection.has(id);
			}
		}
	}

	function modelRow(id: string, label: string, detail?: string): HTMLElement {
		const row = element("label", {
			display: "block",
			padding: "3px 0",
			font: `12px/1.6 ${FONTS.ui}`,
			color: COLORS.text,
			cursor: "pointer",
		});
		const box = element("input", { marginRight: "6px" }) as HTMLInputElement;
		box.type = "checkbox";
		box.checked = selection.has(id);
		// Read back by `syncModelRowChecks`, which cannot infer the id from the label (a row may
		// show a display name, tags or a context note instead).
		box.setAttribute("data-model-id", id);
		box.addEventListener("change", () => {
			if (box.checked) selection.add(id);
			else selection.delete(id);
			// The "Enabled" list is derived from `selection`, so it has to be rebuilt here or
			// ticking a search result would update the counter while the list above kept omitting
			// the model until the next unrelated refresh. Re-rendering the area that owns this row
			// is safe: the event has already been delivered by the time the node is replaced.
			if (lastStatus) renderModels(lastStatus);
			else renderSelectionSummary();
			syncModelRowChecks();
		});
		row.appendChild(box);
		row.appendChild(document.createTextNode(label));
		if (detail) {
			const note = element("span", {
				color: COLORS.muted,
				font: `11px ${FONTS.mono}`,
				marginLeft: "6px",
			});
			note.textContent = detail;
			row.appendChild(note);
		}
		return row;
	}

	const selectionSummary = element("div", {
		font: `12px/1.7 ${FONTS.ui}`,
		color: COLORS.muted,
		marginTop: "6px",
	});

	function renderSelectionSummary(): void {
		const saved = new Set(lastStatus?.enabledModels ?? []);
		const changed = saved.size !== selection.size || [...selection].some((id) => !saved.has(id));
		selectionSummary.textContent = changed
			? `${text("selectedCount", { count: selection.size })} · ${text("unsavedChanges")}`
			: text("selectedCount", { count: selection.size });
		selectionSummary.style.color = changed ? COLORS.warn : COLORS.muted;
	}

	function renderModels(status: StatusOutput): void {
		modelsArea.replaceChildren();
		modelsArea.appendChild(
			element("div", { font: `600 13px/1.8 ${FONTS.ui}`, color: COLORS.text }, text("models")),
		);
		modelsArea.appendChild(
			element("div", { font: `12px/1.6 ${FONTS.ui}`, color: COLORS.muted }, text("modelsDesc")),
		);

		// Currently enabled models are listed first and unconditionally: a saved selection must
		// stay visible and removable even when it is absent from search results or the pool
		// cache is empty, otherwise the only way to deselect one would be to find it again.
		if (selection.size > 0) {
			const enabledBox = element("div", { marginTop: "8px" });
			enabledBox.appendChild(
				element("div", { font: `600 12px/1.8 ${FONTS.ui}`, color: COLORS.muted }, text("enabled")),
			);
			for (const id of [...selection].sort()) enabledBox.appendChild(modelRow(id, id));
			modelsArea.appendChild(enabledBox);
		}

		modelsArea.appendChild(selectionSummary);
		renderSelectionSummary();

		const actions = element("div", { marginTop: "6px" });
		actions.appendChild(
			button(text("saveSelection"), () =>
				run(text("actionSaveModels"), () =>
					command("config.setEnabledModels", { models: [...selection] }),
				),
			),
		);
		actions.appendChild(
			button(text("refreshPool"), () =>
				run(text("actionRefreshPool"), () => command("models.refresh")),
			),
		);
		actions.appendChild(
			button(text("revert"), () => {
				selection = new Set(status.enabledModels ?? []);
				renderModels(status);
			}),
		);
		modelsArea.appendChild(actions);
	}

	function renderRecommended(): void {
		const box = element("div", {});
		box.appendChild(
			element(
				"div",
				{ font: `600 12px/1.8 ${FONTS.ui}`, color: COLORS.muted },
				text("recommendedAndFree"),
			),
		);
		const list = element("div", {});
		list.textContent = text("loading");
		box.appendChild(list);
		recommendedArea.replaceChildren(box);

		command("recommended-models")
			.then((result) => {
				if (!isRecord(result)) {
					list.textContent = text("noRecommendations");
					return;
				}
				const groups: Array<[string, unknown]> = [
					[text("recommended"), result.recommended],
					[text("free"), result.free],
				];
				list.replaceChildren();
				for (const [label, entries] of groups) {
					if (!Array.isArray(entries) || entries.length === 0) continue;
					list.appendChild(
						element(
							"div",
							{ font: `11px/1.8 ${FONTS.ui}`, color: COLORS.muted, marginTop: "4px" },
							label,
						),
					);
					for (const entry of entries as RecommendedModel[]) {
						if (!entry?.id) continue;
						const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
						list.appendChild(modelRow(entry.id, `${entry.name || entry.id}${tags}`, entry.id));
					}
				}
				if (!list.hasChildNodes()) list.textContent = text("noRecommendations");
			})
			.catch((error: unknown) => {
				list.textContent = text("recommendationsFailed", { reason: String(error) });
				list.style.color = COLORS.bad;
			});
	}

	function renderSearch(): void {
		const box = element("div", {});
		box.appendChild(
			element("div", { font: `600 12px/1.8 ${FONTS.ui}`, color: COLORS.muted }, text("searchPool")),
		);
		const field = element("input", {
			width: "100%",
			padding: "5px 8px",
			marginTop: "4px",
			font: `12px ${FONTS.mono}`,
			color: COLORS.text,
			background: COLORS.input,
			border: `1px solid ${COLORS.border}`,
			borderRadius: "4px",
			boxSizing: "border-box",
		}) as HTMLInputElement;
		field.placeholder = text("searchPlaceholder");
		box.appendChild(field);

		const results = element("div", {
			marginTop: "6px",
			maxHeight: "260px",
			overflowY: "auto",
		});
		box.appendChild(results);
		searchArea.replaceChildren(box);

		const search = (): void => {
			const query = field.value.trim();
			// Each run claims the newest generation; a response from an older one is discarded.
			searchGeneration += 1;
			const generation = searchGeneration;

			if (query.length < MIN_SEARCH_LENGTH) {
				results.replaceChildren();
				results.style.color = COLORS.muted;
				if (query.length > 0) {
					results.textContent = text("minChars", { count: MIN_SEARCH_LENGTH });
				}
				return;
			}

			results.replaceChildren();
			results.style.color = COLORS.muted;
			results.textContent = text("searching");
			command("models.search", { query, limit: 50 })
				.then((result) => {
					if (generation !== searchGeneration) return;
					const models = isRecord(result) && Array.isArray(result.models) ? result.models : [];
					const total = isRecord(result) && typeof result.total === "number" ? result.total : 0;
					results.replaceChildren();
					results.style.color = COLORS.muted;
					if (models.length === 0) {
						results.textContent = text("noMatches");
						return;
					}
					results.appendChild(
						element(
							"div",
							{ font: `11px/1.7 ${FONTS.ui}`, color: COLORS.muted },
							total > models.length
								? text("shownOfRefine", { shown: models.length, total })
								: text("shownOf", { shown: models.length, total }),
						),
					);
					for (const model of models as PoolModel[]) {
						if (!model?.id) continue;
						const details = [
							model.contextLength
								? text("contextSuffix", { size: Math.round(model.contextLength / 1024) })
								: "",
							// Marked like the built-in section's highlighted rows, so a model that is
							// already enabled is recognisable without cross-checking the list above.
							selection.has(model.id) ? text("alreadyEnabled") : "",
						].filter(Boolean);
						results.appendChild(modelRow(model.id, model.name || model.id, details.join(" · ")));
					}
				})
				.catch((error: unknown) => {
					if (generation !== searchGeneration) return;
					results.replaceChildren();
					results.textContent = text("actionFailed", {
						action: text("search"),
						reason: String(error),
					});
					results.style.color = COLORS.bad;
				});
		};

		const searchButton = button(text("search"), search);
		style(searchButton, { marginTop: "6px" });
		box.appendChild(searchButton);

		// Typing searches on its own, like the built-in section. The button and Enter stay because
		// they cancel the pending debounce and go immediately, which is what a user who has
		// finished typing expects.
		field.addEventListener("input", () => {
			if (searchTimer !== undefined) clearTimeout(searchTimer);
			searchTimer = setTimeout(() => {
				searchTimer = undefined;
				search();
			}, SEARCH_DEBOUNCE_MS);
		});
		field.addEventListener("keydown", (event) => {
			if ((event as KeyboardEvent).key !== "Enter") return;
			if (searchTimer !== undefined) {
				clearTimeout(searchTimer);
				searchTimer = undefined;
			}
			search();
		});
	}

	async function refresh(): Promise<void> {
		const output = (await command("status")) as StatusOutput | undefined;
		if (!output || typeof output.authenticated !== "boolean") {
			account.textContent = text("noAccountInfo");
			return;
		}
		const first = lastStatus === undefined;
		// The saved list is adopted on first load and after a save. A refresh mid-edit keeps the
		// in-progress selection, so a background poll cannot discard what the user just ticked.
		const savedChanged =
			JSON.stringify(lastStatus?.enabledModels ?? []) !== JSON.stringify(output.enabledModels);
		lastStatus = output;
		if (first || savedChanged) selection = new Set(output.enabledModels ?? []);

		// A sign-out invalidates the balance shown for the previous account, and a fresh sign-in
		// must be allowed to auto-load one again. Clearing the cached text too: showing the
		// previous account's dollars after a sign-out would be wrong, not merely stale.
		if (!output.authenticated) {
			balanceLoaded = false;
			balanceText = undefined;
		}

		renderAccount(output);
		renderSignIn(output);
		renderBalance(output);
		renderModels(output);

		// Built on the first load, and again only when the language changed. Both own live user
		// state — a half-typed query and a scroll position — and `recommended-models` costs an
		// upstream call, so neither may be rebuilt by a poll tick. The checkbox states inside them
		// are kept in step by `syncModelRowChecks` instead.
		if (first || rebuildPersistentAreas) {
			rebuildPersistentAreas = false;
			renderRecommended();
			renderSearch();
		} else {
			syncModelRowChecks();
		}

		// Started after the render so the "waiting for the browser callback" hint is already on
		// screen before the first tick.
		syncSignInPoll(output);

		// Lets the host and any e2e test observe that the view reached a usable state.
		sdk.notify("cline-external.settings.ready", {
			authenticated: output.authenticated,
			enabledModelCount: output.enabledModelCount,
			browserAuth: output.browserAuth,
		});
	}

	/*
	 * Re-render when the host language changes.
	 *
	 * Required because text, unlike colour, cannot follow on its own: the `--nf-*` variables let
	 * the browser recolour this panel with no code here, but a string already in the DOM stays
	 * until something rewrites it. Without this subscription the panel would keep its old language
	 * until it was remounted, which reads as "the plugin ignored my language setting".
	 *
	 * The in-progress model selection survives: `refresh()` only adopts the saved list when it
	 * actually changed, so ticks the user has not saved yet are still there after the rebuild.
	 */
	sdk.i18n?.onChange(() => {
		rebuildPersistentAreas = true;
		void refresh().catch(() => {
			// A failed re-render leaves the previous language on screen, which is strictly better
			// than blanking the panel. The next successful refresh corrects it.
		});
	});

	refresh().catch((error: unknown) => {
		account.textContent = text("loadFailed", { reason: String(error) });
		account.style.color = COLORS.bad;
	});
})();
