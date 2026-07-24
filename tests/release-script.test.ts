import { describe, expect, test } from "bun:test";
import {
	compareVersions,
	computeNextVersion,
	isBumpKeyword,
	parseVersion,
	renderVersionedJson,
	splitVersion,
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

	test("splits every contract-valid version", () => {
		expect(splitVersion("1.2.3")).toEqual({ core: [1, 2, 3], isFinal: true });
		expect(splitVersion("1.2.3-rc.1")).toEqual({ core: [1, 2, 3], isFinal: false });
		expect(splitVersion("1.2.3-rc.1+build.4")).toEqual({ core: [1, 2, 3], isFinal: false });
		expect(splitVersion("01.2.3-rc.1")).toEqual({ core: [1, 2, 3], isFinal: false });
		expect(() => splitVersion("not-a-version")).toThrow();
	});

	test("build metadata carries no precedence", () => {
		expect(splitVersion("1.2.3+build.4")).toEqual({ core: [1, 2, 3], isFinal: true });
		expect(computeNextVersion("1.2.3+build.4", "patch")).toBe("1.2.4");
		expect(() => computeNextVersion("1.2.3+build.4", "1.2.3")).toThrow();
	});

	test("rejects version components beyond the safe integer range", () => {
		expect(() => splitVersion("9007199254740993.0.0")).toThrow();
		expect(() => computeNextVersion("9007199254740993.0.0", "major")).toThrow();
		expect(() => computeNextVersion("0.1.0", "9007199254740993.0.0")).toThrow();
	});

	test("rejects bumps whose result would leave the safe integer range", () => {
		expect(() => computeNextVersion("9007199254740991.0.0", "major")).toThrow();
		expect(() => computeNextVersion("0.9007199254740991.0", "minor")).toThrow();
		expect(() => computeNextVersion("0.0.9007199254740991", "patch")).toThrow();
		expect(computeNextVersion("9007199254740991.0.0", "patch")).toBe("9007199254740991.0.1");
	});

	test("releases from a prerelease current version", () => {
		expect(computeNextVersion("1.2.3-rc.1", "patch")).toBe("1.2.3");
		expect(computeNextVersion("1.2.3-rc.1", "minor")).toBe("1.3.0");
		expect(computeNextVersion("1.2.3-rc.1", "major")).toBe("2.0.0");
		expect(computeNextVersion("1.2.3-rc.1", "1.2.3")).toBe("1.2.3");
		expect(computeNextVersion("01.2.3-rc.1", "patch")).toBe("1.2.3");
		expect(() => computeNextVersion("1.2.3-rc.1", "1.2.2")).toThrow();
		expect(() => computeNextVersion("1.2.3-rc.1", "1.2.3-rc.2")).toThrow();
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
