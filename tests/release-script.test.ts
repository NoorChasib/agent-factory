import { describe, expect, test } from "bun:test";
import {
	compareVersions,
	computeNextVersion,
	isBumpKeyword,
	parseVersion,
	renderVersionedJson,
} from "@scripts/release.ts";

describe("release script version helpers", () => {
	test("recognizes bump keywords", () => {
		expect(isBumpKeyword("patch")).toBe(true);
		expect(isBumpKeyword("minor")).toBe(true);
		expect(isBumpKeyword("major")).toBe(true);
		expect(isBumpKeyword("latest")).toBe(false);
		expect(isBumpKeyword("")).toBe(false);
	});

	test("parses strict x.y.z versions only", () => {
		expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
		expect(parseVersion("12.34.56")).toEqual([12, 34, 56]);
		expect(() => parseVersion("1.2")).toThrow();
		expect(() => parseVersion("1.2.3-beta")).toThrow();
		expect(() => parseVersion("v1.2.3")).toThrow();
		expect(() => parseVersion("1.2.3 ")).toThrow();
		expect(() => parseVersion("01.2.3")).toThrow();
		expect(() => parseVersion("1.02.3")).toThrow();
	});

	test("orders versions numerically, not lexically", () => {
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
		expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
		expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
	});

	test("computes keyword bumps", () => {
		expect(computeNextVersion("0.1.0", "patch")).toBe("0.1.1");
		expect(computeNextVersion("0.1.9", "minor")).toBe("0.2.0");
		expect(computeNextVersion("0.9.9", "major")).toBe("1.0.0");
	});

	test("accepts explicit versions only when strictly greater", () => {
		expect(computeNextVersion("0.1.0", "0.1.5")).toBe("0.1.5");
		expect(() => computeNextVersion("0.1.0", "0.1.0")).toThrow();
		expect(() => computeNextVersion("0.2.0", "0.1.9")).toThrow();
		expect(() => computeNextVersion("0.1.0", "not-a-version")).toThrow();
	});

	test("rewrites only the version field with tab indentation and trailing newline", () => {
		const source =
			'{\n\t"schemaVersion": 1,\n\t"version": "0.1.0",\n\t"requiredLedgerSchemaVersion": 4\n}\n';
		const rendered = renderVersionedJson(source, "0.2.0");
		expect(rendered).toBe(
			'{\n\t"schemaVersion": 1,\n\t"version": "0.2.0",\n\t"requiredLedgerSchemaVersion": 4\n}\n',
		);
	});

	test("rejects documents without a string version", () => {
		expect(() => renderVersionedJson('{\n\t"name": "x"\n}\n', "0.2.0")).toThrow();
		expect(() => renderVersionedJson('{\n\t"version": 2\n}\n', "0.2.0")).toThrow();
	});
});
