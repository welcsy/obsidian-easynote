import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { readFileSync, existsSync } from "fs";

const prod = process.argv[2] === "production";

// 從 .env 讀取憑證（若存在）；CI 可直接設環境變數
if (existsSync(".env")) {
	for (const line of readFileSync(".env", "utf-8").split("\n")) {
		const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
		if (m) process.env[m[1]] = m[2];
	}
}
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';

const context = await esbuild.context({
	entryPoints: ["main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	define: {
		__GOOGLE_CLIENT_ID__:     JSON.stringify(GOOGLE_CLIENT_ID),
		__GOOGLE_CLIENT_SECRET__: JSON.stringify(GOOGLE_CLIENT_SECRET),
	},
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
