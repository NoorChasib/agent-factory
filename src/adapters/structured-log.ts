import {
	appendFileSync,
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";

import type { StructuredLogSink } from "./interfaces";

export interface RotatingJsonLinesSinkOptions {
	readonly path: string;
	readonly rotateBytes: number;
	readonly retainedFiles: number;
}

export class RotatingJsonLinesSink implements StructuredLogSink {
	readonly #path: string;
	readonly #rotateBytes: number;
	readonly #retainedFiles: number;

	public constructor(options: RotatingJsonLinesSinkOptions) {
		if (
			!Number.isSafeInteger(options.rotateBytes) ||
			options.rotateBytes < 128 ||
			!Number.isSafeInteger(options.retainedFiles) ||
			options.retainedFiles < 1 ||
			options.retainedFiles > 20
		) {
			throw new Error("invalid structured log rotation configuration");
		}
		this.#path = options.path;
		this.#rotateBytes = options.rotateBytes;
		this.#retainedFiles = options.retainedFiles;
	}

	public async append(line: string): Promise<void> {
		if (/[\r\n]/u.test(line)) {
			throw new Error("structured log sink accepts exactly one JSON line");
		}
		const encodedBytes = Buffer.byteLength(`${line}\n`);
		if (
			existsSync(this.#path) &&
			statSync(this.#path).size > 0 &&
			statSync(this.#path).size + encodedBytes > this.#rotateBytes
		) {
			this.#rotate();
		}
		appendFileSync(this.#path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(this.#path, 0o600);
	}

	public async readRecent(lines: number): Promise<readonly string[]> {
		if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10_000) {
			throw new Error("structured log read count must be from 1 through 10000");
		}
		const files = [
			...Array.from(
				{ length: this.#retainedFiles },
				(_, index) => `${this.#path}.${index + 1}`,
			).reverse(),
			this.#path,
		];
		return files
			.filter(existsSync)
			.flatMap((path) => readFileSync(path, "utf8").split("\n").filter(Boolean))
			.slice(-lines);
	}

	#rotate(): void {
		const oldest = `${this.#path}.${this.#retainedFiles}`;
		if (existsSync(oldest)) {
			unlinkSync(oldest);
		}
		for (let index = this.#retainedFiles - 1; index >= 1; index -= 1) {
			const source = `${this.#path}.${index}`;
			if (existsSync(source)) {
				renameSync(source, `${this.#path}.${index + 1}`);
			}
		}
		renameSync(this.#path, `${this.#path}.1`);
	}
}
