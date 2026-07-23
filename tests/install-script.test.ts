import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const installer = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");

describe("operator install script", () => {
	test("uses Bash fail-fast semantics and frozen dependencies", () => {
		expect(installer.startsWith("#!/usr/bin/env bash\n")).toBe(true);
		expect(installer).toContain("set -euo pipefail");
		expect(installer).toContain("bun install --frozen-lockfile");
	});

	test("keeps installation inert and avoids unsafe permissions", () => {
		expect(installer).not.toContain("systemctl --user enable");
		expect(installer).not.toContain("systemctl --user start");
		expect(installer).not.toMatch(/\bsudo\b/u);
		expect(installer).not.toContain("chmod 777");
		expect(installer).toContain("systemctl --user daemon-reload");
	});

	test("does not create or copy credentials", () => {
		expect(installer).not.toMatch(
			/^[\t ]*(?:install|mkdir|cp|mv|touch|chmod|cat)\b[^\n]*credentials\//mu,
		);
		expect(installer).toContain(
			"printf '  3. Place the App PEM at %s/credentials/github-app.pem with mode 0600.\\n'",
		);
	});

	test("installs example configuration only behind the no-overwrite guard", () => {
		expect(installer).toContain("install_config_if_absent()");
		expect(installer).toContain('if [[ -e "$destination" || -L "$destination" ]]; then');
		expect(installer).toContain("Kept existing operator config (not overwritten)");
		expect(installer).toContain('install -m 0600 "$source_file" "$destination"');
		expect(installer).not.toMatch(/install -m 0600 [^\n]*(?:config\.yaml|profiles\/\*\.yaml)/u);
	});

	test("offers a prerequisite-only smoke mode", () => {
		expect(installer).toContain('AGENT_FACTORY_INSTALL_CHECK_ONLY:-0}" == "1"');
		expect(installer).toContain("Prerequisite check complete");
	});

	test("installs from the public repository without requiring GitHub CLI", () => {
		expect(installer).toContain(
			"curl -fsSL https://raw.githubusercontent.com/NoorChasib/agent-factory/main/install.sh | bash",
		);
		expect(installer).toContain(
			'git clone "https://github.com/NoorChasib/agent-factory.git" "$requested_checkout"',
		);
		expect(installer).not.toContain("gh api");
		expect(installer).not.toContain("Authorization: Bearer");
		expect(installer).not.toContain("gh repo clone");
		expect(installer).not.toContain('require_command "gh"');
		expect(installer).toContain('require_command "git"');
		expect(installer).toContain('require_command "bun"');
		expect(installer).toContain('require_command "systemctl"');
		expect(installer).toContain("if command -v gh");
		expect(installer).toContain("gh auth status");
		expect(installer).toContain(
			"gh with authentication is required for operation/workers, not for installation.",
		);
	});
});
