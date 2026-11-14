/**
 * Fails when a colour is written as a literal outside the design-token palette.
 *
 * The rule this enforces: every colour in `frontend/` comes from
 * `frontend/styles/tokens.css` (or, for third-party surface palettes such as terminals and
 * syntax highlighting, from one of the allowlisted colour-source modules listed below with
 * a reason). Without the check, a token layer decays one inline `style={{ color: "#..." }}`
 * at a time, and the decay is invisible in review because each individual change looks fine.
 *
 * Run with `bun scripts/check-style-tokens.ts`. Wired into CI next to `biome check`.
 *
 * Two deliberate escapes:
 * - `var(--x, #fallback)` is allowed. Those fallbacks only apply when the variable is
 *   undefined (a foreign document, a plugin iframe, a pre-hydration paint); forcing them to
 *   be variables too would make them useless.
 * - `fontSize: <number>` only warns. The existing inline font sizes predate this check and
 *   are migrated with the typography pass; failing the build on day one would block every
 *   unrelated PR. Bump `FONT_SIZE_IS_AN_ERROR` once that migration lands.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const FRONTEND = join(import.meta.dir, "..", "frontend");
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REPORTED = 60;
const FONT_SIZE_IS_AN_ERROR = false;

/**
 * Files that legitimately own colour values. Every entry needs a reason: an allowlist that
 * grows without justification is the same as having no check at all.
 */
const ALLOWED: ReadonlyArray<{ path: string; reason: string }> = [
	{ path: "styles/tokens.css", reason: "the palette itself" },
	{ path: "lib/mantine-theme.ts", reason: "Mantine palette consumed by tokens.css" },
	{
		path: "lib/palette-presets.ts",
		reason: "default palette mirrors tokens.css; presets are literal by design",
	},
	{ path: "styles/oled.css", reason: "alternative scheme: overrides --mantine-color-body" },
	{ path: "styles/scrollbars.css", reason: "var(--x, fallback) only" },
	{ path: "components/terminal/", reason: "terminal palettes and chrome are content" },
	{ path: "lib/struct-view-tokens.ts", reason: "syntax-highlight palette is content" },
	{ path: "components/narrator/file-editor/MonacoEditor.tsx", reason: "editor theme is content" },
	{ path: "components/settings/DependencyInstallTerminal.tsx", reason: "xterm theme is content" },
	{ path: "components/git/git-graph-layout.ts", reason: "graph lane palette is data" },
	{ path: "components/settings/BrandingSection.tsx", reason: "user-chosen brand colours" },
	{ path: "lib/favicon.ts", reason: "static icon asset, not themed" },
	{ path: "lib/qr.ts", reason: "QR codes are fixed black/white" },
	{ path: "index.html", reason: "theme-color meta cannot read CSS variables" },
	{ path: "vite.config.ts", reason: "PWA manifest colours cannot read CSS variables" },
	{ path: "hooks/useAuthenticatedAppearance.ts", reason: "theme-color meta (same reason)" },
	{ path: "components/plugins/asset-shell.ts", reason: "plugin iframe splash fallbacks" },
	{
		path: "components/narrator/markdown/MermaidDiagram.tsx",
		reason: "PNG export fallback when the variable is unset",
	},
	{
		path: "components/narrator/message/MediaAttachment.tsx",
		reason: "media letterbox is a fixed viewing surface in both schemes",
	},
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const SOURCE_EXTENSIONS = [".css", ".ts", ".tsx"];

function isSkippedFile(absPath: string): boolean {
	const base = absPath.slice(absPath.lastIndexOf("/") + 1);
	return (
		base.includes(".test.") ||
		base.includes(".browser.") ||
		base.endsWith(".gen.ts") ||
		base.includes("fixture") ||
		absPath.includes("/__tests__/")
	);
}

function relPath(absPath: string): string {
	return relative(FRONTEND, absPath).split("\\").join("/");
}

/** An entry ending in "/" allows the whole directory. */
function isAllowedPath(rel: string): boolean {
	return ALLOWED.some((entry) =>
		entry.path.endsWith("/") ? rel.startsWith(entry.path) : rel === entry.path,
	);
}

/**
 * Remove comments so that prose such as "React #185" or a `#123` issue reference is not
 * mistaken for a colour. String literals are preserved, since colours live in them.
 */
function stripComments(source: string): string {
	let out = "";
	let i = 0;
	let quote: string | null = null;
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (quote) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out += ch;
			i += 1;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
			i += 2;
			out += " ";
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/** `var(--x, #abc)` fallbacks are legal; a bare literal is not. */
function isInsideVarFallback(text: string, index: number): boolean {
	const windowStart = Math.max(0, index - 200);
	const before = text.slice(windowStart, index);
	const lastVar = before.lastIndexOf("var(");
	if (lastVar === -1) return false;
	const lastClose = before.lastIndexOf(")");
	return lastVar > lastClose;
}

const HEX_PATTERN = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

interface Issue {
	file: string;
	line: number;
	text: string;
}

async function walk(dir: string, files: string[]): Promise<void> {
	if (files.length >= MAX_FILES) return;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (files.length >= MAX_FILES) return;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await walk(abs, files);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
		if (isSkippedFile(abs)) continue;
		files.push(abs);
	}
}

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
	return line;
}

/**
 * Contrast floors, checked against the palette values declared in tokens.css.
 *
 * These are the numbers the token layer promises, so they belong to the same gate as the
 * "no stray colours" rule: a palette edit that quietly drops body text below AA is exactly
 * the regression nobody notices in review.
 */
const CONTRAST_PAIRS: ReadonlyArray<{
	label: string;
	fg: string;
	bg: string;
	min: number;
}> = [
	{ label: "dark body text", fg: "--nf-ink-100", bg: "--nf-ink-900", min: 4.5 },
	{ label: "dark muted text", fg: "--nf-ink-300", bg: "--nf-ink-900", min: 4.5 },
	{ label: "dark control border", fg: "--nf-ink-600", bg: "--nf-ink-900", min: 3 },
	{
		label: "dark primary fill vs white label",
		fg: "--nf-on-solid",
		bg: "--nf-action-fill-dark",
		min: 4.5,
	},
	{ label: "dark live indicator", fg: "--nf-live-graphic-dark", bg: "--nf-ink-900", min: 3 },
	{ label: "dark wait indicator", fg: "--nf-wait-graphic-dark", bg: "--nf-ink-900", min: 3 },
	{
		label: "dark attention indicator",
		fg: "--nf-attention-graphic-dark",
		bg: "--nf-ink-900",
		min: 3,
	},
	{ label: "dark danger indicator", fg: "--nf-danger-graphic-dark", bg: "--nf-ink-900", min: 3 },
	{ label: "light body text", fg: "--nf-paper-900", bg: "--nf-paper-0", min: 4.5 },
	{ label: "light muted text", fg: "--nf-paper-600", bg: "--nf-paper-0", min: 4.5 },
	// Token-level only: Mantine's *rendered* light-scheme borders still come from its
	// gray-4 ramp (1.51:1) until the components-level pass; see the plan's known gaps.
	{ label: "light line-strong token", fg: "--nf-paper-500", bg: "--nf-paper-0", min: 3 },
	{
		label: "light primary fill vs white label",
		fg: "--nf-on-solid",
		bg: "--nf-action-fill-light",
		min: 4.5,
	},
	{ label: "light live text", fg: "--nf-live-text-light", bg: "--nf-paper-0", min: 4.5 },
];

function channelLuminance(hex: string): number {
	const value = hex.trim().replace("#", "");
	const full =
		value.length === 3
			? value
					.split("")
					.map((c) => c + c)
					.join("")
			: value;
	const [r, g, b] = [0, 2, 4].map(
		(offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255,
	);
	const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: string, b: string): number {
	const la = channelLuminance(a);
	const lb = channelLuminance(b);
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

async function checkContrast(): Promise<Issue[]> {
	const failures: Issue[] = [];
	const tokensCss = await readFile(join(FRONTEND, "styles", "tokens.css"), "utf8");
	const palette = new Map<string, string>();
	for (const match of tokensCss.matchAll(/(--nf-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
		palette.set(match[1], match[2]);
	}
	for (const pair of CONTRAST_PAIRS) {
		const fg = palette.get(pair.fg);
		const bg = palette.get(pair.bg);
		if (!fg || !bg) {
			failures.push({
				file: "styles/tokens.css",
				line: 0,
				text: `missing ${pair.fg} or ${pair.bg} for ${pair.label}`,
			});
			continue;
		}
		const ratio = contrastRatio(fg, bg);
		if (ratio < pair.min) {
			failures.push({
				file: "styles/tokens.css",
				line: 0,
				text: `${pair.label}: ${ratio.toFixed(2)}:1 < ${pair.min}:1 (${fg} on ${bg})`,
			});
		}
	}
	return failures;
}

const colorIssues: Issue[] = [];
const fontSizeIssues: Issue[] = [];

const files: string[] = [];
await walk(FRONTEND, files);

for (const abs of files) {
	const rel = relPath(abs);
	const raw = await readFile(abs, "utf8");
	if (raw.length > MAX_FILE_BYTES) continue;
	const text = stripComments(raw);

	const isAllowed = isAllowedPath(rel);

	if (!isAllowed) {
		HEX_PATTERN.lastIndex = 0;
		for (let match = HEX_PATTERN.exec(text); match; match = HEX_PATTERN.exec(text)) {
			const index = match.index;
			const before = text.slice(Math.max(0, index - 8), index);
			if (before.endsWith("&") || before.endsWith("url(")) continue;
			if (isInsideVarFallback(text, index)) continue;
			colorIssues.push({
				file: rel,
				line: lineAt(text, index),
				text: match[0],
			});
		}
	}

	// Typography: inline numeric font sizes should use Mantine's scale. Warning-level.
	const FONT_SIZE = /fontSize:\s*(\d+)/g;
	for (let match = FONT_SIZE.exec(text); match; match = FONT_SIZE.exec(text)) {
		if (match[1] === "0") continue;
		fontSizeIssues.push({ file: rel, line: lineAt(text, match.index), text: match[0] });
	}
}

function report(title: string, issues: Issue[]): void {
	if (issues.length === 0) return;
	console.log(`\n${title} (${issues.length})`);
	for (const issue of issues.slice(0, MAX_REPORTED)) {
		console.log(`  ${issue.file}:${issue.line}  ${issue.text}`);
	}
	if (issues.length > MAX_REPORTED) {
		console.log(`  … and ${issues.length - MAX_REPORTED} more`);
	}
}

const fontSizeAsError = FONT_SIZE_IS_AN_ERROR && fontSizeIssues.length > 0;

report("Hard-coded colours outside the token palette", colorIssues);
report("Inline numeric font sizes (warning)", fontSizeIssues);

if (colorIssues.length > 0) {
	console.log(
		"\nColours must come from frontend/styles/tokens.css (or an allowlisted colour source).\n" +
			"Add a semantic token there and reference it, or add an allowlist entry in\n" +
			"scripts/check-style-tokens.ts with a reason.",
	);
}

const contrastIssues = await checkContrast();
if (contrastIssues.length > 0) {
	console.log(`\nContrast below the agreed floor (${contrastIssues.length})`);
	for (const issue of contrastIssues) console.log(`  ${issue.text}`);
}

const failed = colorIssues.length > 0 || contrastIssues.length > 0 || fontSizeAsError;
if (failed) process.exit(1);
console.log(
	`\nstyle tokens: ok (${files.length} files scanned, ${fontSizeIssues.length} font-size warnings)`,
);
