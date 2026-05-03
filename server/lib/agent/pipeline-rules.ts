export interface PipelineCaptureSource {
	alias: string;
	text: string;
}

export interface PipelineExecutionResult {
	aliases: string[];
	text: string;
	stages: string[];
}

interface Stage {
	command: string;
	args: string[];
	raw: string;
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

function parseStages(rule?: string): Stage[] {
	const trimmed = rule?.trim();
	if (!trimmed) return [{ command: "cat", args: [], raw: "cat" }];
	return splitPipelineStages(trimmed).map((parts) => ({
		command: parts[0].toLowerCase(),
		args: parts.slice(1),
		raw: parts.join(" "),
	}));
}

export function executePipelineRule(
	sources: PipelineCaptureSource[],
	rule?: string,
	defaultAliases?: string[],
): PipelineExecutionResult {
	const stages = parseStages(rule);
	const sourceByAlias = new Map(sources.map((source) => [source.alias, source]));
	let selectedAliases = defaultAliases?.length
		? [...defaultAliases]
		: sources.map((source) => source.alias);
	let startIndex = 0;

	if (stages[0]?.command === "from") {
		if (stages[0].args.length === 0) {
			throw new PipelineRuleError("from requires at least one alias");
		}
		selectedAliases = stages[0].args;
		startIndex = 1;
	}

	for (const alias of selectedAliases) {
		if (!sourceByAlias.has(alias)) {
			throw new PipelineRuleError(`Unknown pipeline alias: ${alias}`);
		}
	}

	let lines = selectedAliases.flatMap(
		(alias) => sourceByAlias.get(alias)?.text.split(/\r?\n/) ?? [],
	);
	const executedStages: string[] = [];

	for (const stage of stages.slice(startIndex)) {
		executedStages.push(stage.raw);
		lines = applyStage(lines, stage);
	}

	return {
		aliases: selectedAliases,
		text: lines.join("\n"),
		stages: executedStages,
	};
}

function applyStage(lines: string[], stage: Stage): string[] {
	switch (stage.command) {
		case "cat":
			if (stage.args.length > 0) throw new PipelineRuleError("cat does not accept arguments");
			return lines;
		case "grep":
			return applyGrep(lines, stage.args);
		case "head":
			return lines.slice(0, parseCount(stage.args, "head"));
		case "tail": {
			const count = parseCount(stage.args, "tail");
			return count === 0 ? [] : lines.slice(-count);
		}
		case "sort":
			return applySort(lines, stage.args);
		case "uniq":
			return applyUniq(lines, stage.args);
		case "cut":
			return applyCut(lines, stage.args);
		case "from":
			throw new PipelineRuleError("from can only appear as the first stage");
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

function applyGrep(lines: string[], args: string[]): string[] {
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
	let regex: RegExp;
	try {
		regex = new RegExp(rest[0], ignoreCase ? "i" : undefined);
	} catch (err) {
		throw new PipelineRuleError(
			`Invalid grep pattern: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return lines.filter((line) => (regex.test(line) ? !invert : invert));
}

function applySort(lines: string[], args: string[]): string[] {
	let reverse = false;
	for (const arg of args) {
		if (arg === "-r") reverse = true;
		else throw new PipelineRuleError(`Unsupported sort option: ${arg}`);
	}
	const sorted = [...lines].sort((a, b) => a.localeCompare(b));
	return reverse ? sorted.reverse() : sorted;
}

function applyUniq(lines: string[], args: string[]): string[] {
	if (args.length > 0) throw new PipelineRuleError("uniq does not accept arguments");
	const seen = new Set<string>();
	const result: string[] = [];
	for (const line of lines) {
		if (seen.has(line)) continue;
		seen.add(line);
		result.push(line);
	}
	return result;
}

function applyCut(lines: string[], args: string[]): string[] {
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
	const fields = parseFields(fieldsSpec);
	return lines.map((line) => {
		const parts = line.split(delimiter);
		return fields.map((index) => parts[index - 1] ?? "").join(delimiter);
	});
}

function parseFields(spec: string): number[] {
	const result: number[] = [];
	for (const chunk of spec.split(",")) {
		if (!chunk) throw new PipelineRuleError("cut field list contains an empty field");
		const range = chunk.match(/^(\d+)-(\d+)$/);
		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (start < 1 || end < start)
				throw new PipelineRuleError(`Invalid cut field range: ${chunk}`);
			for (let i = start; i <= end; i++) result.push(i);
			continue;
		}
		const field = Number(chunk);
		if (!Number.isInteger(field) || field < 1) {
			throw new PipelineRuleError(`Invalid cut field: ${chunk}`);
		}
		result.push(field);
	}
	return result;
}
