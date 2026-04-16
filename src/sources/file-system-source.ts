import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { QuillBundle, QuillManifest, QuillMetadata, QuillSource } from '../types.js';
import { RegistryError } from '../errors.js';
import { toEngineFileTree } from '../format.js';
import { packDirectory, packFiles } from '../bundle.js';
import { isFontFile, FONT_MANIFEST_NAME } from '../fonts.js';
import type { FontManifest, FontDehydrationSummary } from '../fonts.js';

/** Reads files from a directory recursively, returning a map of relative paths to contents. */
async function readDirRecursive(
	dirPath: string,
	basePath: string = dirPath,
): Promise<Record<string, Uint8Array>> {
	const files: Record<string, Uint8Array> = {};
	const entries = await fs.readdir(dirPath, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);
		const relativePath = path.relative(basePath, fullPath);

		if (entry.isDirectory()) {
			const subFiles = await readDirRecursive(fullPath, basePath);
			Object.assign(files, subFiles);
		} else if (entry.isFile()) {
			files[relativePath] = new Uint8Array(await fs.readFile(fullPath));
		}
	}

	return files;
}

/** Lists files in a directory recursively, returning relative paths (without reading contents). */
async function listFilesRecursive(
	dirPath: string,
	basePath: string = dirPath,
): Promise<string[]> {
	const paths: string[] = [];
	const entries = await fs.readdir(dirPath, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);

		if (entry.isDirectory()) {
			paths.push(...(await listFilesRecursive(fullPath, basePath)));
		} else if (entry.isFile()) {
			paths.push(path.relative(basePath, fullPath));
		}
	}

	return paths;
}

/** Full lowercase MD5 hex digest. */
function md5Full(data: Uint8Array): string {
	return createHash('md5').update(data).digest('hex');
}

/** First 6 lowercase hex chars of MD5 (for cache-busted filenames). */
function md5Prefix6(data: Uint8Array | string): string {
	const hash = createHash('md5');
	if (typeof data === 'string') {
		hash.update(data, 'utf8');
	} else {
		hash.update(data);
	}
	return hash.digest('hex').slice(0, 6);
}

/**
 * Verifies that a Quill.yaml file exists in the given quill directory.
 * Name and version are derived from the directory structure; Quill.yaml
 * content is parsed by the @quillmark/wasm engine at registration time.
 */
async function assertQuillYamlExists(quillDir: string): Promise<void> {
	const yamlPath = path.join(quillDir, 'Quill.yaml');
	try {
		await fs.access(yamlPath);
	} catch {
		throw new RegistryError('load_error', `Missing Quill.yaml in ${quillDir}`);
	}
}

/** Lists subdirectories of a given directory. Filters out dot-prefixed entries. */
async function listSubdirectories(dirPath: string): Promise<string[]> {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
		.map((e) => e.name);
}

/** Returns true if the string is exactly a three-part semver version (digits and dots only). */
function isSemver(value: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(value);
}

/**
 * Node.js-only QuillSource that reads Quill directories from the local filesystem.
 *
 * Expects a versioned directory layout:
 *
 * ```
 * quillsDir/
 *   usaf_memo/
 *     0.1.0/
 *       Quill.yaml
 *       template.typ
 *     1.0.0/
 *       Quill.yaml
 *       template.typ
 *   classic_resume/
 *     2.1.0/
 *       Quill.yaml
 *       template.typ
 * ```
 *
 * Each version directory must contain a `Quill.yaml` file. Name and version are
 * derived from the directory structure; Quill.yaml content is validated by the
 * @quillmark/wasm engine at registration time.
 *
 * Also exposes `packageForHttp(outputDir)` to create hashed zip bundles and a hashed
 * manifest JSON file for static hosting (CDN-friendly cache keys).
 */
export class FileSystemSource implements QuillSource {
	private quillsDir: string;

	constructor(quillsDir: string) {
		this.quillsDir = quillsDir;
	}

	async getManifest(): Promise<QuillManifest> {
		let quillNames: string[];
		try {
			quillNames = await listSubdirectories(this.quillsDir);
		} catch (err) {
			throw new RegistryError(
				'source_unavailable',
				`Failed to read quills directory: ${this.quillsDir}`,
				{ cause: err },
			);
		}

		const quills: QuillMetadata[] = [];
		for (const quillName of quillNames) {
			const quillNameDir = path.join(this.quillsDir, quillName);
			let versionDirs: string[];
			try {
				versionDirs = await listSubdirectories(quillNameDir);
			} catch {
				// Skip entries that aren't readable directories
				continue;
			}

			for (const versionDir of versionDirs) {
				if (!isSemver(versionDir)) continue;
				const versionPath = path.join(quillNameDir, versionDir);
				try {
					await assertQuillYamlExists(versionPath);
					quills.push({ name: quillName, version: versionDir });
				} catch (err) {
					if (err instanceof RegistryError) throw err;
					// Skip directories without valid Quill.yaml
				}
			}
		}

		return { quills };
	}

	async loadQuill(name: string, version: string): Promise<QuillBundle> {
		const quillDir = path.join(this.quillsDir, name, version);

		// Verify directory exists
		try {
			await fs.access(quillDir);
		} catch {
			// Check if the quill name exists at all to give a better error
			const nameDir = path.join(this.quillsDir, name);
			try {
				await fs.access(nameDir);
				// Name exists but version doesn't
				throw new RegistryError(
					'version_not_found',
					`Quill "${name}" exists but version "${version}" was not found`,
					{ quillName: name, version },
				);
			} catch (err) {
				if (err instanceof RegistryError) throw err;
				throw new RegistryError('quill_not_found', `Quill "${name}" not found in source`, {
					quillName: name,
					version,
				});
			}
		}

		await assertQuillYamlExists(quillDir);

		const metadata: QuillMetadata = { name, version };

		let files: Record<string, Uint8Array>;
		try {
			files = await readDirRecursive(quillDir);
		} catch (err) {
			throw new RegistryError('load_error', `Failed to read quill directory: ${quillDir}`, {
				quillName: name,
				version,
				cause: err,
			});
		}

		return {
			name,
			version,
			data: toEngineFileTree(files),
			metadata,
		};
	}

	/**
	 * Packages all quills for HTTP static hosting.
	 * Clears `outputDir`, then writes content-addressed `.zip` bundles,
	 * `manifest.{md5prefix6}.json`, and a `store/` directory containing
	 * deduplicated font blobs keyed by MD5 hash.
	 *
	 * Font files (`*.ttf`, `*.otf`, `*.woff`, `*.woff2`) are stripped from
	 * each ZIP and replaced by a `fonts.json` sidecar manifest that maps
	 * original paths to content hashes.
	 */
	async packageForHttp(
		outputDir: string,
	): Promise<{ manifestFileName: string; fonts: FontDehydrationSummary }> {
		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });

		const manifest = await this.getManifest();
		const seenRefs = new Set<string>();
		for (const entry of manifest.quills) {
			const ref = `${entry.name}@${entry.version}`;
			if (seenRefs.has(ref)) {
				throw new RegistryError(
					'load_error',
					`Duplicate quill entry "${ref}" found while packaging manifest`,
				);
			}
			seenRefs.add(ref);
		}

		// Track font usage across all quills for dedup reporting.
		const fontUsage = new Map<string, { fileName: string; quillCount: number; size: number }>();
		let totalStrippedBytes = 0;
		const writtenHashes = new Set<string>();
		let storeCreated = false;

		const packagedQuills: QuillMetadata[] = [];
		for (const entry of manifest.quills) {
			const quillDir = path.join(this.quillsDir, entry.name, entry.version);
			const allFiles = await readDirRecursive(quillDir);

			// Separate fonts from non-font files.
			const packable: Record<string, Uint8Array> = {};
			const fonts: Record<string, Uint8Array> = {};
			for (const [filePath, bytes] of Object.entries(allFiles)) {
				if (isFontFile(filePath)) {
					fonts[filePath] = bytes;
				} else {
					packable[filePath] = bytes;
				}
			}

			// Dehydrate: strip fonts, write to store, inject fonts.json.
			if (Object.keys(fonts).length > 0) {
				const manifestFiles: Record<string, string> = {};
				const sortedPaths = Object.keys(fonts).sort();

				for (const fontPath of sortedPaths) {
					const bytes = fonts[fontPath];
					const hash = md5Full(bytes);
					manifestFiles[fontPath] = hash;
					totalStrippedBytes += bytes.length;

					// Track dedup signal.
					const existing = fontUsage.get(hash);
					if (existing) {
						existing.quillCount++;
					} else {
						fontUsage.set(hash, {
							fileName: path.basename(fontPath),
							quillCount: 1,
							size: bytes.length,
						});
					}

					// Write to store (idempotent within this run).
					if (!writtenHashes.has(hash)) {
						if (!storeCreated) {
							await fs.mkdir(path.join(outputDir, 'store'), { recursive: true });
							storeCreated = true;
						}
						await fs.writeFile(path.join(outputDir, 'store', hash), bytes);
						writtenHashes.add(hash);
					}
				}

				const fontManifest: FontManifest = { version: 1, files: manifestFiles };
				packable[FONT_MANIFEST_NAME] = new TextEncoder().encode(
					JSON.stringify(fontManifest, null, 2),
				);
			}

			const packed = await packFiles(packable);
			const contentHash = md5Prefix6(packed);
			const bundleFileName = `${entry.name}@${entry.version}.${contentHash}.zip`;
			await fs.writeFile(path.join(outputDir, bundleFileName), packed);
			packagedQuills.push({
				...entry,
				bundleFileName,
			});
		}

		const packagedManifest: QuillManifest = { quills: packagedQuills };
		const manifestJson = JSON.stringify(packagedManifest, null, 2);
		const manifestFileName = `manifest.${md5Prefix6(manifestJson)}.json`;
		await fs.writeFile(path.join(outputDir, manifestFileName), manifestJson);

		const fonts: FontDehydrationSummary = {
			uniqueCount: fontUsage.size,
			totalStrippedBytes,
			files: [...fontUsage.entries()].map(([hash, info]) => ({
				fileName: info.fileName,
				hash,
				size: info.size,
				quillCount: info.quillCount,
			})),
		};

		return { manifestFileName, fonts };
	}

}
