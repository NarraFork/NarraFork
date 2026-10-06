import {
	type FileReferenceContext,
	type FileSelection,
	type FileTarget,
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
	MAX_FILE_REFERENCE_POSITION,
} from "./file-reference";

/**
 * DOM/OS/filesystem-independent parsing of explicit file-link destinations.
 * This does not infer paths from prose and never grants read authorization.
 */
const LOCAL_FILE_PREFIX = "#nf-local-file=";
const NF_FILE_PREFIX = "nf-file://open?";
// Percent encoding needs at most three characters per UTF-8 byte. Bound work
// before decoding/JSON parsing, independently of the decoded path limit.
const MAX_ENCODED_LENGTH = MAX_FILE_REFERENCE_METADATA_BYTES * 3;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const FILE_URI = /^file:\/\//i;
const CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const UNSAFE_PATH_CHARACTERS = /[<>"|?*`]/u;
const encoder = new TextEncoder();

export interface ParsedLocalFilePath {
	path: string;
	selection?: FileSelection;
	deviceId?: string;
}

// A bare word needs more evidence than an explicitly written ./path or link.
const BARE_EXTENSIONS = new Set(
	(
		"txt md markdown mdx rst adoc json jsonc jsonl yaml yml toml xml csv tsv ini cfg " +
		"conf env properties log lock ts tsx js jsx mjs cjs mts cts py pyi go rs java kt " +
		"kts scala clj cljs c h cpp cc cxx hpp cs fs fsx rb php swift m mm r jl lua pl pm " +
		"sh bash zsh fish ps1 bat cmd css scss sass less html htm vue svelte astro sql " +
		"graphql gql proto cmake tf hcl nix tex bib patch diff png jpg jpeg gif webp svg " +
		"ico bmp pdf zip gz tar tgz bz2 xz 7z wasm woff woff2 ttf otf mp3 mp4 wav webm " +
		"mov exe dll so dylib bin db sqlite sqlite3"
	).split(" "),
);
const COMMON_NAMES = new Set(
	(
		"readme license licence copying notice changelog changes authors contributing " +
		"makefile gnumakefile dockerfile containerfile gemfile rakefile procfile " +
		"vagrantfile justfile jenkinsfile brewfile taskfile .gitignore .gitattributes " +
		".gitmodules .dockerignore .containerignore .npmrc .npmignore .yarnrc " +
		".editorconfig .prettierrc .prettierignore .eslintrc .eslintignore .babelrc " +
		".browserslistrc .nvmrc .node-version .python-version .tool-versions"
	).split(" "),
);
const WEB_SUFFIXES = new Set(
	"com net org edu gov mil int io ai co dev app me us uk cn de fr jp info biz xyz online site tech cloud".split(
		" ",
	),
);

function withinMetadataBudget(value: string): boolean {
	return (
		value.length <= MAX_FILE_REFERENCE_METADATA_BYTES &&
		encoder.encode(value).byteLength <= MAX_FILE_REFERENCE_METADATA_BYTES
	);
}

function decodeOnce(value: string): string | null {
	if (value.length > MAX_ENCODED_LENGTH) return null;
	try {
		const decoded = decodeURIComponent(value);
		return withinMetadataBudget(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

function validPosition(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 1 &&
		value <= MAX_FILE_REFERENCE_POSITION
	);
}

function readSelection(value: unknown): FileSelection | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { startLineNumber, startColumn, endLineNumber, endColumn } = value as FileSelection;
	if (
		!validPosition(startLineNumber) ||
		!validPosition(startColumn) ||
		!validPosition(endLineNumber) ||
		!validPosition(endColumn) ||
		endLineNumber < startLineNumber ||
		(endLineNumber === startLineNumber && endColumn < startColumn)
	) {
		return null;
	}
	return { startLineNumber, startColumn, endLineNumber, endColumn };
}

function wholeLines(first: string, last = first): FileSelection | null {
	return readSelection({
		startLineNumber: Number(first),
		startColumn: 1,
		endLineNumber: Number(last) + 1,
		endColumn: 1,
	});
}

/** Split before URI decoding: an encoded # or : belongs to the filename. */
function splitLocation(value: string): ParsedLocalFilePath | null {
	const hash = value.indexOf("#");
	if (hash >= 0) {
		const match = /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(value.slice(hash));
		if (!match || (match[2] !== undefined && Number(match[2]) < Number(match[1]))) {
			return null;
		}
		const selection = wholeLines(match[1], match[2]);
		return selection ? { path: value.slice(0, hash), selection } : null;
	}
	const colon = value.indexOf(":", WINDOWS_ABSOLUTE.test(value) ? 2 : 0);
	if (colon < 0) return { path: value };
	const match = /^:([1-9]\d*)(?::([1-9]\d*))?(?:-([1-9]\d*)(?::([1-9]\d*))?)?$/u.exec(
		value.slice(colon),
	);
	if (!match) return null;
	const [, line, column, endLine, endColumn] = match;
	let selection: FileSelection | null;
	if (column === undefined) {
		if (endColumn !== undefined || (endLine !== undefined && Number(endLine) < Number(line))) {
			return null;
		}
		selection = wholeLines(line, endLine);
	} else {
		if ((endLine === undefined) !== (endColumn === undefined)) return null;
		selection = readSelection({
			startLineNumber: Number(line),
			startColumn: Number(column),
			endLineNumber: Number(endLine ?? line),
			endColumn: Number(endColumn ?? column),
		});
	}
	return selection ? { path: value.slice(0, colon), selection } : null;
}

function isCommonName(name: string): boolean {
	return (
		COMMON_NAMES.has(name.toLowerCase()) ||
		/^(?:\.env|dockerfile|containerfile)(?:\.[\p{L}\p{N}_-]+)*$/iu.test(name)
	);
}

function hasFileBasename(name: string, knownExtensionOnly: boolean): boolean {
	if (isCommonName(name)) return true;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return false;
	const extension = name.slice(dot + 1).toLowerCase();
	return (
		/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(extension) &&
		(!knownExtensionOnly || BARE_EXTENSIONS.has(extension))
	);
}

function looksLikeWebAddress(value: string): boolean {
	// ./example.com/a.ts is explicit; example.com/a.ts is ambiguous.
	if (/^(?:\.{1,2}|~)?[\\/]/u.test(value) || WINDOWS_ABSOLUTE.test(value)) return false;
	const separator = value.search(/[\\/]/u);
	const first = separator < 0 ? value : value.slice(0, separator);
	if (isCommonName(first)) return false;
	if (/^www\./i.test(first) || (first.includes("@") && !first.startsWith("@"))) return true;
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(first)) return true;
	const dot = first.lastIndexOf(".");
	return dot > 0 && WEB_SUFFIXES.has(first.slice(dot + 1).toLowerCase());
}

/** Never percent-decode a literal filesystem path. */
function isSafeLiteral(path: string): boolean {
	if (
		!path ||
		path.length > MAX_FILE_REFERENCE_PATH_CHARS ||
		path.trim() !== path ||
		CONTROLS.test(path) ||
		UNSAFE_PATH_CHARACTERS.test(path) ||
		path.startsWith("#") ||
		path.startsWith("//") ||
		path.startsWith("\\") ||
		path.startsWith("/\\") ||
		/^~[^\\/]+[\\/]/u.test(path)
	) {
		return false;
	}
	// Drive-qualified absolute paths are the only permitted colon-bearing paths.
	return !(WINDOWS_ABSOLUTE.test(path) ? path.slice(2) : path).includes(":");
}

function isFileLiteral(path: string, mode: "literal" | "link" | "target" = "literal"): boolean {
	if (!isSafeLiteral(path)) return false;
	const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	if (!basename || basename === "." || basename === "..") return false;
	if (mode === "target") return true;
	// Do not turn ordinary extensionless web routes (/knowledge/e1) into files.
	if (WINDOWS_ABSOLUTE.test(path) || (path.startsWith("/") && mode !== "link")) return true;
	if (looksLikeWebAddress(path)) return false;
	const hasSeparator = /[\\/]/u.test(path);
	if (!hasSeparator && (path === "console.log" || path === "process.env")) return false;
	return hasFileBasename(basename, !hasSeparator && mode !== "link");
}

function validDeviceId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_FILE_REFERENCE_METADATA_BYTES &&
		!CONTROLS.test(value) &&
		!/[\s]/u.test(value)
	);
}

function readTarget(value: unknown): ParsedLocalFilePath | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const item = value as ParsedLocalFilePath;
	if (typeof item.path !== "string" || !isFileLiteral(item.path, "target")) return null;
	if (item.deviceId !== undefined && !validDeviceId(item.deviceId)) return null;
	const selection = item.selection === undefined ? undefined : readSelection(item.selection);
	if (selection === null) return null;
	const target: ParsedLocalFilePath = { path: item.path };
	if (selection !== undefined) target.selection = selection;
	if (item.deviceId !== undefined) target.deviceId = item.deviceId;
	return withinMetadataBudget(JSON.stringify(target)) ? target : null;
}

function fileUriTarget(value: string): ParsedLocalFilePath | null {
	const slash = value.indexOf("/", 7);
	if (slash < 0) return null;
	const host = value.slice(7, slash);
	if (host && host.toLowerCase() !== "localhost") return null;
	const encoded = value.slice(slash);
	if (encoded.includes("\\") || encoded.includes("?")) return null;
	// A Windows URI starts /C:/, unlike a literal C:/ path.
	const location = splitLocation(/^\/[a-z]:\//i.test(encoded) ? encoded.slice(1) : encoded);
	if (!location) return null;
	const decoded = decodeOnce(location.path);
	if (decoded === null) return null;
	const path = /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded;
	return isFileLiteral(path) ? { ...location, path } : null;
}

function nfFileTarget(value: string): ParsedLocalFilePath | null {
	if (!value.startsWith(NF_FILE_PREFIX) || value.length > MAX_ENCODED_LENGTH) return null;
	if (CONTROLS.test(value)) return null;
	const hash = value.indexOf("#");
	const query = value.slice(NF_FILE_PREFIX.length, hash < 0 ? undefined : hash);
	const params = query.split("&");
	if (params.length !== 2) return null;
	let deviceId: string | undefined;
	let path: string | undefined;
	for (const param of params) {
		const equals = param.indexOf("=");
		if (equals < 0) return null;
		const name = param.slice(0, equals);
		const decoded = decodeOnce(param.slice(equals + 1).replace(/\+/g, " "));
		if (decoded === null) return null;
		if (name === "device" && deviceId === undefined) deviceId = decoded;
		else if (name === "path" && path === undefined) path = decoded;
		else return null;
	}
	if (!path || (!WINDOWS_ABSOLUTE.test(path) && !path.startsWith("/"))) return null;
	const location = hash < 0 ? { path } : splitLocation(`file${value.slice(hash)}`);
	if (!location || !validDeviceId(deviceId)) return null;
	return readTarget({ path, deviceId, selection: location.selection });
}

/** Entire inline-code/literal value, retaining both spelling and location. */
export function parseLocalFilePath(value: string): ParsedLocalFilePath | null {
	if (!value || value.length > MAX_ENCODED_LENGTH || CONTROLS.test(value)) return null;
	if (value.startsWith("`") && value.endsWith("`")) value = value.slice(1, -1);
	if (value.startsWith(NF_FILE_PREFIX)) return nfFileTarget(value);
	if (FILE_URI.test(value)) return fileUriTarget(value);
	const location = splitLocation(value);
	return location && isFileLiteral(location.path) ? location : null;
}

/** Legacy path-only adapter; new navigation must use parseLocalFilePath. */
export function localFilePath(value: string): string | null {
	return parseLocalFilePath(value)?.path ?? null;
}

/** Internal marker only, never browser file: navigation. Invalid input throws. */
export function localFileHref(target: string | ParsedLocalFilePath): string {
	const parsed = typeof target === "string" ? parseLocalFilePath(target) : readTarget(target);
	if (!parsed) throw new TypeError("Invalid or oversized local file target");
	const payload = typeof target === "string" ? target : JSON.stringify(parsed);
	if (!withinMetadataBudget(payload)) throw new RangeError("Local file metadata exceeds budget");
	return `${LOCAL_FILE_PREFIX}${encodeURIComponent(payload)}`;
}

/** Markers are intercepted even when malformed; nf-file must match the strict protocol. */
export function isLocalFileHref(href: string | undefined): boolean {
	return !!href && (href.startsWith(LOCAL_FILE_PREFIX) || nfFileTarget(href) !== null);
}

function parseHref(href: string | undefined): ParsedLocalFilePath | null {
	if (!href || href.length > MAX_ENCODED_LENGTH + LOCAL_FILE_PREFIX.length) return null;
	if (href.startsWith(LOCAL_FILE_PREFIX)) {
		const decoded = decodeOnce(href.slice(LOCAL_FILE_PREFIX.length));
		if (decoded === null) return null;
		if (decoded.startsWith("{")) {
			try {
				return readTarget(JSON.parse(decoded));
			} catch {
				return null;
			}
		}
		return parseLocalFilePath(decoded);
	}
	if (href.startsWith(NF_FILE_PREFIX)) return nfFileTarget(href);
	if (FILE_URI.test(href)) return parseLocalFilePath(href);
	if (href.startsWith("#") || CONTROLS.test(href) || href.includes("?")) return null;
	const location = splitLocation(href);
	if (!location || (URI_SCHEME.test(location.path) && !WINDOWS_ABSOLUTE.test(location.path))) {
		return null;
	}
	const decoded = decodeOnce(location.path);
	// A decoded scheme must not be reinterpreted as another URI.
	return decoded !== null && isFileLiteral(decoded, "link") ? { ...location, path: decoded } : null;
}

function validContext(context: FileReferenceContext | null | undefined): boolean {
	return (
		!!context &&
		validDeviceId(context.deviceId) &&
		typeof context.cwd === "string" &&
		normalizeAbsolute(context.cwd) !== null &&
		withinMetadataBudget(JSON.stringify({ deviceId: context.deviceId, cwd: context.cwd }))
	);
}

/** Bind only to explicit or captured devices; relative paths need a matching cwd. */
export function fileTargetFromHref(
	href: string | undefined,
	context?: FileReferenceContext | null,
): FileTarget | null {
	const parsed = parseHref(href);
	if (!parsed) return null;
	const explicitDevice = parsed.deviceId;
	const needsBase = !WINDOWS_ABSOLUTE.test(parsed.path) && !parsed.path.startsWith("/");
	if (
		(!explicitDevice || needsBase) &&
		(!validContext(context) || (explicitDevice && explicitDevice !== context?.deviceId))
	) {
		return null;
	}
	const deviceId = explicitDevice ?? context?.deviceId;
	if (!deviceId) return null;
	const path = resolveLiteral(parsed.path, context?.cwd);
	if (path === null) return null;
	const target: FileTarget = { deviceId, path };
	if (parsed.selection !== undefined) target.selection = parsed.selection;
	return withinMetadataBudget(JSON.stringify(target)) ? target : null;
}

/** Compatibility adapter with no device binding; never use it to open new targets. */
export function filePathFromHref(href: string | undefined): string | null {
	return parseHref(href)?.path ?? null;
}

/** Visible line range; selections use an exclusive end, unlike the displayed last line. */
export function fileSelectionLineSuffix(selection?: FileSelection): string {
	if (!selection) return "";
	const first = selection.startLineNumber;
	const last =
		selection.endColumn === 1 && selection.endLineNumber > first
			? selection.endLineNumber - 1
			: selection.endLineNumber;
	return `:${first}${last > first ? `-${last}` : ""}`;
}

/** Display metadata from an authored href only; this never infers a file from label text. */
export function fileLinkLineSuffix(href: string | undefined, label = ""): string {
	const target = parseHref(href);
	if (!target?.selection) return "";
	const suffix = fileSelectionLineSuffix(target.selection);
	const visible = label.trimEnd();
	// A filename can itself end in #L10. Preserve that spelling and still show
	// the actual location; only a distinct, already-decorated label is deduplicated.
	const isPathLabel =
		visible === target.path ||
		target.path.endsWith(`/${visible}`) ||
		(WINDOWS_ABSOLUTE.test(target.path) && target.path.endsWith(`\\${visible}`));
	if (!isPathLabel) {
		const hashSuffix = `#L${suffix.slice(1).replace("-", "-L")}`;
		if (
			[suffix, suffix.replace("-", "–"), suffix.replace(":", "："), hashSuffix].some((ending) =>
				visible.endsWith(ending),
			)
		)
			return "";
	}
	return suffix;
}

function normalizeAbsolute(path: string): string | null {
	if (!isSafeLiteral(path)) return null;
	const windows = WINDOWS_ABSOLUTE.test(path);
	if (!windows && !path.startsWith("/")) return null;
	return joinAbsolute(windows ? path.slice(0, 2) : "", path.slice(windows ? 3 : 1));
}

function joinAbsolute(drive: string, remainder: string): string | null {
	const parts: string[] = [];
	// The absolute root (or captured base) determines grammar, not the host OS.
	// POSIX backslashes are filename characters, even in a segment like a\..\b.ts.
	for (const part of remainder.split(drive ? /[\\/]/u : "/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	const normalized = `${drive}/${parts.join("/")}`;
	return normalized.length <= MAX_FILE_REFERENCE_PATH_CHARS ? normalized : null;
}

function resolveLiteral(path: string, baseDir?: string | null): string | null {
	if (!isSafeLiteral(path) || /^~[\\/]/u.test(path)) return null;
	if (WINDOWS_ABSOLUTE.test(path) || path.startsWith("/")) return normalizeAbsolute(path);
	if (!baseDir) return null;
	const base = normalizeAbsolute(baseDir);
	if (base === null) return null;
	const windows = WINDOWS_ABSOLUTE.test(base);
	return joinAbsolute(windows ? base.slice(0, 2) : "", `${base.slice(windows ? 3 : 1)}/${path}`);
}

/** Lexical resolution only: never process/browser cwd, realpath or home lookup. */
export function resolveLocalFilePath(path: string, baseDir?: string | null): string | null {
	const file = parseLocalFilePath(path);
	return file === null ? null : resolveLiteral(file.path, baseDir);
}

/** Lexical dirname: Windows separators normalize; POSIX backslashes stay literal. */
export function localFileDirectory(path: string): string {
	if (path.length > MAX_ENCODED_LENGTH) return ".";
	const parsed =
		FILE_URI.test(path) || path.startsWith(NF_FILE_PREFIX)
			? parseLocalFilePath(path)
			: splitLocation(path);
	if (!parsed || !isSafeLiteral(parsed.path)) return ".";
	const windows = WINDOWS_ABSOLUTE.test(parsed.path);
	const normalized = windows ? parsed.path.replace(/\\/g, "/") : parsed.path;
	const rootLength = windows ? 3 : normalized.startsWith("/") ? 1 : 0;
	let end = normalized.length;
	while (end > rootLength && normalized[end - 1] === "/") end--;
	const slash = normalized.lastIndexOf("/", end - 1);
	if (slash < rootLength) return rootLength ? normalized.slice(0, rootLength) : ".";
	return normalized.slice(0, slash);
}
