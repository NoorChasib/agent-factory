import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { buildBinariesMain } from "@/installation/build-binaries.ts";

describe("release binary build command", () => {
	test("rejects a missing or invalid artifact-root invocation with the usage error", async () => {
		const invalidArguments: readonly (readonly string[])[] = [[], ["/artifact", "/extra"]];

		for (const argv of invalidArguments) {
			await expect(buildBinariesMain(argv)).rejects.toThrow(
				"usage: bun run build:binaries -- <artifact-root>",
			);
		}
	});

	test("refuses to overwrite the source checkout's development wrappers", async () => {
		const sourceRoot = resolve(import.meta.dir, "..");

		await expect(buildBinariesMain([sourceRoot])).rejects.toThrow(
			"refusing to replace the source checkout's development wrappers",
		);
	});
});
