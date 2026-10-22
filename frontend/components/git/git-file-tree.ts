export interface GitFileTreeFileNode<TFile extends { path: string }> {
	type: "file";
	name: string;
	path: string;
	file: TFile;
}

export interface GitFileTreeDirectoryNode<TFile extends { path: string }> {
	type: "directory";
	name: string;
	path: string;
	fileCount: number;
	children: GitFileTreeNode<TFile>[];
}

export type GitFileTreeNode<TFile extends { path: string }> =
	| GitFileTreeFileNode<TFile>
	| GitFileTreeDirectoryNode<TFile>;

interface MutableDirectory<TFile extends { path: string }> {
	name: string;
	path: string;
	directories: Map<string, MutableDirectory<TFile>>;
	files: GitFileTreeFileNode<TFile>[];
}

function splitGitPath(path: string): string[] {
	const normalized = path
		.replaceAll("\\", "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^(?:\.\/)+/, "")
		.replace(/^\/+|\/+$/g, "");

	return normalized.split("/").filter(Boolean);
}

function compareNames(left: { name: string }, right: { name: string }): number {
	return left.name.localeCompare(right.name, undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

function finalizeDirectory<TFile extends { path: string }>(
	directory: MutableDirectory<TFile>,
): GitFileTreeDirectoryNode<TFile> {
	const directories = [...directory.directories.values()].map(finalizeDirectory).sort(compareNames);
	const files = [...directory.files].sort(compareNames);

	return {
		type: "directory",
		name: directory.name,
		path: directory.path,
		fileCount: directories.reduce((count, child) => count + child.fileCount, 0) + files.length,
		children: [...directories, ...files],
	};
}

/** Build a virtual directory tree from changed files without reading the worktree. */
export function buildGitFileTree<TFile extends { path: string }>(
	files: readonly TFile[],
): GitFileTreeNode<TFile>[] {
	const root: MutableDirectory<TFile> = {
		name: "",
		path: "",
		directories: new Map(),
		files: [],
	};

	for (const file of files) {
		const segments = splitGitPath(file.path);
		const fallbackName = file.path || "/";
		const fileName = segments.pop() ?? fallbackName;
		let parent = root;

		for (const segment of segments) {
			const directoryPath = parent.path ? `${parent.path}/${segment}` : segment;
			let directory = parent.directories.get(segment);
			if (!directory) {
				directory = {
					name: segment,
					path: directoryPath,
					directories: new Map(),
					files: [],
				};
				parent.directories.set(segment, directory);
			}
			parent = directory;
		}

		parent.files.push({
			type: "file",
			name: fileName,
			path: file.path,
			file,
		});
	}

	const finalizedRoot = finalizeDirectory(root);
	return finalizedRoot.children;
}

/**
 * Merge single-child directory chains into one row (`src/components/chapter`), the
 * way editors' "compact folders" mode does. Keeps deep paths from spending one
 * row per level in a short scroll area. The merged row keeps the deepest path so
 * folder-level actions still cover exactly its files.
 */
export function compactGitFileTree<TFile extends { path: string }>(
	nodes: readonly GitFileTreeNode<TFile>[],
): GitFileTreeNode<TFile>[] {
	return nodes.map((node) => {
		if (node.type === "file") return node;

		let deepest = node;
		let name = node.name;
		while (deepest.children.length === 1) {
			const onlyChild = deepest.children[0];
			if (!onlyChild || onlyChild.type !== "directory") break;
			name = `${name}/${onlyChild.name}`;
			deepest = onlyChild;
		}

		return {
			type: "directory",
			name,
			path: deepest.path,
			fileCount: deepest.fileCount,
			children: compactGitFileTree(deepest.children),
		};
	});
}
