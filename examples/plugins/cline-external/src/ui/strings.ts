/**
 * Panel copy, in the two languages the host ships.
 *
 * The dictionaries stay here because only this plugin knows its own copy. What it does not own
 * is deciding which language is active: `narrafork.i18n` reports the host's locale and applies
 * the host's fallback rules, so this file holds tables and nothing else. The panel never reads
 * `navigator.language` — that is the browser's language, which silently overrides the language
 * the user explicitly chose in the app.
 *
 * Wording is copied from the host's `settings` namespace deliberately — the point of this
 * panel is to be indistinguishable from the built-in Cline section, and paraphrasing would
 * show up as the two pages disagreeing about what the same button does. That is a one-time
 * human comparison; the host's translation keys are internal and are never read at runtime.
 */

/**
 * `en` is the source of truth for the key set; `zhCN` must cover it exactly.
 *
 * `Record<keyof typeof en, string>` turns a forgotten translation into a compile error, and
 * the `satisfies` on `en` keeps its literal keys instead of widening them to `string` (which
 * would make the constraint vacuous). The previous `Record<string, string>` pair compiled a
 * missing `zh-CN` entry and fell back to English at runtime — one English label among Chinese
 * ones reads as a deliberate choice, so nobody reports it.
 */
type Strings = Record<string, string>;

const en = {
	title: "Cline account",
	notSignedIn: "Not signed in.",
	signedIn: "Signed in",
	credentialsUnreadable: "Stored credentials are unreadable: {reason}. Sign out and sign in again.",
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
	signOutConfirm:
		"Sign out of Cline? The stored credentials are cleared; your model selection is kept.",
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
	modelsDesc:
		"Search the OpenRouter pool and add models; added models appear in the model list below.",
	refreshPool: "Refresh pool",
	add: "Add",
	added: "Added",
	addModel: "Add model",
	removeModel: "Remove model",
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
	nothingToImport: "Nothing to import.",
	noAccountInfo: "No account information available.",
	loadFailed: "Failed to load account: {reason}",
	actionDone: "{action} done.",
	actionFailed: "{action} failed: {reason}",
	actionBrowserSignIn: "Browser sign-in",
	actionCancelSignIn: "Cancel sign-in",
	actionImport: "Import credentials",
	actionSignOut: "Sign out",
	actionAddModel: "Add model",
	actionRemoveModel: "Remove model",
	actionRefreshPool: "Refresh pool",
	confirmTitle: "Confirm",
	confirmOk: "Confirm",
	confirmCancel: "Cancel",
	runtimeMissingTitle: "The Cline settings page could not start",
} satisfies Strings;

const zhCN: Record<keyof typeof en, string> = {
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
	signOutConfirm: "确定要登出 Cline 吗？存储的凭据会被清除，已选择的模型会保留。",
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
	modelsDesc: "搜索 OpenRouter 模型池并添加模型；添加的模型会出现在下方的模型列表中。",
	refreshPool: "刷新模型池",
	add: "添加",
	added: "已添加",
	addModel: "添加模型",
	removeModel: "移除模型",
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
	nothingToImport: "没有可导入的内容。",
	noAccountInfo: "暂无账号信息。",
	loadFailed: "加载账号失败：{reason}",
	actionDone: "{action}完成。",
	actionFailed: "{action}失败：{reason}",
	actionBrowserSignIn: "浏览器登录",
	actionCancelSignIn: "取消登录",
	actionImport: "导入凭据",
	actionSignOut: "登出",
	actionAddModel: "添加模型",
	actionRemoveModel: "移除模型",
	actionRefreshPool: "刷新模型池",
	confirmTitle: "确认",
	confirmOk: "确定",
	confirmCancel: "取消",
	runtimeMissingTitle: "Cline 设置页无法启动",
};

/** The tables in the shape the host SDK expects: locale tag → key → text. */
const TABLES: Record<string, Record<string, string>> = { en, "zh-CN": zhCN };

interface HostI18n {
	locale: string;
	t(tables: Record<string, Record<string, string>>, key: string, params?: unknown): string;
	onChange(listener: (locale: string) => void): () => void;
}

function hostI18n(): HostI18n | undefined {
	return (globalThis as { narrafork?: { i18n?: HostI18n } }).narrafork?.i18n;
}

/**
 * Look up a string, filling `{name}` placeholders.
 *
 * Delegates to the host, which owns both the active locale and the fallback rules. The local
 * branch below is only for a host too old to provide `i18n`.
 *
 * Resolved per call rather than against a table chosen at module load: the host reports language
 * changes while the panel is open, and a table captured once could never reflect them.
 */
export function t(key: keyof typeof en, params?: Record<string, string | number>): string {
	const host = hostI18n();
	if (host) return host.t(TABLES, key as string, params);
	return interpolate(en[key] ?? String(key), params);
}

/**
 * The host's active locale, for `Intl` formatters.
 *
 * Not `navigator.language`: that is the BROWSER's language, which is a different thing
 * from the language the user chose in this app. Reading it produces a panel whose text
 * is Chinese (via the host tables) while its dates read "2 hours ago" — the kind of
 * split that looks like a translation gap rather than a wrong locale source.
 *
 * Falls back to the browser only for a host too old to report a locale.
 */
export function activeLocale(): string {
	const host = hostI18n();
	if (host?.locale) return host.locale;
	return typeof navigator === "undefined" ? "en" : (navigator.language ?? "en");
}

/**
 * Subscribe to host language changes.
 *
 * Text cannot follow the host on its own — the `--nf-*` tokens let the browser recolour this
 * panel with no code here, but a string already committed to the DOM stays until React replaces
 * it. Returns a no-op unsubscribe on an older host so callers need no capability check.
 */
export function onLocaleChange(listener: (locale: string) => void): () => void {
	return hostI18n()?.onChange(listener) ?? (() => {});
}

function interpolate(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		name in params ? String(params[name]) : whole,
	);
}
