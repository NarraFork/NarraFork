import {
	IconBrandCpp,
	IconBrandCSharp,
	IconBrandCss3,
	IconBrandDocker,
	IconBrandGit,
	IconBrandGolang,
	IconBrandHtml5,
	IconBrandJavascript,
	IconBrandPython,
	IconBrandReact,
	IconBrandRust,
	IconBrandTypescript,
	IconDatabase,
	IconFile,
	IconFileCode,
	IconFileMusic,
	IconFileText,
	IconFileTypePdf,
	IconFileZip,
	IconFolder,
	IconFolderOpen,
	IconMarkdown,
	IconMovie,
	IconPhoto,
	IconSettings,
	IconTerminal2,
} from "@tabler/icons-react";

const icons = {
	file: { component: IconFile, color: "gray" },
	typescript: { component: IconBrandTypescript, color: "blue" },
	javascript: { component: IconBrandJavascript, color: "yellow" },
	react: { component: IconBrandReact, color: "cyan" },
	python: { component: IconBrandPython, color: "yellow" },
	go: { component: IconBrandGolang, color: "cyan" },
	rust: { component: IconBrandRust, color: "orange" },
	cpp: { component: IconBrandCpp, color: "blue" },
	csharp: { component: IconBrandCSharp, color: "grape" },
	html: { component: IconBrandHtml5, color: "orange" },
	css: { component: IconBrandCss3, color: "blue" },
	docker: { component: IconBrandDocker, color: "blue" },
	git: { component: IconBrandGit, color: "orange" },
	markdown: { component: IconMarkdown, color: "blue" },
	config: { component: IconSettings, color: "gray" },
	database: { component: IconDatabase, color: "yellow" },
	shell: { component: IconTerminal2, color: "green" },
	code: { component: IconFileCode, color: "teal" },
	text: { component: IconFileText, color: "gray" },
	pdf: { component: IconFileTypePdf, color: "red" },
	archive: { component: IconFileZip, color: "orange" },
	audio: { component: IconFileMusic, color: "grape" },
	video: { component: IconMovie, color: "pink" },
	image: { component: IconPhoto, color: "violet" },
} as const;

export type FileIconKind = keyof typeof icons;

// VS Code's file icon themes separate fileNames and fileExtensions. Exact names
// win; compound extensions are tried longest-first. This panel has no language
// service, so unknown names fall back to the generic file rather than reading bytes.
const fileNames = new Map<string, FileIconKind>([
	["dockerfile", "docker"],
	["containerfile", "docker"],
	["compose.yml", "docker"],
	["compose.yaml", "docker"],
	["docker-compose.yml", "docker"],
	["docker-compose.yaml", "docker"],
	[".dockerignore", "docker"],
	[".gitignore", "git"],
	[".gitattributes", "git"],
	[".gitmodules", "git"],
	[".gitkeep", "git"],
	[".editorconfig", "config"],
	[".env", "config"],
	[".npmrc", "config"],
	[".prettierrc", "config"],
	[".eslintrc", "config"],
	["makefile", "shell"],
	["gnumakefile", "shell"],
	["justfile", "shell"],
	["license", "text"],
	["licence", "text"],
	["copying", "text"],
	["readme", "text"],
	["changelog", "text"],
	["bun.lock", "config"],
	["bun.lockb", "config"],
	["cargo.lock", "rust"],
	["go.mod", "go"],
	["go.sum", "go"],
]);

const fileExtensions = new Map<string, FileIconKind>();
function associate(kind: FileIconKind, extensions: string) {
	for (const extension of extensions.split(" ")) fileExtensions.set(extension, kind);
}
associate("typescript", "ts mts cts d.ts d.mts d.cts");
associate("javascript", "js mjs cjs");
associate("react", "tsx jsx");
associate("python", "py pyi pyw ipynb");
associate("go", "go");
associate("rust", "rs");
associate("cpp", "c h cc cpp cxx hpp hxx");
associate("csharp", "cs csx");
associate("html", "html htm");
associate("css", "css scss sass less");
associate("markdown", "md markdown mdx");
associate("config", "json jsonc json5 yaml yml toml ini cfg conf config env lock properties");
associate("database", "sql sqlite sqlite3 db");
associate("shell", "sh bash zsh fish ps1 bat cmd");
associate("code", "java kt kts swift rb php lua pl r vue svelte astro xml graphql gql proto");
associate("text", "txt log csv tsv rst tex");
associate("pdf", "pdf");
associate("archive", "zip tar gz tar.gz bz2 tar.bz2 xz tar.xz zst tar.zst tgz 7z rar");
associate("audio", "mp3 wav flac ogg m4a aac opus");
associate("video", "mp4 webm mov avi mkv m4v");
associate("image", "png jpg jpeg gif svg webp ico bmp tif tiff avif heic");

/** Pure name-based matching, case insensitive like VS Code's icon selectors. */
export function getFileIconKind(fileName: string): FileIconKind {
	const name = fileName.toLowerCase();
	const exact = fileNames.get(name);
	if (exact) return exact;
	if (name.startsWith(".env.")) return "config";
	if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return "docker";
	for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
		const kind = fileExtensions.get(name.slice(dot + 1));
		if (kind) return kind;
	}
	return "file";
}

export function FileTreeIcon({
	name,
	isDirectory,
	expanded = false,
}: {
	name: string;
	isDirectory: boolean;
	expanded?: boolean;
}) {
	const kind = isDirectory ? "folder" : getFileIconKind(name);
	const { component: Icon, color } = isDirectory
		? { component: expanded ? IconFolderOpen : IconFolder, color: "yellow" }
		: icons[getFileIconKind(name)];
	return (
		<Icon
			size={14}
			color={`var(--mantine-color-${color}-6)`}
			aria-hidden="true"
			data-file-icon={kind}
			style={{ flexShrink: 0 }}
		/>
	);
}
