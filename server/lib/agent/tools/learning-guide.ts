import {
	getLearningDoc,
	getLearningDocSummaries,
	type LearningDoc,
	type LearningDocSummary,
	searchLearningDocs,
} from "@shared/learning-content";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

function normalizeLang(lang: unknown, fallback: string): string {
	if (typeof lang === "string" && lang.trim()) return lang;
	return fallback;
}

function isZh(lang: string): boolean {
	return lang.toLowerCase().startsWith("zh");
}

function renderActions(actions: LearningDoc["actions"], lang: string): string[] {
	if (actions.length === 0) return [];
	return [
		`## ${isZh(lang) ? "可跳转功能入口" : "Feature shortcuts"}`,
		...actions.map((action) => `- ${action.label}: ${action.description} (${action.href})`),
	];
}

function renderSummaryList(docs: LearningDocSummary[], lang: string): string {
	if (docs.length === 0)
		return isZh(lang) ? "未找到匹配的学习文档。" : "No matching learning documents found.";
	return docs
		.map((doc) => {
			const tags =
				doc.tags.length > 0 ? `\n  ${isZh(lang) ? "标签" : "Tags"}: ${doc.tags.join(", ")}` : "";
			const actions = doc.actions
				.slice(0, 3)
				.map((action) => `${action.label} → ${action.href}`)
				.join("；");
			return `- ${doc.title} (${doc.id})\n  ${doc.summary}${tags}${actions ? `\n  ${isZh(lang) ? "入口" : "Shortcuts"}: ${actions}` : ""}`;
		})
		.join("\n");
}

function renderDoc(doc: LearningDoc, lang: string): string {
	const lines = [`# ${doc.title}`, "", doc.summary, ""];

	for (const section of doc.sections) {
		lines.push(`## ${section.title}`, section.body, "");
	}

	if (doc.workflow.length > 0) {
		lines.push(
			`## ${isZh(lang) ? "推荐使用流程" : "Recommended workflow"}`,
			...doc.workflow.map((item, index) => `${index + 1}. ${item}`),
			"",
		);
	}
	if (doc.bestPractices.length > 0) {
		lines.push(
			`## ${isZh(lang) ? "最佳实践" : "Best practices"}`,
			...doc.bestPractices.map((item) => `- ${item}`),
			"",
		);
	}
	if (doc.pitfalls.length > 0) {
		lines.push(
			`## ${isZh(lang) ? "常见坑" : "Common pitfalls"}`,
			...doc.pitfalls.map((item) => `- ${item}`),
			"",
		);
	}
	if (doc.agentHints.length > 0) {
		lines.push(
			`## ${isZh(lang) ? "Agent 查阅提示" : "Agent hints"}`,
			...doc.agentHints.map((item) => `- ${item}`),
			"",
		);
	}

	const actions = renderActions(doc.actions, lang);
	if (actions.length > 0) lines.push(...actions, "");

	lines.push(`${isZh(lang) ? "文档 ID" : "Document ID"}: ${doc.id}`);
	return lines.join("\n").trim();
}

export const learningGuideTool: ToolDefinition = {
	name: "LearningGuide",
	description:
		"Look up NarraFork's built-in learning documentation. Use this when you need to understand NarraFork features, recommended workflows, best practices, or routes the user can jump to. The same knowledge base powers the /learn page.",
	parameters: z.object({
		mode: z
			.enum(["list", "search", "get"])
			.default("search")
			.describe("list all learning documents, search by query, or get one document by id"),
		query: z.string().optional().describe("Search query when mode is search"),
		id: z.string().optional().describe("Learning document id when mode is get"),
		lang: z.string().optional().describe("Preferred language, e.g. zh-CN or en"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const mode = typeof args.mode === "string" ? args.mode : "search";
		const lang = normalizeLang(args.lang, ctx.locale);

		if (mode === "list") {
			return {
				output: renderSummaryList(getLearningDocSummaries(lang), lang),
				title: "Learning Guide: list",
			};
		}

		if (mode === "get") {
			const id = typeof args.id === "string" ? args.id : "";
			if (!id)
				return {
					output: isZh(lang)
						? "请提供要查阅的学习文档 id。"
						: "Please provide the learning document id to read.",
					isError: true,
				};
			const doc = getLearningDoc(id, lang);
			if (!doc)
				return {
					output: isZh(lang) ? `未找到学习文档：${id}` : `Learning document not found: ${id}`,
					isError: true,
				};
			return { output: renderDoc(doc, lang), title: `Learning Guide: ${doc.title}` };
		}

		const query = typeof args.query === "string" ? args.query : "";
		if (!query.trim()) {
			return {
				output: renderSummaryList(getLearningDocSummaries(lang), lang),
				title: "Learning Guide: search",
			};
		}
		return {
			output: renderSummaryList(searchLearningDocs(query, lang), lang),
			title: `Learning Guide: ${query}`,
		};
	},
};
