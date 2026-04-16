/**
 * Font centralization: dehydrate at publish, rehydrate at load.
 *
 * Publish strips font files from ZIPs, moves their bytes to a shared
 * content-addressed store, and records what was removed in a sidecar
 * manifest (`fonts.json`). Loading rehydrates the tree by fetching
 * font bytes from the store and writing them back to their original paths.
 *
 * Browser-safe — no Node-only imports.
 */

/** Sidecar manifest embedded in the ZIP root after dehydration. */
export interface FontManifest {
	version: 1;
	/** Stripped file path -> MD5 hex of the raw font bytes. */
	files: Record<string, string>;
}

/** Per-font entry returned in dehydration stats. */
export interface FontStoreEntry {
	/** Basename of the original font file (e.g. `Inter-Regular.ttf`). */
	fileName: string;
	/** Full MD5 hex hash. */
	hash: string;
	/** Raw byte size. */
	size: number;
	/** Number of quills referencing this hash (across a full packaging run). */
	quillCount: number;
}

/** Summary stats from a `packageForHttp()` run with font dehydration. */
export interface FontDehydrationSummary {
	/** Number of unique font blobs written to the store. */
	uniqueCount: number;
	/** Total bytes stripped from all quills (before dedup). */
	totalStrippedBytes: number;
	/** Per-font breakdown. */
	files: FontStoreEntry[];
}

/** Filename of the font manifest inside a dehydrated ZIP. */
export const FONT_MANIFEST_NAME = 'fonts.json';

/** Extensions treated as font files for stripping. */
const FONT_EXT = /\.(ttf|otf|woff|woff2)$/i;

/** Returns true if the path ends with a font extension. */
export function isFontFile(filePath: string): boolean {
	return FONT_EXT.test(filePath);
}

/** Parses and validates a `fonts.json` payload. Throws on invalid input. */
export function parseFontManifest(json: string): FontManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new Error('fonts.json is not valid JSON');
	}

	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('fonts.json must be a JSON object');
	}

	const obj = raw as Record<string, unknown>;

	if (obj.version !== 1) {
		throw new Error(`Unsupported fonts.json version: ${String(obj.version)}`);
	}

	if (typeof obj.files !== 'object' || obj.files === null || Array.isArray(obj.files)) {
		throw new Error('fonts.json "files" must be a plain object');
	}

	const files = obj.files as Record<string, unknown>;
	for (const [path, hash] of Object.entries(files)) {
		if (typeof hash !== 'string' || !/^[0-9a-f]{32}$/.test(hash)) {
			throw new Error(`fonts.json: invalid hash for "${path}": ${String(hash)}`);
		}
	}

	return { version: 1, files: files as Record<string, string> };
}

/** Returns the deduplicated set of hashes from a font manifest. */
export function collectUniqueHashes(manifest: FontManifest): string[] {
	return [...new Set(Object.values(manifest.files))];
}
