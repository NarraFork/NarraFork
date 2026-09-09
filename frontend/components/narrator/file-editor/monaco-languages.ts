import type { MonacoAPI } from "./monaco-loader";

// Explicit migration map: do not import Shiki's registry or Monaco's register.all.
// Each supported grammar is a separate lazy chunk; missing grammars are reported.
const loaders = {
	javascript: () => import("monaco-editor/languages/definitions/javascript/register"),
	typescript: () => import("monaco-editor/languages/definitions/typescript/register"),
	python: () => import("monaco-editor/languages/definitions/python/register"),
	markdown: () => import("monaco-editor/languages/definitions/markdown/register"),
	mdx: () => import("monaco-editor/languages/definitions/mdx/register"),
	css: () => import("monaco-editor/languages/definitions/css/register"),
	scss: () => import("monaco-editor/languages/definitions/scss/register"),
	less: () => import("monaco-editor/languages/definitions/less/register"),
	html: () => import("monaco-editor/languages/definitions/html/register"),
	xml: () => import("monaco-editor/languages/definitions/xml/register"),
	yaml: () => import("monaco-editor/languages/definitions/yaml/register"),
	shell: () => import("monaco-editor/languages/definitions/shell/register"),
	dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/register"),
	go: () => import("monaco-editor/languages/definitions/go/register"),
	rust: () => import("monaco-editor/languages/definitions/rust/register"),
	cpp: () => import("monaco-editor/languages/definitions/cpp/register"),
	csharp: () => import("monaco-editor/languages/definitions/csharp/register"),
	java: () => import("monaco-editor/languages/definitions/java/register"),
	kotlin: () => import("monaco-editor/languages/definitions/kotlin/register"),
	swift: () => import("monaco-editor/languages/definitions/swift/register"),
	ruby: () => import("monaco-editor/languages/definitions/ruby/register"),
	php: () => import("monaco-editor/languages/definitions/php/register"),
	sql: () => import("monaco-editor/languages/definitions/sql/register"),
	graphql: () => import("monaco-editor/languages/definitions/graphql/register"),
	ini: () => import("monaco-editor/languages/definitions/ini/register"),
	lua: () => import("monaco-editor/languages/definitions/lua/register"),
	powershell: () => import("monaco-editor/languages/definitions/powershell/register"),
	bat: () => import("monaco-editor/languages/definitions/bat/register"),
	hcl: () => import("monaco-editor/languages/definitions/hcl/register"),
	protobuf: () => import("monaco-editor/languages/definitions/protobuf/register"),
} satisfies Record<string, () => Promise<unknown>>;

const extensions: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	py: "python",
	pyw: "python",
	md: "markdown",
	markdown: "markdown",
	mdx: "mdx",
	json: "json",
	jsonc: "json",
	ipynb: "json",
	css: "css",
	scss: "scss",
	less: "less",
	html: "html",
	htm: "html",
	xml: "xml",
	svg: "xml",
	yaml: "yaml",
	yml: "yaml",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	conf: "shell",
	go: "go",
	rs: "rust",
	c: "cpp",
	h: "cpp",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	rb: "ruby",
	php: "php",
	sql: "sql",
	graphql: "graphql",
	gql: "graphql",
	ini: "ini",
	lua: "lua",
	ps1: "powershell",
	bat: "bat",
	cmd: "bat",
	tf: "hcl",
	hcl: "hcl",
	proto: "protobuf",
	txt: "plaintext",
	text: "plaintext",
	log: "plaintext",
	csv: "plaintext",
	tsv: "plaintext",
};
export interface MonacoLanguageStatus {
	language: string;
	languageSupported: boolean;
}
export function resolveMonacoLanguage(path: string): MonacoLanguageStatus {
	const name = path.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
	const language =
		name === "dockerfile" || name.startsWith("dockerfile.")
			? "dockerfile"
			: name === ".bashrc" || name === ".zshrc"
				? "shell"
				: extensions[name.split(".").pop() ?? ""];
	return { language: language ?? "plaintext", languageSupported: language !== undefined };
}

let jsonRegistered = false;
export async function loadMonacoLanguage(
	api: MonacoAPI,
	filePath: string,
): Promise<MonacoLanguageStatus> {
	const status = resolveMonacoLanguage(filePath);
	if (status.language === "json" && !jsonRegistered) {
		// JSON's stock feature registration starts diagnostics workers. Use Monarch only.
		api.languages.register({ id: "json" });
		api.languages.setMonarchTokensProvider("json", {
			defaultToken: "invalid",
			tokenizer: {
				root: [
					[/[{}[\]]/, "delimiter.bracket"],
					[/[:,]/, "delimiter"],
					[/\s+/, "white"],
					[/\/\*/, "comment", "@comment"],
					[/\/\/.*$/, "comment"],
					[/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key"],
					[/"/, "string", "@string"],
					[/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
					[/\b(?:true|false|null)\b/, "keyword"],
				],
				string: [
					[/[^"\\]+/, "string"],
					[/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/, "string.escape"],
					[/\\./, "invalid"],
					[/"/, "string", "@pop"],
				],
				comment: [
					[/[^/*]+/, "comment"],
					[/\*\//, "comment", "@pop"],
					[/[/*]/, "comment"],
				],
			},
		});
		api.languages.setLanguageConfiguration("json", {
			brackets: [
				["{", "}"],
				["[", "]"],
			],
		});
		jsonRegistered = true;
	} else if (Object.hasOwn(loaders, status.language)) {
		await loaders[status.language as keyof typeof loaders]();
	}
	return status;
}
