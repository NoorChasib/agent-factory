import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
	DoctorSystemAdapter,
	FileMetadata,
	RuntimeFileSystemAdapter,
} from "../src/adapters/interfaces";
import { CURRENT_LEDGER_SCHEMA_VERSION } from "../src/ledger";
import { Doctor } from "../src/operations/doctor";
import {
	loadFactoryConfiguration,
	prepareXdgDirectories,
	resolveXdgPaths,
} from "../src/operations/runtime";

class RuntimeMemoryFileSystem implements RuntimeFileSystemAdapter {
	public files = new Map<string, { content: string; metadata: FileMetadata }>();

	public put(path: string, content: string, kind: FileMetadata["kind"], mode: number): void {
		this.files.set(path, { content, metadata: { kind, mode } });
	}

	public async stat(path: string): Promise<FileMetadata> {
		const file = this.files.get(path);
		if (file === undefined) {
			throw new Error(`missing ${path}`);
		}
		return structuredClone(file.metadata);
	}

	public async readText(path: string): Promise<string> {
		const file = this.files.get(path);
		if (file === undefined) {
			throw new Error(`missing ${path}`);
		}
		return file.content;
	}

	public async ensureDirectory(path: string, mode: number): Promise<void> {
		this.put(path, "", "directory", mode);
	}

	public async listFiles(path: string): Promise<readonly string[]> {
		return [...this.files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)).sort();
	}
}

const runtimeYaml = `schemaVersion: 1
profiles:
  - profiles/project.yaml
ntfy:
  baseUrl: https://ntfy.example.test
  topic: factory-alerts
`;

describe("XDG configuration contract", () => {
	test("resolves standard fallbacks and creates private runtime directories", async () => {
		const paths = resolveXdgPaths({ HOME: "/home/operator" });
		expect(paths).toMatchObject({
			configDirectory: "/home/operator/.config/agent-factory",
			stateDirectory: "/home/operator/.local/state/agent-factory",
			dataDirectory: "/home/operator/.local/share/agent-factory",
			socketPath: "/home/operator/.local/state/agent-factory/agent-factory.sock",
		});
		const fileSystem = new RuntimeMemoryFileSystem();
		await prepareXdgDirectories(paths, fileSystem);
		for (const path of [
			paths.configDirectory,
			paths.profilesDirectory,
			paths.stateDirectory,
			paths.logDirectory,
			paths.dataDirectory,
			paths.mirrorDirectory,
			paths.worktreeDirectory,
			paths.releaseDirectory,
			paths.releaseBackupDirectory,
			paths.releaseBuildDirectory,
		]) {
			expect(await fileSystem.stat(path)).toEqual({ kind: "directory", mode: 0o700 });
		}
	});

	test("treats empty XDG values as unset and does not require HOME with explicit roots", () => {
		expect(
			resolveXdgPaths({
				HOME: "/home/operator",
				XDG_CONFIG_HOME: "",
				XDG_STATE_HOME: "",
				XDG_DATA_HOME: "",
			}).stateDirectory,
		).toBe("/home/operator/.local/state/agent-factory");
		expect(
			resolveXdgPaths({
				XDG_CONFIG_HOME: "/runtime/config",
				XDG_STATE_HOME: "/r/s",
				XDG_DATA_HOME: "/runtime/data",
			}),
		).toMatchObject({
			configDirectory: "/runtime/config/agent-factory",
			stateDirectory: "/r/s/agent-factory",
			dataDirectory: "/runtime/data/agent-factory",
		});
	});

	test("loads only mode-0600 strict config and profile files", async () => {
		const paths = resolveXdgPaths({
			HOME: "/home/operator",
			XDG_CONFIG_HOME: "/runtime/config",
			XDG_STATE_HOME: "/runtime/state",
			XDG_DATA_HOME: "/runtime/data",
		});
		const fileSystem = new RuntimeMemoryFileSystem();
		fileSystem.put(paths.configFile, runtimeYaml, "file", 0o600);
		fileSystem.put(
			join(paths.profilesDirectory, "project.yaml"),
			readFileSync(join(import.meta.dir, "fixtures", "profiles", "lumen-notes.yaml"), "utf8"),
			"file",
			0o600,
		);
		const loaded = await loadFactoryConfiguration(paths, fileSystem);
		expect(loaded.runtime.ntfy.topic).toBe("factory-alerts");
		expect(loaded.profiles.map((profile) => profile.id)).toEqual(["lumen-notes"]);

		fileSystem.put(paths.configFile, runtimeYaml, "file", 0o644);
		await expect(loadFactoryConfiguration(paths, fileSystem)).rejects.toThrow("mode 0600");
		fileSystem.put(paths.configFile, `${runtimeYaml}unknown: true\n`, "file", 0o600);
		await expect(loadFactoryConfiguration(paths, fileSystem)).rejects.toThrow();
		fileSystem.put(
			paths.configFile,
			runtimeYaml.replace(
				"  - profiles/project.yaml",
				"  - profiles/project.yaml\n  - profiles/project.yaml",
			),
			"file",
			0o600,
		);
		await expect(loadFactoryConfiguration(paths, fileSystem)).rejects.toThrow(
			"profile paths must be unique",
		);
	});

	test("guards Unix socket length", () => {
		expect(() =>
			resolveXdgPaths({
				HOME: "/home/operator",
				XDG_STATE_HOME: `/${"very-long/".repeat(20)}`,
			}),
		).toThrow("socket path exceeds");
	});
});

class DoctorSystem implements DoctorSystemAdapter {
	public liveCalls: string[] = [];

	public async binaryVersion(name: string): Promise<string | null> {
		return `${name} 1.0.0`;
	}

	public async socketReachable(): Promise<boolean> {
		return false;
	}

	public async systemdUnitPresent(): Promise<boolean> {
		return true;
	}

	public async ledgerSchemaVersion(): Promise<number | null> {
		return CURRENT_LEDGER_SCHEMA_VERSION;
	}

	public async liveProbe(provider: "claude" | "codex" | "github") {
		this.liveCalls.push(provider);
		return { ok: true, detail: `${provider} ok` };
	}
}

describe("doctor gating", () => {
	test("non-live doctor makes zero provider probes while checking local state", async () => {
		const paths = resolveXdgPaths({ HOME: "/home/operator" });
		const fileSystem = new RuntimeMemoryFileSystem();
		await prepareXdgDirectories(paths, fileSystem);
		const system = new DoctorSystem();
		let configurationReads = 0;
		const doctor = new Doctor({
			paths,
			fileSystem,
			disk: {
				async usage() {
					return { usedBytes: 50, totalBytes: 100 };
				},
			},
			system,
			loadConfiguration: async () => {
				configurationReads += 1;
				return {
					runtime: {
						schemaVersion: 1,
						profiles: ["profiles/project.yaml"],
						ntfy: {
							baseUrl: "https://ntfy.example.test",
							topic: "factory-alerts",
						},
						logging: { rotateBytes: 10 * 1024 * 1024, retainedFiles: 5 },
					},
					profiles: [],
					profilePaths: [],
				};
			},
		});
		const report = await doctor.run({ live: false });
		expect(report.live).toBe(false);
		expect(report.ok).toBe(true);
		expect(configurationReads).toBe(1);
		expect(system.liveCalls).toEqual([]);
		expect(report.checks.find((check) => check.name === "socket")?.status).toBe("warn");

		const live = await doctor.run({ live: true });
		expect(live.live).toBe(true);
		expect(system.liveCalls).toEqual(["claude", "codex", "github"]);
	});
});

describe("systemd asset", () => {
	test("uses the release current pointer, user restart policy, credential path, and default target", () => {
		const unit = readFileSync(
			join(import.meta.dir, "..", "systemd", "agent-factory.service"),
			"utf8",
		);
		expect(unit).toContain(
			"ExecStart=%h/.local/share/agent-factory/releases/current/bin/agent-factory-daemon",
		);
		expect(unit).toContain("Restart=on-failure");
		expect(unit).toContain(
			"LoadCredential=github-app.pem:%h/.config/agent-factory/credentials/github-app.pem",
		);
		expect(unit).toContain("AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE=%d/github-app.pem");
		expect(unit).toContain("WantedBy=default.target");
		expect(unit).not.toMatch(/\b(?:sudo|systemctl|Environment=.*PRIVATE KEY)/u);
	});
});
