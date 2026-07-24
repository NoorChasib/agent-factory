import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const sourceRoot = join(repositoryRoot, "src");

const FORBIDDEN_TARGET_POLICY = [
	{ name: "HHC identifier", pattern: /\bhhc(?:-aep)?\b/iu },
	{ name: "HHC workflow prefix", pattern: /hhc-aep-(?:agent|operator)-/iu },
	{ name: "Fallow policy", pattern: /\bfallow\b/iu },
	{ name: "HHC owner-review label", pattern: /\bclaude-review\b/iu },
	{ name: "HHC reviewer account", pattern: /\bgithub-copilot\b/iu },
	{ name: "target milestone policy", pattern: /\bmilestone\b/iu },
	{ name: "target critical-path policy", pattern: /\bcritical-path\b/iu },
] as const;

const FORBIDDEN_IMPORT_ROOT = /(?:from\s+|import\s*\()(["'])(?:\.\.\/)*\b(?:tests|config)\//u;

function typeScriptFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return typeScriptFiles(path);
		}
		return entry.isFile() && extname(entry.name) === ".ts" ? [path] : [];
	});
}

describe("project-agnostic source sentinel", () => {
	test("keeps all source, including testing adapters, free of target policy and fixture imports", () => {
		const violations: string[] = [];
		for (const path of typeScriptFiles(sourceRoot).sort()) {
			expect(statSync(path).isFile()).toBe(true);
			const content = readFileSync(path, "utf8");
			const name = relative(repositoryRoot, path);
			for (const forbidden of FORBIDDEN_TARGET_POLICY) {
				if (forbidden.pattern.test(content)) {
					violations.push(`${name}: ${forbidden.name}`);
				}
			}
			if (FORBIDDEN_IMPORT_ROOT.test(content)) {
				violations.push(`${name}: import from tests/ or config/`);
			}
		}

		expect(violations).toEqual([]);
	});
});
