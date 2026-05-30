import { defineConfig, globalIgnores } from "eslint/config";
import json from "@eslint/json";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default defineConfig([
	globalIgnores([
		".obsidian/",
		"assets/",
		"bin/",
		"build/",
		"dist/",
		"eslint.config.mjs",
		"esbuild.config.mjs",
		"node_modules/",
		"pty-helper/target/",
		"versions.json"
	]),
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					acronyms: ["API", "CSS", "HTML", "JSON", "OSC", "PTY", "URL"],
					brands: ["GhostTerm", "Ghostty", "JetBrains", "JetBrains Mono", "Menlo", "Monaco", "macOS", "Obsidian"],
					enforceCamelCaseLower: false
				}
			]
		}
	},
	{
		files: ["manifest.json"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				extraFileExtensions: [".json"],
				projectService: {
					allowDefaultProject: ["manifest.json"]
				},
				tsconfigRootDir: import.meta.dirname
			}
		}
	},
	{
		files: ["package.json"],
		language: "json/json",
		plugins: {
			json
		},
		rules: {
			"obsidianmd/no-plugin-as-component": "off",
			"obsidianmd/no-unsupported-api": "off",
			"obsidianmd/no-view-references-in-plugin": "off",
			"obsidianmd/prefer-file-manager-trash-file": "off",
			"obsidianmd/prefer-instanceof": "off"
		}
	},
	{
		files: ["esbuild.config.mjs", "eslint.config.mjs"],
		rules: {
			"import/no-extraneous-dependencies": "off",
			"no-console": "off",
			"obsidianmd/no-nodejs-modules": "off"
		}
	}
]);
