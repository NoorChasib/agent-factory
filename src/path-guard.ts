import { isAbsolute, relative, resolve } from "node:path";

export function normalizedAbsolutePath(value: string, description: string): string {
	if (!isAbsolute(value) || /[\0\r\n]/u.test(value)) {
		throw new Error(`${description} must be an absolute path without controls`);
	}
	return resolve(value);
}

export function within(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
