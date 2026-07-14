export const MAX_PIPELINE_RULE_CHARS = 4096;
export const MAX_PIPELINE_COMMANDS = 16;
export const MAX_PIPELINE_SELECTED_CAPTURES = 16;
export const MAX_PIPELINE_CAPTURE_BYTES = 256 * 1024;
export const MAX_PIPELINE_TOTAL_BYTES = 1024 * 1024;
export const MAX_PIPELINE_CAPTURE_LINES = 10_000;
export const MAX_PIPELINE_TOTAL_LINES = 40_000;
export const MAX_PIPELINE_CAPTURE_CHARS = 200_000;
export const MAX_PIPELINE_TOTAL_CHARS = 800_000;
export const MAX_PIPELINE_EXECUTION_MS = 250;
export const MAX_PIPELINE_OUTPUT_CHARS = 50_000;
/**
 * Hard cap on how many field indices a single `cut -f` spec may expand to.
 * Field ranges (`a-b`) are expanded eagerly during rule validation — BEFORE the
 * execution deadline exists — so an unbounded range would freeze the main thread
 * (or loop forever when the upper bound parses to Infinity). Real `cut` usage
 * never needs anywhere near this many columns.
 */
export const MAX_PIPELINE_CUT_FIELDS = 1024;

export interface PipelineCaptureSource {
	alias: string;
	text: string;
}

export interface PipelineExecutionResult {
	aliases: string[];
	text: string;
	stages: string[];
}

export interface PipelineStage {
	command: string;
	args: string[];
	raw: string;
}

export interface PreparedPipelineRule {
	aliases: string[];
	stages: PipelineStage[];
}

export interface PipelineExecutionOptions {
	maxExecutionMs?: number;
	now?: () => number;
}

export class PipelineRuleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PipelineRuleError";
	}
}

export function splitPipelineStages(rule: string): string[][] {
	const stages: string[][] = [];
	let current: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	const pushToken = () => {
		if (token.length > 0) {
			current.push(token);
			token = "";
		}
	};
	const pushStage = () => {
		pushToken();
		if (current.length > 0) {
			stages.push(current);
			current = [];
		}
	};

	for (let i = 0; i < rule.length; i++) {
		const ch = rule[i];

		if (escaping) {
			token += ch;
			escaping = false;
			continue;
		}

		if (ch === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				token += ch;
			}
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}

		if (ch === "|") {
			pushStage();
			continue;
		}

		if (/\s/.test(ch)) {
			pushToken();
			continue;
		}

		token += ch;
	}

	if (escaping) token += "\\";
	if (quote) {
		throw new PipelineRuleError(`Unclosed ${quote === "'" ? "single" : "double"} quote`);
	}
	pushStage();

	return stages;
}

function parseStages(rule?: string): PipelineStage[] {
	if (rule && rule.length > MAX_PIPELINE_RULE_CHARS) {
		throw new PipelineRuleError(`Pipeline rule exceeds ${MAX_PIPELINE_RULE_CHARS} characters`);
	}
	const trimmed = rule?.trim();
	if (!trimmed) return [{ command: "cat", args: [], raw: "cat" }];
	const stages = splitPipelineStages(trimmed).map((parts) => ({
		command: parts[0].toLowerCase(),
		args: parts.slice(1),
		raw: parts.join(" "),
	}));
	if (stages.length > MAX_PIPELINE_COMMANDS) {
		throw new PipelineRuleError(`Pipeline rule exceeds ${MAX_PIPELINE_COMMANDS} commands`);
	}
	return stages;
}

export function preparePipelineRule(
	availableAliases: string[],
	rule?: string,
	defaultAliases?: string[],
): PreparedPipelineRule {
	const stages = parseStages(rule);
	let selectedAliases = defaultAliases?.length ? [...defaultAliases] : [...availableAliases];
	let startIndex = 0;

	if (stages[0]?.command === "from") {
		if (stages[0].args.length === 0) {
			throw new PipelineRuleError("from requires at least one alias");
		}
		selectedAliases = stages[0].args;
		startIndex = 1;
	}
	if (selectedAliases.length > MAX_PIPELINE_SELECTED_CAPTURES) {
		throw new PipelineRuleError(
			`Pipeline selection exceeds ${MAX_PIPELINE_SELECTED_CAPTURES} captures`,
		);
	}
	if (new Set(selectedAliases).size !== selectedAliases.length) {
		throw new PipelineRuleError("Pipeline aliases must not be duplicated");
	}
	const available = new Set(availableAliases);
	for (const alias of selectedAliases) {
		if (!available.has(alias)) {
			throw new PipelineRuleError(`Unknown pipeline alias: ${alias}`);
		}
	}
	const executableStages = stages.slice(startIndex);
	for (const stage of executableStages) validateStage(stage);
	return { aliases: selectedAliases, stages: executableStages };
}

export function executePipelineRule(
	sources: PipelineCaptureSource[],
	rule?: string,
	defaultAliases?: string[],
	options?: PipelineExecutionOptions,
): PipelineExecutionResult {
	const plan = preparePipelineRule(
		sources.map((source) => source.alias),
		rule,
		defaultAliases,
	);
	const sourceByAlias = new Map(sources.map((source) => [source.alias, source]));
	return executePreparedPipelineRule(
		plan.aliases.map((alias) => sourceByAlias.get(alias) as PipelineCaptureSource),
		plan,
		options,
	);
}

export function executePreparedPipelineRule(
	sources: PipelineCaptureSource[],
	plan: PreparedPipelineRule,
	options: PipelineExecutionOptions = {},
): PipelineExecutionResult {
	const now = options.now ?? performance.now.bind(performance);
	const maxExecutionMs = options.maxExecutionMs ?? MAX_PIPELINE_EXECUTION_MS;
	const deadline = { startedAt: now(), maxExecutionMs, now };
	validateSources(sources);
	assertWithinDeadline(deadline);
	let lines = sources.flatMap((source) => splitSourceLines(source.text));
	const executedStages: string[] = [];

	for (const stage of plan.stages) {
		assertWithinDeadline(deadline);
		executedStages.push(stage.raw);
		lines = applyStage(lines, stage, deadline);
	}
	assertWithinDeadline(deadline);

	return {
		aliases: plan.aliases,
		text: joinLinesBounded(lines, MAX_PIPELINE_OUTPUT_CHARS),
		stages: executedStages,
	};
}

type PipelineDeadline = {
	startedAt: number;
	maxExecutionMs: number;
	now: () => number;
};

function assertWithinDeadline(deadline: PipelineDeadline): void {
	if (
		deadline.maxExecutionMs <= 0 ||
		deadline.now() - deadline.startedAt >= deadline.maxExecutionMs
	) {
		throw new PipelineRuleError(
			`Pipeline execution exceeded ${Math.max(0, deadline.maxExecutionMs)} ms`,
		);
	}
}

function splitSourceLines(text: string): string[] {
	return text.length === 0 ? [] : text.split(/\r?\n/);
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

function validateSources(sources: PipelineCaptureSource[]): void {
	let totalBytes = 0;
	let totalChars = 0;
	let totalLines = 0;
	for (const source of sources) {
		const bytes = Buffer.byteLength(source.text, "utf-8");
		const chars = source.text.length;
		const lines = countLines(source.text);
		if (bytes > MAX_PIPELINE_CAPTURE_BYTES) {
			throw new PipelineRuleError(
				`Pipeline capture ${source.alias} exceeds ${MAX_PIPELINE_CAPTURE_BYTES} input bytes`,
			);
		}
		if (chars > MAX_PIPELINE_CAPTURE_CHARS) {
			throw new PipelineRuleError(
				`Pipeline capture ${source.alias} exceeds ${MAX_PIPELINE_CAPTURE_CHARS} characters`,
			);
		}
		if (lines > MAX_PIPELINE_CAPTURE_LINES) {
			throw new PipelineRuleError(
				`Pipeline capture ${source.alias} exceeds ${MAX_PIPELINE_CAPTURE_LINES} lines`,
			);
		}
		totalBytes += bytes;
		totalChars += chars;
		totalLines += lines;
	}
	if (totalBytes > MAX_PIPELINE_TOTAL_BYTES) {
		throw new PipelineRuleError(`Pipeline input exceeds ${MAX_PIPELINE_TOTAL_BYTES} total bytes`);
	}
	if (totalChars > MAX_PIPELINE_TOTAL_CHARS) {
		throw new PipelineRuleError(
			`Pipeline input exceeds ${MAX_PIPELINE_TOTAL_CHARS} total characters`,
		);
	}
	if (totalLines > MAX_PIPELINE_TOTAL_LINES) {
		throw new PipelineRuleError(`Pipeline input exceeds ${MAX_PIPELINE_TOTAL_LINES} total lines`);
	}
}

function joinLinesBounded(lines: string[], maxChars: number): string {
	let output = "";
	for (const line of lines) {
		const separator = output.length > 0 ? "\n" : "";
		if (output.length + separator.length + line.length > maxChars) {
			const marker = "\n...pipeline output limit reached...";
			const available = Math.max(0, maxChars - output.length - marker.length);
			return `${output}${separator}${line.slice(0, available)}${marker}`.slice(0, maxChars);
		}
		output += `${separator}${line}`;
	}
	return output;
}

function validateStage(stage: PipelineStage): void {
	switch (stage.command) {
		case "cat":
			if (stage.args.length > 0) throw new PipelineRuleError("cat does not accept arguments");
			return;
		case "grep":
			compileGrep(stage.args);
			return;
		case "head":
		case "tail":
			parseCount(stage.args, stage.command);
			return;
		case "sort":
			parseSortOptions(stage.args);
			return;
		case "uniq":
			if (stage.args.length > 0) throw new PipelineRuleError("uniq does not accept arguments");
			return;
		case "cut":
			parseCutOptions(stage.args);
			return;
		case "from":
			throw new PipelineRuleError("from can only appear as the first stage");
		default:
			throw new PipelineRuleError(`Unsupported pipeline command: ${stage.command}`);
	}
}

function applyStage(lines: string[], stage: PipelineStage, deadline: PipelineDeadline): string[] {
	switch (stage.command) {
		case "cat":
			return lines;
		case "grep":
			return applyGrep(lines, stage.args, deadline);
		case "head":
			return lines.slice(0, parseCount(stage.args, "head"));
		case "tail": {
			const count = parseCount(stage.args, "tail");
			return count === 0 ? [] : lines.slice(-count);
		}
		case "sort":
			return applySort(lines, stage.args, deadline);
		case "uniq":
			return applyUniq(lines, deadline);
		case "cut":
			return applyCut(lines, stage.args, deadline);
		default:
			throw new PipelineRuleError(`Unsupported pipeline command: ${stage.command}`);
	}
}

function parseCount(args: string[], command: "head" | "tail"): number {
	let raw: string | undefined;
	if (args.length === 1) {
		raw = args[0];
	} else if (args.length === 2 && args[0] === "-n") {
		raw = args[1];
	} else {
		throw new PipelineRuleError(`${command} expects N or -n N`);
	}
	const count = Number(raw);
	if (!Number.isInteger(count) || count < 0) {
		throw new PipelineRuleError(`${command} count must be a non-negative integer`);
	}
	return count;
}

function compileGrep(args: string[]): { regex: RegExp; invert: boolean } {
	let ignoreCase = false;
	let invert = false;
	const rest: string[] = [];
	for (const arg of args) {
		if (arg === "-i") ignoreCase = true;
		else if (arg === "-v") invert = true;
		else rest.push(arg);
	}
	if (rest.length !== 1) {
		throw new PipelineRuleError("grep expects exactly one pattern argument");
	}
	try {
		return { regex: new RegExp(rest[0], ignoreCase ? "i" : undefined), invert };
	} catch (err) {
		throw new PipelineRuleError(
			`Invalid grep pattern: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function applyGrep(lines: string[], args: string[], deadline: PipelineDeadline): string[] {
	const { regex, invert } = compileGrep(args);
	const result: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		if ((index & 127) === 0) assertWithinDeadline(deadline);
		if (regex.test(lines[index]) ? !invert : invert) result.push(lines[index]);
	}
	return result;
}

function parseSortOptions(args: string[]): { reverse: boolean } {
	let reverse = false;
	for (const arg of args) {
		if (arg === "-r") reverse = true;
		else throw new PipelineRuleError(`Unsupported sort option: ${arg}`);
	}
	return { reverse };
}

function applySort(lines: string[], args: string[], deadline: PipelineDeadline): string[] {
	const { reverse } = parseSortOptions(args);
	const sorted = [...lines].sort((a, b) => a.localeCompare(b));
	assertWithinDeadline(deadline);
	return reverse ? sorted.reverse() : sorted;
}

function applyUniq(lines: string[], deadline: PipelineDeadline): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		if ((index & 127) === 0) assertWithinDeadline(deadline);
		const line = lines[index];
		if (seen.has(line)) continue;
		seen.add(line);
		result.push(line);
	}
	return result;
}

function parseCutOptions(args: string[]): { delimiter: string; fields: number[] } {
	let delimiter = "\t";
	let fieldsSpec: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-d") {
			delimiter = args[++i];
			if (delimiter == null) throw new PipelineRuleError("cut -d requires a delimiter");
		} else if (arg === "-f") {
			fieldsSpec = args[++i];
			if (fieldsSpec == null) throw new PipelineRuleError("cut -f requires a field list");
		} else {
			throw new PipelineRuleError(`Unsupported cut option: ${arg}`);
		}
	}
	if (!fieldsSpec) throw new PipelineRuleError("cut requires -f <fields>");
	return { delimiter, fields: parseFields(fieldsSpec) };
}

function applyCut(lines: string[], args: string[], deadline: PipelineDeadline): string[] {
	const { delimiter, fields } = parseCutOptions(args);
	const result: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		if ((index & 127) === 0) assertWithinDeadline(deadline);
		const parts = lines[index].split(delimiter);
		result.push(fields.map((field) => parts[field - 1] ?? "").join(delimiter));
	}
	return result;
}

function parseFields(spec: string): number[] {
	const result: number[] = [];
	const pushField = (field: number): void => {
		if (result.length >= MAX_PIPELINE_CUT_FIELDS) {
			throw new PipelineRuleError(`cut field list exceeds ${MAX_PIPELINE_CUT_FIELDS} fields`);
		}
		result.push(field);
	};
	for (const chunk of spec.split(",")) {
		if (!chunk) throw new PipelineRuleError("cut field list contains an empty field");
		const range = chunk.match(/^(\d+)-(\d+)$/);
		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			// Reject non-finite / non-integer bounds up front: a many-digit upper
			// bound parses to Infinity, which would make the expansion loop below
			// never terminate and hang the event loop.
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
				throw new PipelineRuleError(`Invalid cut field range: ${chunk}`);
			}
			if (start < 1 || end < start) {
				throw new PipelineRuleError(`Invalid cut field range: ${chunk}`);
			}
			// Bound the expansion size before allocating (cheap width check first).
			if (end - start + 1 > MAX_PIPELINE_CUT_FIELDS) {
				throw new PipelineRuleError(`cut field list exceeds ${MAX_PIPELINE_CUT_FIELDS} fields`);
			}
			for (let i = start; i <= end; i++) pushField(i);
			continue;
		}
		const field = Number(chunk);
		if (!Number.isInteger(field) || field < 1) {
			throw new PipelineRuleError(`Invalid cut field: ${chunk}`);
		}
		pushField(field);
	}
	return result;
}
