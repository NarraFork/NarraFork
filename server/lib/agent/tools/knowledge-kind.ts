/**
 * Knowledge Steward preload tool names — pure string constants, no imports.
 *
 * Kept in a dedicated leaf module (rather than tools/index.ts) so that
 * consumers which only need these names — notably narrator-service.ts — do not
 * have to import tools/index.ts. That import edge was the shared tail of every
 * circular-import chain back into tools/index.ts (…→ narrator-ws → narrator-service
 * → tools/index), which triggered a temporal-dead-zone crash ("Cannot access
 * 'editTool' before initialization") when a tool module was imported first.
 */

/**
 * Knowledge Steward narrators preinstall these optional tools (written into
 * enabledTools at creation). KnowledgeAdmin is admin-only and added separately
 * after an admin check.
 */
export const KNOWLEDGE_KIND_PRELOAD_TOOLS = [
	"KnowledgeCreate",
	"KnowledgeEdit",
	"KnowledgeReview",
] as const;

export const KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN = "KnowledgeAdmin";
