import { toolRegistry } from "../tool-registry";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

/** Register all core tools into the singleton registry */
export function registerCoreTools(): void {
	toolRegistry.register(bashTool);
	toolRegistry.register(readTool);
	toolRegistry.register(writeTool);
	toolRegistry.register(editTool);
	toolRegistry.register(globTool);
	toolRegistry.register(grepTool);
	toolRegistry.register(webSearchTool);
}
