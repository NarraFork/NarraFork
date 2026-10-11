/** Additive native path protocol. Never use this descriptor to rewrite legacy history IDs. */
export const NATIVE_PATH_RESOLVE_FEATURE = "fs.path.resolve.v2";
export const NATIVE_PATH_BODY_MAX_BYTES = 64 * 1024;
// UTF-16 Windows native path ceiling; the RPC body imposes a separate UTF-8 bound.
export const NATIVE_PATH_MAX_CODE_UNITS = 32767;

export type WindowsPathKind =
	| "drive-absolute"
	| "unc-absolute"
	| "extended-drive-absolute"
	| "extended-unc-absolute"
	| "drive-relative"
	| "root-relative"
	| "relative";
export type NativePathOperation = "existing" | "create" | "remove";
export interface NativeObjectIdentityV2 {
	volumeId: string;
	fileId: string;
	/** Native creation time, decimal integer, not a JS timestamp. */
	creationTime: string;
}
export interface NativePathAncestorV2 {
	canonicalPath: string;
	object: NativeObjectIdentityV2;
	caseSensitive: boolean;
}
export interface NativePathDescriptorV2 {
	version: 2;
	platform: "windows";
	/** Native path slot, not object identity. Components obey each parent directory's case flag. */
	pathSlotKey: string;
	/** One key per native component. Never derived by globally lowercasing a path. */
	componentKeys: string[];
	volumeId: string;
	/** Root-to-parent chain; final object is deliberately separate. */
	ancestors: NativePathAncestorV2[];
	parent: NativePathAncestorV2;
	missingSuffix: string[];
	object?: NativeObjectIdentityV2;
	/** A directory's own case mode, when the final object is a directory. */
	caseSensitive?: boolean;
}
export interface ResolveNativePathV2Request {
	inputPath: string;
	baseCwd: string;
	operation: NativePathOperation;
	expectedDescriptor?: NativePathDescriptorV2;
	/** Original root containment, never an exact-target substitute. */
	expectedRootDescriptor?: NativePathDescriptorV2;
}
export interface ResolveNativePathV2Result {
	lexicalPath: string;
	canonicalPath: string;
	exists: boolean;
	inputKind: WindowsPathKind;
	nativeDescriptor: NativePathDescriptorV2;
}

function invalid(reason: string): never {
	throw new Error(`INVALID_WINDOWS_PATH: ${reason}`);
}

/** No trim, Unicode normalization, FS access, process cwd, or per-drive cwd lookup. */
export function classifyWindowsPath(path: string): WindowsPathKind {
	const p = path.replaceAll("/", "\\");
	if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/iu.test(p)) return "extended-unc-absolute";
	if (/^\\\\\?\\[a-z]:\\/iu.test(p)) return "extended-drive-absolute";
	if (
		p.startsWith("\\\\?\\") ||
		p.startsWith("\\\\.\\") ||
		p.startsWith("\\??\\") ||
		/^\\(?:Device|DosDevices|GLOBALROOT|GLOBAL\?\?)(?:\\|$)/iu.test(p)
	) {
		return invalid("device namespaces are not ordinary file paths");
	}
	if (/^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(p)) return "unc-absolute";
	if (p.startsWith("\\\\")) return invalid("UNC requires a server and share");
	if (/^[a-z]:\\/iu.test(p)) return "drive-absolute";
	if (/^[a-z]:/iu.test(p)) return "drive-relative";
	if (p.startsWith("\\")) return "root-relative";
	return "relative";
}

export function isFullyQualifiedWindowsPath(path: string): boolean {
	try {
		return classifyWindowsPath(path).endsWith("absolute");
	} catch {
		return false;
	}
}

function containsInvalidControl(path: string): boolean {
	for (const character of path) {
		const code = character.codePointAt(0) as number;
		if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) return true;
	}
	return false;
}

/** Validate a file-path slot, not a Glob pattern. Extended names are deliberately whitelist-only. */
export function validateWindowsPath(path: string): WindowsPathKind {
	if (!path || path.length > NATIVE_PATH_MAX_CODE_UNITS) invalid("empty or oversized path");
	if (containsInvalidControl(path)) invalid("NUL/control character");
	const kind = classifyWindowsPath(path);
	const p = path.replaceAll("/", "\\");
	const extended = kind.startsWith("extended-");
	if (kind === "unc-absolute" || kind === "extended-unc-absolute") {
		const roots = p
			.slice(extended ? 8 : 2)
			.split("\\")
			.slice(0, 2);
		if (roots.some((component) => component === "." || component === ".."))
			invalid("UNC server/share cannot be dot components");
	}
	if (extended && path.includes("/")) invalid("extended paths require native separators");
	let rest = p;
	if (kind === "extended-drive-absolute") rest = p.slice(7);
	else if (kind === "extended-unc-absolute") rest = p.slice(8);
	else if (kind.startsWith("drive-")) rest = p.slice(2);
	for (const component of rest.split("\\")) {
		if (!component) continue;
		if (component === "." || component === "..") {
			if (extended) invalid("extended dot components have ambiguous literal semantics");
			continue;
		}
		if (/[<>:"|?*]/u.test(component)) invalid("ADS, wildcard, or reserved character");
		if (/[ .]$/u.test(component)) invalid("trailing dot/space aliases are not supported");
		const stem = component.split(".", 1)[0].replace(/ +$/u, "");
		if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(stem)) {
			invalid("reserved device name");
		}
	}
	return kind;
}

function windowsRoot(path: string): { root: string; suffix: string } {
	const p = path.replaceAll("/", "\\");
	const match =
		/^(\\\\\?\\UNC\\[^\\]+\\[^\\]+\\?|\\\\\?\\[a-z]:\\|\\\\[^\\]+\\[^\\]+\\?|[a-z]:\\)/iu.exec(p);
	if (!match) invalid("baseCwd must be fully qualified");
	const root = match[0].endsWith("\\") ? match[0] : `${match[0]}\\`;
	return { root, suffix: p.slice(match[0].length) };
}

/** Pure target lexical freezing; the executor must still resolve the actual native descriptor. */
export function resolveWindowsPath(baseCwd: string, inputPath: string): string {
	const kind = validateWindowsPath(inputPath);
	let root: string;
	let suffix: string;
	const p = inputPath.replaceAll("/", "\\");
	if (kind.endsWith("absolute")) {
		// A fully qualified target already names its volume/share. Do not require
		// an inferred device cwd (or accidentally consult the controller's cwd).
		const absolute = windowsRoot(inputPath);
		root = absolute.root;
		suffix = absolute.suffix;
	} else {
		if (!isFullyQualifiedWindowsPath(baseCwd)) invalid("baseCwd must be fully qualified");
		validateWindowsPath(baseCwd);
		const base = windowsRoot(baseCwd);
		root = base.root;
		if (kind === "drive-relative") {
			const baseDrive = /^(?:\\\\\?\\)?([a-z]:)\\/iu.exec(root)?.[1];
			if (!baseDrive || baseDrive.toUpperCase() !== p.slice(0, 2).toUpperCase()) {
				throw new Error("AMBIGUOUS_DRIVE_RELATIVE: use a fully qualified path for another drive");
			}
			suffix = `${base.suffix}\\${p.slice(2)}`;
		} else if (kind === "root-relative") suffix = p.replace(/^\\+/u, "");
		else suffix = `${base.suffix}\\${p}`;
	}
	const parts: string[] = [];
	for (const component of suffix.split("\\")) {
		if (!component || component === ".") continue;
		if (component === "..") parts.pop();
		else parts.push(component);
	}
	const result = root + parts.join("\\");
	validateWindowsPath(result);
	return result;
}

/** Strict wire validation: absent native information is never filled from current state. */
export function validateNativePathDescriptorV2(
	value: unknown,
): asserts value is NativePathDescriptorV2 {
	const fail = (): never => {
		throw new Error("INVALID_NATIVE_PATH_DESCRIPTOR_V2");
	};
	const record = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
		if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
		const item = input as Record<string, unknown>;
		if (Object.keys(item).some((key) => !keys.includes(key))) return fail();
		return item;
	};
	const text = (input: unknown, max = NATIVE_PATH_MAX_CODE_UNITS): string => {
		if (typeof input !== "string" || !input || input.length > max || containsInvalidControl(input))
			return fail();
		return input;
	};
	const object = (input: unknown): NativeObjectIdentityV2 => {
		const item = record(input, ["volumeId", "fileId", "creationTime"]);
		text(item.volumeId, 256);
		if (
			!/^[a-f0-9]{32}$/u.test(text(item.fileId, 32)) ||
			!/^[0-9]{1,20}$/u.test(text(item.creationTime, 20))
		)
			return fail();
		return item as unknown as NativeObjectIdentityV2;
	};
	const ancestor = (input: unknown): NativePathAncestorV2 => {
		const item = record(input, ["canonicalPath", "object", "caseSensitive"]);
		if (
			!isFullyQualifiedWindowsPath(text(item.canonicalPath)) ||
			typeof item.caseSensitive !== "boolean"
		)
			return fail();
		validateWindowsPath(item.canonicalPath as string);
		object(item.object);
		return item as unknown as NativePathAncestorV2;
	};
	let body: string;
	try {
		body = JSON.stringify(value);
	} catch {
		return fail();
	}
	if (
		typeof body !== "string" ||
		new TextEncoder().encode(body).byteLength > NATIVE_PATH_BODY_MAX_BYTES
	)
		return fail();
	const item = record(value, [
		"version",
		"platform",
		"pathSlotKey",
		"componentKeys",
		"volumeId",
		"ancestors",
		"parent",
		"missingSuffix",
		"object",
		"caseSensitive",
	]);
	if (
		item.version !== 2 ||
		item.platform !== "windows" ||
		!/^[a-f0-9]{64}$/u.test(text(item.pathSlotKey, 64))
	)
		return fail();
	const volume = text(item.volumeId, 256);
	if (
		!Array.isArray(item.componentKeys) ||
		!item.componentKeys.length ||
		item.componentKeys.length > 512
	)
		return fail();
	for (const key of item.componentKeys) text(key);
	if (!Array.isArray(item.ancestors) || !item.ancestors.length || item.ancestors.length > 256)
		return fail();
	for (const entry of item.ancestors) if (ancestor(entry).object.volumeId !== volume) return fail();
	const parent = ancestor(item.parent);
	const last = ancestor(item.ancestors[item.ancestors.length - 1]);
	if (
		parent.object.volumeId !== volume ||
		!nativeObjectEquals(parent.object, last.object) ||
		parent.canonicalPath !== last.canonicalPath ||
		parent.caseSensitive !== last.caseSensitive
	)
		return fail();
	if (!Array.isArray(item.missingSuffix) || item.missingSuffix.length > 256) return fail();
	for (const part of item.missingSuffix) {
		const name = text(part);
		if (name.includes("/") || name.includes("\\") || name === "." || name === "..") return fail();
		if (validateWindowsPath(name) !== "relative") return fail();
	}
	if (item.object !== undefined && object(item.object).volumeId !== volume) return fail();
	if (item.object === undefined ? !item.missingSuffix.length : item.missingSuffix.length !== 0)
		return fail();
	if (item.caseSensitive !== undefined && (typeof item.caseSensitive !== "boolean" || !item.object))
		return fail();
}

export function nativeObjectEquals(a: NativeObjectIdentityV2, b: NativeObjectIdentityV2): boolean {
	return a.volumeId === b.volumeId && a.fileId === b.fileId && a.creationTime === b.creationTime;
}

/** Requires both a native slot prefix and the original root incarnation in the parent chain. */
export function nativePathContains(
	parent: NativePathDescriptorV2,
	child: NativePathDescriptorV2,
): boolean {
	if (
		parent.volumeId !== child.volumeId ||
		parent.componentKeys.length > child.componentKeys.length
	)
		return false;
	if (!parent.componentKeys.every((key, i) => key === child.componentKeys[i])) return false;
	if (
		!parent.ancestors.every((entry, i) => {
			const observed = child.ancestors[i];
			return (
				observed &&
				entry.caseSensitive === observed.caseSensitive &&
				nativeObjectEquals(entry.object, observed.object)
			);
		})
	)
		return false;
	if (parent.caseSensitive !== undefined && parent.object) {
		const directory = child.ancestors.find((entry) =>
			nativeObjectEquals(entry.object, parent.object as NativeObjectIdentityV2),
		);
		if (directory && directory.caseSensitive !== parent.caseSensitive) return false;
	}
	if (!parent.object) {
		// A missing directory has no native lookup identity yet. Never widen an
		// allow through a guessed Unicode/volume case table for uncreated names.
		return (
			nativeObjectEquals(parent.parent.object, child.parent.object) &&
			parent.missingSuffix.every((part, i) => part === child.missingSuffix[i])
		);
	}
	return (
		nativePathEquals(parent, child) ||
		child.ancestors.some((entry) =>
			nativeObjectEquals(entry.object, parent.object as NativeObjectIdentityV2),
		)
	);
}

/** Conservative deny matching for an uncreated subtree; it is never an allow proof. */
export function nativePathDenyContains(
	root: NativePathDescriptorV2,
	child: NativePathDescriptorV2,
): boolean {
	if (root.object) return nativePathContains(root, child);
	if (
		root.volumeId !== child.volumeId ||
		!nativeObjectEquals(root.parent.object, child.parent.object) ||
		root.missingSuffix.length > child.missingSuffix.length
	)
		return false;
	if (
		!root.ancestors.every(
			(entry, i) =>
				child.ancestors[i] &&
				entry.caseSensitive === child.ancestors[i].caseSensitive &&
				nativeObjectEquals(entry.object, child.ancestors[i].object),
		)
	)
		return false;
	const a = root.missingSuffix[0];
	const b = child.missingSuffix[0];
	if (root.parent.caseSensitive) return a === b;
	// Only the immediate real parent's case mode is known. Do not predict case
	// flags for future directories, or use an OS Unicode table as a volume allow.
	if (a === b) return true;
	const ascii = (value: string) =>
		[...value].every((character) => (character.codePointAt(0) as number) < 128);
	if (!ascii(a) || !ascii(b)) return true;
	return a.toUpperCase() === b.toUpperCase();
}

export function nativePathEquals(a: NativePathDescriptorV2, b: NativePathDescriptorV2): boolean {
	return (
		a.pathSlotKey === b.pathSlotKey &&
		nativeObjectEquals(a.parent.object, b.parent.object) &&
		a.parent.caseSensitive === b.parent.caseSensitive &&
		a.caseSensitive === b.caseSensitive &&
		a.ancestors.length === b.ancestors.length &&
		a.ancestors.every(
			(entry, i) =>
				entry.caseSensitive === b.ancestors[i].caseSensitive &&
				nativeObjectEquals(entry.object, b.ancestors[i].object),
		) &&
		(a.object && b.object ? nativeObjectEquals(a.object, b.object) : !a.object && !b.object)
	);
}
