import { join } from "node:path";

import type {
	DiskUsageAdapter,
	DoctorSystemAdapter,
	FileSystemAdapter,
} from "@/adapters/interfaces.ts";
import { CURRENT_LEDGER_SCHEMA_VERSION, LEDGER_FILENAME } from "@/ledger/index.ts";
import type { LoadedFactoryConfiguration, XdgPaths } from "@/operations/runtime.ts";

export type DoctorCheckStatus = "fail" | "pass" | "warn";

export interface DoctorCheck {
	readonly name: string;
	readonly status: DoctorCheckStatus;
	readonly detail: string;
}

export interface DoctorReport {
	readonly ok: boolean;
	readonly live: boolean;
	readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
	readonly paths: XdgPaths;
	readonly fileSystem: FileSystemAdapter;
	readonly disk: DiskUsageAdapter;
	readonly system: DoctorSystemAdapter;
	readonly loadConfiguration: () => Promise<LoadedFactoryConfiguration>;
}

const REQUIRED_BINARIES = ["git", "gh", "bun", "claude", "codex", "herdr"] as const;

function permissions(mode: number): string {
	return `0${(mode & 0o777).toString(8)}`;
}

export class Doctor {
	readonly #options: DoctorOptions;

	public constructor(options: DoctorOptions) {
		this.#options = options;
	}

	public async run(input: { readonly live: boolean }): Promise<DoctorReport> {
		const checks: DoctorCheck[] = [];
		await this.#configuration(checks);
		await this.#xdgPermissions(checks);

		try {
			const schema = await this.#options.system.ledgerSchemaVersion(
				join(this.#options.paths.stateDirectory, LEDGER_FILENAME),
			);
			checks.push({
				name: "ledger",
				status: schema === CURRENT_LEDGER_SCHEMA_VERSION ? "pass" : "fail",
				detail:
					schema === null
						? "ledger is unavailable or cannot be opened read-only"
						: `schema ${schema}; expected ${CURRENT_LEDGER_SCHEMA_VERSION}`,
			});
		} catch (error) {
			checks.push({
				name: "ledger",
				status: "fail",
				detail: error instanceof Error ? error.message : "ledger check failed",
			});
		}

		let socket = false;
		try {
			socket = await this.#options.system.socketReachable(this.#options.paths.socketPath);
		} catch {
			socket = false;
		}
		checks.push({
			name: "socket",
			status: socket ? "pass" : "warn",
			detail: socket ? "daemon socket is reachable" : "daemon socket is not reachable",
		});
		let unit = false;
		try {
			unit = await this.#options.system.systemdUnitPresent("agent-factory.service");
		} catch {
			unit = false;
		}
		checks.push({
			name: "systemd-unit",
			status: unit ? "pass" : "warn",
			detail: unit ? "agent-factory.service is installed" : "user unit is not installed",
		});

		for (const binary of REQUIRED_BINARIES) {
			let version: string | null = null;
			try {
				version = await this.#options.system.binaryVersion(binary);
			} catch {
				version = null;
			}
			checks.push({
				name: `binary-${binary}`,
				status: version === null ? "fail" : "pass",
				detail: version ?? `${binary} is not available on PATH`,
			});
		}

		for (const [name, path] of [
			["state", this.#options.paths.stateDirectory],
			["data", this.#options.paths.dataDirectory],
		] as const) {
			try {
				const usage = await this.#options.disk.usage(path);
				if (
					!Number.isSafeInteger(usage.usedBytes) ||
					!Number.isSafeInteger(usage.totalBytes) ||
					usage.usedBytes < 0 ||
					usage.totalBytes <= 0 ||
					usage.usedBytes > usage.totalBytes
				) {
					throw new Error("disk usage adapter returned invalid byte counts");
				}
				const percentage = (usage.usedBytes / usage.totalBytes) * 100;
				let status: DoctorCheckStatus = "pass";
				if (percentage >= 90) {
					status = "fail";
				} else if (percentage >= 80) {
					status = "warn";
				}
				checks.push({
					name: `disk-${name}`,
					status,
					detail: `${percentage.toFixed(1)}% used`,
				});
			} catch (error) {
				checks.push({
					name: `disk-${name}`,
					status: "fail",
					detail: error instanceof Error ? error.message : "disk usage check failed",
				});
			}
		}

		if (input.live) {
			for (const provider of ["claude", "codex", "github"] as const) {
				let probe: { readonly ok: boolean; readonly detail: string };
				try {
					probe = await this.#options.system.liveProbe(provider);
				} catch (error) {
					probe = {
						ok: false,
						detail: error instanceof Error ? error.message : `${provider} live probe failed`,
					};
				}
				checks.push({
					name: `live-${provider}`,
					status: probe.ok ? "pass" : "fail",
					detail: probe.detail,
				});
			}
		}

		return {
			ok: checks.every((check) => check.status !== "fail"),
			live: input.live,
			checks,
		};
	}

	async #configuration(checks: DoctorCheck[]): Promise<void> {
		try {
			const loaded = await this.#options.loadConfiguration();
			checks.push({
				name: "configuration",
				status: "pass",
				detail: `${loaded.profiles.length} profile(s) validated`,
			});
		} catch (error) {
			checks.push({
				name: "configuration",
				status: "fail",
				detail: error instanceof Error ? error.message : "configuration validation failed",
			});
		}
	}

	async #xdgPermissions(checks: DoctorCheck[]): Promise<void> {
		for (const [name, path] of [
			["config", this.#options.paths.configDirectory],
			["state", this.#options.paths.stateDirectory],
			["data", this.#options.paths.dataDirectory],
		] as const) {
			try {
				const metadata = await this.#options.fileSystem.stat(path);
				const valid = metadata.kind === "directory" && (metadata.mode & 0o777) === 0o700;
				checks.push({
					name: `permissions-${name}`,
					status: valid ? "pass" : "fail",
					detail: valid
						? "directory mode 0700"
						: `${metadata.kind} mode ${permissions(metadata.mode)}; expected directory mode 0700`,
				});
			} catch (error) {
				checks.push({
					name: `permissions-${name}`,
					status: "fail",
					detail: error instanceof Error ? error.message : "permission check failed",
				});
			}
		}
	}
}
