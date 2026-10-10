import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Copy-to-clipboard must go through `lib/clipboard.ts` so plain-HTTP private
 * deployments get the `execCommand` fallback. Mantine's CopyButton/useClipboard
 * and bare `navigator.clipboard.writeText` silently fail outside secure contexts.
 *
 * Exceptions: the two specialized modules that own binary / ClipboardItem paths
 * and their own fallbacks (`document-clipboard.ts`, `image-clipboard.ts`), and
 * the shared wrapper itself.
 */
const ALLOWED_CLIPBOARD_API_FILES = new Set([
	"frontend/lib/clipboard.ts",
	"frontend/components/narrator/content/document-clipboard.ts",
	"frontend/components/narrator/composer/image-clipboard.ts",
	// Test harness fixture, not product UI.
	"frontend/components/narrator/vlist/VListHarness.tsx",
]);

const ALLOWED_MANTINE_COPY_BUTTON_FILES = new Set<string>();

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git", "__tests__"]);

function listTsxFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIR_NAMES.has(entry)) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) listTsxFiles(full, acc);
		else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) acc.push(full);
	}
	return acc;
}

function relPosix(path: string): string {
	return path
		.split("\\")
		.join("/")
		.replace(/^.*\/frontend\//, "frontend/");
}

describe("clipboard usage is HTTP-safe", () => {
	const files = listTsxFiles(FRONTEND_ROOT).map((path) => ({
		rel: relPosix(path),
		src: readFileSync(path, "utf8"),
	}));

	test("no bare navigator.clipboard.writeText outside the wrapper", () => {
		const offenders = files
			.filter(({ rel, src }) => {
				if (ALLOWED_CLIPBOARD_API_FILES.has(rel)) return false;
				return /navigator\.clipboard\s*\.\s*writeText/.test(src);
			})
			.map(({ rel }) => rel);
		expect(offenders).toEqual([]);
	});

	test("no Mantine CopyButton import", () => {
		const offenders = files
			.filter(({ rel, src }) => {
				if (ALLOWED_MANTINE_COPY_BUTTON_FILES.has(rel)) return false;
				return /import\s*\{[^}]*\bCopyButton\b[^}]*\}\s*from\s*["']@mantine\/core["']/.test(src);
			})
			.map(({ rel }) => rel);
		expect(offenders).toEqual([]);
	});

	test("no Mantine useClipboard import", () => {
		const offenders = files
			.filter(({ src }) =>
				/import\s*\{[^}]*\buseClipboard\b[^}]*\}\s*from\s*["']@mantine\/hooks["']/.test(src),
			)
			.map(({ rel }) => rel);
		expect(offenders).toEqual([]);
	});

	test("copy helpers stay the single product entry for text clipboard", () => {
		const wrapper = files.find(({ rel }) => rel === "frontend/lib/clipboard.ts");
		expect(wrapper?.src).toContain("export async function copyTextToClipboard");
		expect(wrapper?.src).toContain("copyTextWithSelection");
		const hook = files.find(({ rel }) => rel === "frontend/hooks/useClipboard.ts");
		expect(hook?.src).toContain("copyTextToClipboard");
	});
});
