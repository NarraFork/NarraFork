/**
 * The page a browser sees while NarraFork starts.
 *
 * Self-contained (no bundle, fonts or other requests besides polling) so it renders even when the
 * frontend assets are what is broken. It polls `api/startup` relative to its `<base href>`, which
 * keeps it working behind a reverse-proxy prefix, and reloads into the app as soon as the answer
 * no longer comes from the startup page.
 */

import { STARTUP_STATUS_HEADER } from "../../../shared/startup-status";

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page, titled with the instance's display name: the Windows manager finds an open window by
 * that title, so a page titled "NarraFork" would get a second window opened next to it.
 */
export function startupPageHtml(brandName: string): string {
	const title = escapeHtml(brandName);
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root { color-scheme: light dark; --fg: #1f2330; --muted: #6b7080; --card: #fff; --bg: #f4f5f9;
	--accent: #5c6ac4; --danger: #c92a2a; --code: #eef0f6; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e8ef; --muted: #9096a8; --card: #1d2030;
	--bg: #13151f; --accent: #8c96f0; --danger: #ff8787; --code: #262a3d; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
	color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: min(560px, calc(100vw - 32px)); background: var(--card); border-radius: 12px;
	padding: 28px 32px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.08); }
h1 { margin: 0; font-size: 20px; }
.muted { color: var(--muted); font-size: 13px; }
.step { margin-top: 20px; display: flex; gap: 12px; align-items: center; }
.spinner { width: 18px; height: 18px; flex: none; border-radius: 50%; border: 2px solid var(--code);
	border-top-color: var(--accent); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.elapsed { color: var(--muted); font-variant-numeric: tabular-nums; }
.problem { margin-top: 20px; color: var(--danger); font-weight: 600; }
pre { margin: 12px 0 0; padding: 10px 12px; background: var(--code); border-radius: 8px;
	white-space: pre-wrap; word-break: break-all; font: 13px/1.5 ui-monospace, Consolas, monospace; }
button { margin-top: 8px; border: 0; border-radius: 6px; padding: 6px 12px; background: var(--accent);
	color: #fff; font: inherit; font-size: 13px; cursor: pointer; }
details { margin-top: 16px; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
	<h1>${title}</h1>
	<div class="muted" id="version"></div>
	<div id="progress">
		<div class="step">
			<div class="spinner"></div>
			<div><span id="step"></span> <span class="elapsed" id="elapsed"></span></div>
		</div>
		<p class="muted" id="hint" hidden></p>
	</div>
	<div id="problem" hidden>
		<div class="problem" id="message"></div>
		<p class="muted" id="stopped"></p>
		<div id="command-box" hidden>
			<pre id="command"></pre>
			<button type="button" id="copy"></button>
		</div>
		<details class="muted" id="detail-box" hidden><summary id="details"></summary><pre id="detail"></pre></details>
	</div>
</main>
<script>
(() => {
	const zh = /^zh/i.test(navigator.language || "");
	document.documentElement.lang = zh ? "zh-CN" : "en";
	const text = zh
		? {
			starting: "正在启动…",
			database: "正在准备数据库…",
			migrating: (c, t) => "正在升级数据库（" + c + "/" + t + "）…",
			hint: "数据库较大时可能需要几分钟，请不要关闭 NarraFork。",
			stopped: "NarraFork 已停止。处理完成后重新启动即可。",
			gone: "NarraFork 没有响应。",
			goneHint: "它可能已经退出。重新启动后，本页会自动进入 NarraFork。",
			copy: "复制命令", copied: "已复制", details: "详细信息",
		}
		: {
			starting: "Starting…",
			database: "Preparing the database…",
			migrating: (c, t) => "Upgrading the database (" + c + "/" + t + ")…",
			hint: "A large database can take a few minutes. Please keep NarraFork running.",
			stopped: "NarraFork has stopped. Start it again once this is resolved.",
			gone: "NarraFork is not responding.",
			goneHint: "It may have exited. Once it is started again, this page opens it.",
			copy: "Copy command", copied: "Copied", details: "Details",
		};
	const $ = (id) => document.getElementById(id);
	$("step").textContent = text.starting;
	$("hint").textContent = text.hint;
	$("stopped").textContent = text.stopped;
	$("copy").textContent = text.copy;
	$("details").textContent = text.details;
	let state;
	let clockOffset = 0;
	let unreachableSince = 0;
	const UNREACHABLE_MS = 15000;
	const tick = () => {
		if (!state || state.problem) return;
		const seconds = Math.round((Date.now() + clockOffset - state.stepStartedAt) / 1000);
		$("elapsed").textContent = seconds >= 3 ? seconds + "s" : "";
	};
	const stepText = (step) =>
		step && step.key === "migrating" ? text.migrating(step.current, step.total)
			: step && step.key === "database" ? text.database : text.starting;
	const render = (next) => {
		state = next;
		$("version").textContent = next.version ? "v" + next.version : "";
		$("step").textContent = stepText(next.step);
		$("hint").hidden = !next.step || next.step.key !== "migrating";
		const problem = next.problem;
		$("progress").hidden = !!problem;
		$("problem").hidden = !problem;
		if (!problem) return tick();
		$("message").textContent = zh ? problem.message.zh : problem.message.en;
		$("command").textContent = problem.command || "";
		$("command-box").hidden = !problem.command;
		$("detail").textContent = problem.detail || "";
		$("detail-box").hidden = !problem.detail;
	};
	$("copy").addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText($("command").textContent);
			$("copy").textContent = text.copied;
			setTimeout(() => ($("copy").textContent = text.copy), 1500);
		} catch {
			getSelection().selectAllChildren($("command"));
		}
	});
	const poll = async () => {
		try {
			const response = await fetch("api/startup", { cache: "no-store" });
			// NarraFork itself answering means it is up. A proxy's own 502/504 during the takeover
			// lacks the header too, and reloading onto it would strand the page there.
			if (!response.headers.has("${STARTUP_STATUS_HEADER}")) {
				if (response.status < 500) return location.reload();
				throw new Error("proxy error");
			}
			const next = await response.json();
			clockOffset = next.now - Date.now();
			unreachableSince = 0;
			render(next);
			if (next.problem) return;
		} catch {
			// The port is closed for a moment while the server takes it over from this page. Much
			// longer means the process is gone (killed, crashed, failed after the takeover).
			unreachableSince ||= Date.now();
			if (Date.now() - unreachableSince > UNREACHABLE_MS) {
				render({ ...state, problem: { message: { en: text.gone, zh: text.gone } } });
				$("stopped").textContent = text.goneHint;
			}
		}
		setTimeout(poll, 1000);
	};
	setInterval(tick, 1000);
	poll();
})();
</script>
</body>
</html>
`;
}
