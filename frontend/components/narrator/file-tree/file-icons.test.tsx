import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTreeIcon, getFileIconKind } from "./file-icons";

describe("file icon associations", () => {
	it.each([
		["index.ts", "typescript"],
		["types.d.ts", "typescript"],
		["module.mts", "typescript"],
		["index.js", "javascript"],
		["App.tsx", "react"],
		["App.jsx", "react"],
		["script.py", "python"],
		["main.go", "go"],
		["main.rs", "rust"],
		["main.cpp", "cpp"],
		["Program.cs", "csharp"],
		["index.html", "html"],
		["styles.scss", "css"],
		["README.md", "markdown"],
		["settings.json", "config"],
		["config.yaml", "config"],
		["Cargo.toml", "config"],
		["schema.sql", "database"],
		["run.sh", "shell"],
		["App.vue", "code"],
		["notes.txt", "text"],
		["manual.pdf", "pdf"],
		["backup.tar.gz", "archive"],
		["song.mp3", "audio"],
		["clip.webm", "video"],
		["image.svg", "image"],
		["IMAGE.PNG", "image"],
		["image.png.ts", "typescript"],
		["unknown.xyz", "file"],
		["no-extension", "file"],
		[".unknown", "file"],
		["constructor", "file"],
		["toString", "file"],
	] as const)("%s resolves to %s", (name, kind) => {
		expect(getFileIconKind(name)).toBe(kind);
	});

	it.each([
		["Dockerfile", "docker"],
		["Dockerfile.dev", "docker"],
		["compose.yaml", "docker"],
		["docker-compose.yml", "docker"],
		[".dockerignore", "docker"],
		[".gitignore", "git"],
		[".gitattributes", "git"],
		[".env", "config"],
		[".env.local", "config"],
		[".editorconfig", "config"],
		["Makefile", "shell"],
		["LICENSE", "text"],
		["bun.lockb", "config"],
		["Cargo.lock", "rust"],
		["GO.MOD", "go"],
	] as const)("exact/special name %s takes priority (%s)", (name, kind) => {
		expect(getFileIconKind(name)).toBe(kind);
	});
});

describe("FileTreeIcon", () => {
	it("renders distinct language glyphs and theme colors without accessible noise", () => {
		const ts = renderToStaticMarkup(<FileTreeIcon name="index.ts" isDirectory={false} />);
		const js = renderToStaticMarkup(<FileTreeIcon name="index.js" isDirectory={false} />);
		expect(ts).toContain('data-file-icon="typescript"');
		expect(ts).toContain("icon-brand-typescript");
		expect(ts).toContain("var(--mantine-color-blue-6)");
		expect(ts).toContain('aria-hidden="true"');
		expect(js).toContain("icon-brand-javascript");
		expect(js).toContain("var(--mantine-color-yellow-6)");
	});

	it("uses folders even when their names resemble files and switches on expand", () => {
		const closed = renderToStaticMarkup(<FileTreeIcon name="src.ts" isDirectory />);
		const open = renderToStaticMarkup(<FileTreeIcon name="src.ts" isDirectory expanded />);
		expect(closed).toContain('data-file-icon="folder"');
		expect(closed).not.toContain("icon-folder-open");
		expect(open).toContain("icon-folder-open");
	});

	it("falls back to a generic file", () => {
		const html = renderToStaticMarkup(<FileTreeIcon name="unknown" isDirectory={false} />);
		expect(html).toContain('data-file-icon="file"');
	});
});
