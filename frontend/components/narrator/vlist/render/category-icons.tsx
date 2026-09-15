/**
 * category-icons.tsx — Self-contained category → @tabler icon map for the vlist
 * render layer. Mirrors ToolCallCard.tsx `getCategoryIcon` / `getKnowledgeIcon`
 * WITHOUT importing the heavy ToolCallCard module (which would pull the whole
 * chunk render path into the flag-gated vlist bundle and defeat lazy loading).
 *
 * Render-only + height-neutral: the header/trace icon lane is a fixed 16/14px
 * box regardless of glyph, so swapping the generic IconTool for the real
 * category glyph never changes a measured height.
 */

import {
	IconBook,
	IconBookUpload,
	IconClock,
	IconCode,
	IconDatabaseEdit,
	IconDatabaseSearch,
	IconEye,
	IconFilter,
	IconGavel,
	IconGitFork,
	IconHistory,
	IconListCheck,
	IconMap,
	IconMessageQuestion,
	IconPencil,
	IconPlayerPlay,
	type IconProps,
	IconRobot,
	IconSearch,
	IconShare,
	IconShieldLock,
	IconSitemap,
	IconTerminal2,
	IconTransfer,
	IconWand,
	IconWorldSearch,
	IconWorldWww,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { ToolCategory } from "../measure/measure-tool-call";

/** Per-tool icon for the knowledge family (same category, distinct glyphs). */
function knowledgeIcon(toolName?: string): ComponentType<IconProps> {
	switch (toolName) {
		case "KnowledgeSearch":
			return IconDatabaseSearch;
		case "KnowledgeRead":
			return IconBook;
		case "KnowledgeLibrary":
			return IconDatabaseSearch;
		case "KnowledgeCreate":
			return IconBookUpload;
		case "KnowledgeEdit":
			return IconDatabaseEdit;
		case "KnowledgeReview":
			return IconGavel;
		case "KnowledgeAdmin":
			return IconShieldLock;
		default:
			return IconBook;
	}
}

/** Resolve the category glyph (mirrors ToolCallCard.getCategoryIcon). */
export function categoryIcon(cat: ToolCategory, toolName?: string): ComponentType<IconProps> {
	switch (cat) {
		case "read":
			return IconEye;
		case "file":
			return IconPencil;
		case "bash":
			return IconTerminal2;
		case "search":
			return IconSearch;
		// A tree glyph, not the magnifier: StructView reads a file's shape rather than
		// scanning for a pattern, and the distinction is the reason this category exists.
		case "structure":
			return IconSitemap;
		case "webSearch":
			return IconWorldSearch;
		case "webFetch":
			return IconWorldWww;
		case "tasks":
			return IconListCheck;
		case "taskOutput":
			return IconRobot;
		case "agent":
			return IconGitFork;
		case "await":
			return IconClock;
		case "send":
			return IconMessageQuestion;
		case "ask":
			return IconPlayerPlay;
		case "plan":
			return IconMap;
		case "pipeline":
			return IconFilter;
		case "terminal":
			return IconTerminal2;
		case "share":
			return IconShare;
		case "transfer":
			return IconTransfer;
		case "recall":
			return IconHistory;
		case "skill":
			return IconWand;
		case "browser":
			return IconWorldWww;
		case "knowledge":
			return knowledgeIcon(toolName);
		default:
			return IconCode;
	}
}
