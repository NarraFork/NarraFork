import { posix, win32 } from "node:path";
import {
	isFullyQualifiedWindowsPath,
	type NativePathDescriptorV2,
	nativePathContains,
	nativePathDenyContains,
	nativePathEquals,
	resolveWindowsPath,
} from "@shared/target-native-path";

/** Path grammar used by an execution target, independent of the NarraFork host OS. */
export type PathFlavor = "posix" | "windows" | "spec";

/**
 * Pure lexical path operations for one target grammar.
 *
 * These helpers never touch the filesystem. Canonical filesystem identity is
 * resolved separately by ExecutionBackend.resolvePathIdentity().
 */
export interface TargetPathSemantics {
	readonly flavor: PathFlavor;
	/** Present only on a native authorization view, never on lexical helpers. */
	readonly nativeProofRequired?: boolean;
	nativeDescriptor?(path: string): NativePathDescriptorV2 | undefined;
	isAbsolute(path: string): boolean;
	normalize(path: string): string;
	resolve(base: string, path: string): string;
	dirname(path: string): string;
	basename(path: string): string;
	extname(path: string): string;
	relative(from: string, to: string): string;
	equals(left: string, right: string): boolean;
	contains(parent: string, child: string): boolean;
	/** Conservative deny matching; this must never be used to grant access. */
	containsDenied?(parent: string, child: string): boolean;
	/** Stable key for snapshots, policy caches, and path identity comparisons. */
	identityKey(path: string): string;
}

function createNodePathSemantics(flavor: "posix" | "windows"): TargetPathSemantics {
	const pathImpl = flavor === "windows" ? win32 : posix;
	const normalize = (path: string): string => {
		const normalized = pathImpl.normalize(path);
		// Drive letters are grammar, component case is native filesystem information.
		return flavor === "windows"
			? normalized.replace(/^(?:\\\\\?\\)?[a-z]:/iu, (drive) => drive.toUpperCase())
			: normalized;
	};
	const identityKey = normalize;
	return Object.freeze({
		flavor,
		isAbsolute: (path: string) =>
			flavor === "windows" ? isFullyQualifiedWindowsPath(path) : pathImpl.isAbsolute(path),
		normalize,
		resolve(base: string, path: string): string {
			if (flavor === "windows") return normalize(resolveWindowsPath(base, path));
			if (pathImpl.isAbsolute(path)) return normalize(path);
			return pathImpl.isAbsolute(base)
				? pathImpl.resolve(base, path)
				: pathImpl.normalize(pathImpl.join(base, path));
		},
		dirname: (path: string) => pathImpl.dirname(path),
		basename: (path: string) => pathImpl.basename(path),
		extname: (path: string) => pathImpl.extname(path),
		relative: (from: string, to: string) => pathImpl.relative(normalize(from), normalize(to)),
		equals: (left: string, right: string) => identityKey(left) === identityKey(right),
		contains(parent: string, child: string): boolean {
			const np = normalize(parent);
			const nc = normalize(child);
			if (flavor === "windows") {
				const prefix = np.endsWith("\\") ? np : `${np}\\`;
				return nc === np || nc.startsWith(prefix);
			}
			const relative = pathImpl.relative(np, nc);
			return relative === "" || (!relative.startsWith("..") && !pathImpl.isAbsolute(relative));
		},
		identityKey,
	});
}

const SPEC_PREFIX = "spec://";

function normalizeSpecPath(path: string): string {
	const raw = path.startsWith(SPEC_PREFIX) ? path.slice(SPEC_PREFIX.length) : path;
	const normalized = posix.normalize(`/${raw.replace(/^\/+/, "")}`).slice(1);
	return normalized === "." || normalized === "" ? SPEC_PREFIX : `${SPEC_PREFIX}${normalized}`;
}

/** Dynamic Spec URI semantics. spec:// is a case-sensitive, POSIX-like virtual root. */
export const specPathSemantics: TargetPathSemantics = Object.freeze({
	flavor: "spec",
	isAbsolute: (path: string) => path.startsWith(SPEC_PREFIX),
	normalize: normalizeSpecPath,
	resolve(base: string, path: string): string {
		if (path.startsWith(SPEC_PREFIX)) return normalizeSpecPath(path);
		const normalizedBase = normalizeSpecPath(base);
		const baseSuffix = normalizedBase.slice(SPEC_PREFIX.length);
		return normalizeSpecPath(posix.join(baseSuffix, path));
	},
	dirname(path: string): string {
		const normalized = normalizeSpecPath(path);
		if (normalized === SPEC_PREFIX) return SPEC_PREFIX;
		const suffix = normalized.slice(SPEC_PREFIX.length);
		const parent = posix.dirname(suffix);
		return parent === "." ? SPEC_PREFIX : normalizeSpecPath(parent);
	},
	basename: (path: string) => posix.basename(normalizeSpecPath(path).slice(SPEC_PREFIX.length)),
	extname: (path: string) => posix.extname(normalizeSpecPath(path).slice(SPEC_PREFIX.length)),
	relative(from: string, to: string): string {
		return posix.relative(
			normalizeSpecPath(from).slice(SPEC_PREFIX.length),
			normalizeSpecPath(to).slice(SPEC_PREFIX.length),
		);
	},
	equals: (left: string, right: string) => normalizeSpecPath(left) === normalizeSpecPath(right),
	contains(parent: string, child: string): boolean {
		const relative = this.relative(parent, child);
		return relative === "" || (!relative.startsWith("..") && !posix.isAbsolute(relative));
	},
	identityKey: normalizeSpecPath,
});

export const posixPathSemantics = createNodePathSemantics("posix");
export const windowsPathSemantics = createNodePathSemantics("windows");

/** Native authorization view. Missing native proofs cannot become Windows grants. */
export function withNativePathDescriptors(
	paths: TargetPathSemantics,
	lookup: (path: string) => NativePathDescriptorV2 | undefined,
): TargetPathSemantics {
	if (paths.flavor !== "windows") return paths;
	return Object.freeze({
		...paths,
		nativeProofRequired: true,
		nativeDescriptor: lookup,
		containsDenied(parent: string, child: string): boolean {
			const a = lookup(parent);
			const b = lookup(child);
			return !!a && !!b && nativePathDenyContains(a, b);
		},
		contains(parent: string, child: string): boolean {
			const a = lookup(parent);
			const b = lookup(child);
			return !!a && !!b && nativePathContains(a, b);
		},
		equals(left: string, right: string): boolean {
			const a = lookup(left);
			const b = lookup(right);
			return !!a && !!b && nativePathEquals(a, b);
		},
		identityKey(path: string): string {
			return lookup(path)?.pathSlotKey ?? paths.identityKey(path);
		},
	});
}

/** Stable singleton semantics for a requested target path flavor. */
export function targetPathSemantics(flavor: PathFlavor): TargetPathSemantics {
	if (flavor === "windows") return windowsPathSemantics;
	if (flavor === "spec") return specPathSemantics;
	return posixPathSemantics;
}

/** Path flavor for an execution platform descriptor. */
export function platformPathFlavor(os: string | undefined): Exclude<PathFlavor, "spec"> {
	return os === "windows" || os === "win32" ? "windows" : "posix";
}

/** Path semantics of the NarraFork server process. */
export const localPathSemantics = targetPathSemantics(platformPathFlavor(process.platform));
