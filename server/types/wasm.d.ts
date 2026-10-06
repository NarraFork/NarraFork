// Type declarations for .wasm file imports used with Bun's `import ... with { type: "file" }`
declare module "tree-sitter-bash/tree-sitter-bash.wasm" {
	const path: string;
	export default path;
}

declare module "web-tree-sitter/tree-sitter.wasm" {
	const path: string;
	export default path;
}

// build-info.ts is generated only after build:cross — declare it so the dynamic
// import in version.ts doesn't cause a type error during normal development.
declare module "@server/generated/build-info" {
	export const buildVersion: string;
	export const buildCommit: string;
}
