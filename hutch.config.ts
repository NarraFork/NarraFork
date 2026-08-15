// @hutch cli=0.8.0 cottontail=0.4.4
/**
 * Hutch toolchain configuration for the Electrobun desktop shell.
 *
 * Versions are pinned so a desktop build is reproducible: Electrobun 2.x is still in beta and
 * its packaging layout has been changing between releases.
 */
export default {
	electrobun: {
		version: "2.0.1-beta.12",
	},
	packageManager: "bun",
	scripts: {
		build: ["hutch", "electrobun", "build", "--env=production"],
		dev: ["hutch", "electrobun", "dev"],
	},
};
