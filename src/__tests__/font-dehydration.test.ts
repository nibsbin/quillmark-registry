import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FileSystemSource } from '../sources/file-system-source.js';
import { HttpSource } from '../sources/http-source.js';
import { unpackFiles, packFiles } from '../bundle.js';
import { parseFontManifest, FONT_MANIFEST_NAME } from '../fonts.js';
import type { QuillManifest } from '../types.js';

const FIXTURE_ROOT = path.join(import.meta.dirname, '../../.test-fixtures-fonts');
const TEST_DIR = path.join(FIXTURE_ROOT, 'quills');
const OUTPUT_DIR = path.join(FIXTURE_ROOT, 'output');

/** Fake TTF bytes (starts with a recognisable header but isn't a real font). */
function fakeFontBytes(seed: string): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(`FAKEFONT:${seed}:${'x'.repeat(200)}`);
}

function md5(data: Uint8Array): string {
	return createHash('md5').update(data).digest('hex');
}

async function createQuillDir(
	name: string,
	version: string,
	fonts?: Record<string, Uint8Array>,
) {
	const quillDir = path.join(TEST_DIR, name, version);
	await fs.mkdir(quillDir, { recursive: true });

	await fs.writeFile(
		path.join(quillDir, 'Quill.yaml'),
		`name: ${name}\nversion: ${version}`,
	);
	await fs.writeFile(path.join(quillDir, 'template.typ'), `// Template for ${name}`);

	if (fonts) {
		for (const [relPath, bytes] of Object.entries(fonts)) {
			const fullPath = path.join(quillDir, relPath);
			await fs.mkdir(path.dirname(fullPath), { recursive: true });
			await fs.writeFile(fullPath, bytes);
		}
	}
}

describe('Font dehydration (packageForHttp)', () => {
	beforeEach(async () => {
		await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
		await fs.mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
	});

	it('should strip font files from ZIP and include fonts.json', async () => {
		const interBytes = fakeFontBytes('Inter-Regular');
		await createQuillDir('memo', '1.0.0', {
			'assets/fonts/Inter-Regular.ttf': interBytes,
		});

		const source = new FileSystemSource(TEST_DIR);
		const { manifestFileName } = await source.packageForHttp(OUTPUT_DIR);

		const manifestContent = JSON.parse(
			await fs.readFile(path.join(OUTPUT_DIR, manifestFileName), 'utf-8'),
		);
		const entry = manifestContent.quills[0];
		const zipData = await fs.readFile(path.join(OUTPUT_DIR, entry.bundleFileName));
		const unpacked = await unpackFiles(new Uint8Array(zipData));

		// Font file should be stripped.
		expect(unpacked['assets/fonts/Inter-Regular.ttf']).toBeUndefined();

		// fonts.json should be present.
		expect(unpacked[FONT_MANIFEST_NAME]).toBeDefined();

		// Non-font files should be preserved.
		expect(unpacked['Quill.yaml']).toBeDefined();
		expect(unpacked['template.typ']).toBeDefined();

		// fonts.json should map the font to its MD5.
		const fontManifest = parseFontManifest(
			new TextDecoder().decode(unpacked[FONT_MANIFEST_NAME]),
		);
		expect(fontManifest.version).toBe(1);
		expect(fontManifest.files['assets/fonts/Inter-Regular.ttf']).toBe(md5(interBytes));
	});

	it('should write unique font blobs to store/', async () => {
		const interBytes = fakeFontBytes('Inter-Regular');
		const garamondBytes = fakeFontBytes('EBGaramond');
		await createQuillDir('memo', '1.0.0', {
			'assets/fonts/Inter-Regular.ttf': interBytes,
			'assets/fonts/EBGaramond.otf': garamondBytes,
		});

		const source = new FileSystemSource(TEST_DIR);
		await source.packageForHttp(OUTPUT_DIR);

		const storeFiles = await fs.readdir(path.join(OUTPUT_DIR, 'store'));
		expect(storeFiles).toHaveLength(2);
		expect(storeFiles).toContain(md5(interBytes));
		expect(storeFiles).toContain(md5(garamondBytes));

		// Verify store blob contents.
		const storedInter = await fs.readFile(path.join(OUTPUT_DIR, 'store', md5(interBytes)));
		expect(new Uint8Array(storedInter)).toEqual(interBytes);
	});

	it('should dedup identical fonts across quills', async () => {
		const sharedFont = fakeFontBytes('shared');
		await createQuillDir('memo', '1.0.0', { 'fonts/Inter.ttf': sharedFont });
		await createQuillDir('resume', '1.0.0', { 'assets/Inter.ttf': sharedFont });

		const source = new FileSystemSource(TEST_DIR);
		const { fonts } = await source.packageForHttp(OUTPUT_DIR);

		// Only one unique blob in the store.
		const storeFiles = await fs.readdir(path.join(OUTPUT_DIR, 'store'));
		expect(storeFiles).toHaveLength(1);

		// Dedup stats reflect both quills referencing the same hash.
		expect(fonts.uniqueCount).toBe(1);
		expect(fonts.totalStrippedBytes).toBe(sharedFont.length * 2);
		expect(fonts.files).toHaveLength(1);
		expect(fonts.files[0].quillCount).toBe(2);
		expect(fonts.files[0].hash).toBe(md5(sharedFont));
	});

	it('should dedup identical fonts within a single quill', async () => {
		const sharedFont = fakeFontBytes('shared');
		await createQuillDir('memo', '1.0.0', {
			'assets/fonts/Inter-Regular.ttf': sharedFont,
			'packages/pkg/fonts/Inter-Regular.ttf': sharedFont,
		});

		const source = new FileSystemSource(TEST_DIR);
		const { fonts } = await source.packageForHttp(OUTPUT_DIR);

		expect(fonts.uniqueCount).toBe(1);

		// Both paths appear in fonts.json with the same hash.
		const manifestContent = JSON.parse(
			await fs.readFile(path.join(OUTPUT_DIR, (await fs.readdir(OUTPUT_DIR)).find(f => f.endsWith('.json') && f.startsWith('manifest'))!), 'utf-8'),
		);
		const zipData = await fs.readFile(
			path.join(OUTPUT_DIR, manifestContent.quills[0].bundleFileName),
		);
		const unpacked = await unpackFiles(new Uint8Array(zipData));
		const fontManifest = parseFontManifest(
			new TextDecoder().decode(unpacked[FONT_MANIFEST_NAME]),
		);
		expect(Object.keys(fontManifest.files)).toHaveLength(2);
		const hashes = new Set(Object.values(fontManifest.files));
		expect(hashes.size).toBe(1);
	});

	it('should not create store/ or fonts.json when quill has no fonts', async () => {
		await createQuillDir('memo', '1.0.0');

		const source = new FileSystemSource(TEST_DIR);
		const { fonts } = await source.packageForHttp(OUTPUT_DIR);

		const topLevelFiles = await fs.readdir(OUTPUT_DIR);
		expect(topLevelFiles).not.toContain('store');

		expect(fonts.uniqueCount).toBe(0);
		expect(fonts.totalStrippedBytes).toBe(0);
		expect(fonts.files).toEqual([]);

		// ZIP should not contain fonts.json.
		const manifestContent = JSON.parse(
			await fs.readFile(path.join(OUTPUT_DIR, topLevelFiles.find(f => f.endsWith('.json'))!), 'utf-8'),
		);
		const zipData = await fs.readFile(
			path.join(OUTPUT_DIR, manifestContent.quills[0].bundleFileName),
		);
		const unpacked = await unpackFiles(new Uint8Array(zipData));
		expect(unpacked[FONT_MANIFEST_NAME]).toBeUndefined();
	});

	it('should handle all font extensions: .ttf, .otf, .woff, .woff2', async () => {
		await createQuillDir('memo', '1.0.0', {
			'fonts/a.ttf': fakeFontBytes('ttf'),
			'fonts/b.otf': fakeFontBytes('otf'),
			'fonts/c.woff': fakeFontBytes('woff'),
			'fonts/d.woff2': fakeFontBytes('woff2'),
		});

		const source = new FileSystemSource(TEST_DIR);
		await source.packageForHttp(OUTPUT_DIR);

		const manifestContent = JSON.parse(
			await fs.readFile(
				path.join(OUTPUT_DIR, (await fs.readdir(OUTPUT_DIR)).find(f => f.startsWith('manifest'))!),
				'utf-8',
			),
		);
		const zipData = await fs.readFile(
			path.join(OUTPUT_DIR, manifestContent.quills[0].bundleFileName),
		);
		const unpacked = await unpackFiles(new Uint8Array(zipData));

		// All four fonts stripped.
		expect(unpacked['fonts/a.ttf']).toBeUndefined();
		expect(unpacked['fonts/b.otf']).toBeUndefined();
		expect(unpacked['fonts/c.woff']).toBeUndefined();
		expect(unpacked['fonts/d.woff2']).toBeUndefined();

		// All four in manifest.
		const fontManifest = parseFontManifest(
			new TextDecoder().decode(unpacked[FONT_MANIFEST_NAME]),
		);
		expect(Object.keys(fontManifest.files)).toHaveLength(4);
	});

	it('should produce deterministic fonts.json (sorted paths)', async () => {
		const fontA = fakeFontBytes('a');
		const fontB = fakeFontBytes('b');
		await createQuillDir('memo', '1.0.0', {
			'z/font.ttf': fontA,
			'a/font.ttf': fontB,
		});

		const source = new FileSystemSource(TEST_DIR);
		const out1 = path.join(OUTPUT_DIR, 'run1');
		const out2 = path.join(OUTPUT_DIR, 'run2');
		await source.packageForHttp(out1);
		await new Promise((r) => setTimeout(r, 50));
		await source.packageForHttp(out2);

		const zip1Name = (await fs.readdir(out1)).find((f) => f.endsWith('.zip'))!;
		const zip2Name = (await fs.readdir(out2)).find((f) => f.endsWith('.zip'))!;
		expect(zip1Name).toBe(zip2Name);

		const zip1 = await fs.readFile(path.join(out1, zip1Name));
		const zip2 = await fs.readFile(path.join(out2, zip2Name));
		expect(zip1.equals(zip2)).toBe(true);
	});

	it('should return correct font dehydration summary', async () => {
		const fontA = fakeFontBytes('A');
		const fontB = fakeFontBytes('B');
		await createQuillDir('memo', '1.0.0', { 'fonts/A.ttf': fontA });
		await createQuillDir('resume', '1.0.0', {
			'fonts/A.ttf': fontA,
			'fonts/B.otf': fontB,
		});

		const source = new FileSystemSource(TEST_DIR);
		const { fonts } = await source.packageForHttp(OUTPUT_DIR);

		expect(fonts.uniqueCount).toBe(2);
		expect(fonts.totalStrippedBytes).toBe(fontA.length * 2 + fontB.length);

		const entryA = fonts.files.find((f) => f.hash === md5(fontA))!;
		expect(entryA).toBeDefined();
		expect(entryA.quillCount).toBe(2);
		expect(entryA.size).toBe(fontA.length);

		const entryB = fonts.files.find((f) => f.hash === md5(fontB))!;
		expect(entryB).toBeDefined();
		expect(entryB.quillCount).toBe(1);
	});
});

describe('Font rehydration (HttpSource.loadQuill)', () => {
	const MANIFEST_FILE = 'manifest.test99.json';

	function createMockFetch(
		responses: Record<string, { ok: boolean; status?: number; body?: unknown }>,
	) {
		return vi.fn(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url.toString();
			for (const [pattern, config] of Object.entries(responses)) {
				if (urlStr.includes(pattern)) {
					if (!config.ok) {
						return new Response(null, {
							status: config.status ?? 500,
							statusText: 'Error',
						});
					}
					if (config.body instanceof ArrayBuffer) {
						return new Response(config.body);
					}
					if (config.body instanceof Uint8Array) {
						return new Response(
							(config.body as Uint8Array).buffer.slice(
								(config.body as Uint8Array).byteOffset,
								(config.body as Uint8Array).byteOffset + (config.body as Uint8Array).byteLength,
							),
						);
					}
					return new Response(JSON.stringify(config.body));
				}
			}
			return new Response(null, { status: 404, statusText: 'Not Found' });
		}) as unknown as typeof globalThis.fetch;
	}

	async function createDehydratedBundle(
		name: string,
		version: string,
		fonts: Record<string, Uint8Array>,
	): Promise<{ zipBuffer: ArrayBuffer; fontHashes: Map<string, Uint8Array> }> {
		const encoder = new TextEncoder();
		const files: Record<string, Uint8Array> = {
			'Quill.yaml': encoder.encode(`name: ${name}\nversion: ${version}`),
			'template.typ': encoder.encode('// Template'),
		};

		const fontManifestFiles: Record<string, string> = {};
		const fontHashes = new Map<string, Uint8Array>();

		for (const [fontPath, bytes] of Object.entries(fonts)) {
			const hash = md5(bytes);
			fontManifestFiles[fontPath] = hash;
			fontHashes.set(hash, bytes);
		}

		files[FONT_MANIFEST_NAME] = encoder.encode(
			JSON.stringify({ version: 1, files: fontManifestFiles }),
		);

		const packed = await packFiles(files);
		return {
			zipBuffer: packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength),
			fontHashes,
		};
	}

	it('should fetch fonts from store and rehydrate the file tree', async () => {
		const interBytes = fakeFontBytes('Inter');
		const interHash = md5(interBytes);
		const { zipBuffer, fontHashes } = await createDehydratedBundle(
			'memo',
			'1.0.0',
			{ 'assets/fonts/Inter-Regular.ttf': interBytes },
		);

		const manifest: QuillManifest = {
			quills: [{ name: 'memo', version: '1.0.0', bundleFileName: 'memo@1.0.0.aaa.zip' }],
		};

		const mockFetch = createMockFetch({
			[MANIFEST_FILE]: { ok: true, body: manifest },
			'memo@1.0.0.aaa.zip': { ok: true, body: zipBuffer },
			[`store/${interHash}`]: { ok: true, body: fontHashes.get(interHash)! },
		});

		const source = new HttpSource({
			baseUrl: 'https://cdn.example.com/quills/',
			manifestFileName: MANIFEST_FILE,
			fetch: mockFetch,
		});

		const bundle = await source.loadQuill('memo', '1.0.0');

		// The engine tree should contain the rehydrated font.
		const data = bundle.data as { files: Record<string, unknown> };
		const assets = data.files['assets'] as Record<string, unknown>;
		const fonts = assets['fonts'] as Record<string, unknown>;
		const inter = fonts['Inter-Regular.ttf'] as { contents: number[] };
		expect(inter).toBeDefined();
		expect(inter.contents).toEqual(Array.from(interBytes));

		// fonts.json should NOT be in the tree.
		expect(data.files[FONT_MANIFEST_NAME]).toBeUndefined();

		// fontMap should be populated.
		expect(bundle.fontMap).toBeDefined();
		expect(bundle.fontMap!.size).toBe(1);
		expect(bundle.fontMap!.get(interHash)).toEqual(interBytes);
	});

	it('should fetch each unique hash only once for duplicate paths', async () => {
		const sharedFont = fakeFontBytes('shared');
		const sharedHash = md5(sharedFont);
		const { zipBuffer } = await createDehydratedBundle('memo', '1.0.0', {
			'fonts/Inter.ttf': sharedFont,
			'packages/pkg/fonts/Inter.ttf': sharedFont,
		});

		const manifest: QuillManifest = {
			quills: [{ name: 'memo', version: '1.0.0', bundleFileName: 'memo@1.0.0.aaa.zip' }],
		};

		const mockFetch = createMockFetch({
			[MANIFEST_FILE]: { ok: true, body: manifest },
			'memo@1.0.0.aaa.zip': { ok: true, body: zipBuffer },
			[`store/${sharedHash}`]: { ok: true, body: sharedFont },
		});

		const source = new HttpSource({
			baseUrl: 'https://cdn.example.com/quills/',
			manifestFileName: MANIFEST_FILE,
			fetch: mockFetch,
		});

		const bundle = await source.loadQuill('memo', '1.0.0');

		// Both paths rehydrated.
		const data = bundle.data as { files: Record<string, unknown> };
		const fontsDir = data.files['fonts'] as Record<string, unknown>;
		expect(fontsDir['Inter.ttf']).toBeDefined();
		const packages = data.files['packages'] as Record<string, unknown>;
		const pkg = packages['pkg'] as Record<string, unknown>;
		const pkgFonts = pkg['fonts'] as Record<string, unknown>;
		expect(pkgFonts['Inter.ttf']).toBeDefined();

		// Store fetch should only happen once per unique hash.
		const storeCalls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
			(call: unknown[]) => (call[0] as string).includes('store/'),
		);
		expect(storeCalls).toHaveLength(1);
	});

	it('should pass through non-dehydrated bundles unchanged', async () => {
		const encoder = new TextEncoder();
		const files: Record<string, Uint8Array> = {
			'Quill.yaml': encoder.encode('name: memo\nversion: 1.0.0'),
			'template.typ': encoder.encode('// Template'),
		};
		const packed = await packFiles(files);
		const zipBuffer = packed.buffer.slice(
			packed.byteOffset,
			packed.byteOffset + packed.byteLength,
		);

		const manifest: QuillManifest = {
			quills: [{ name: 'memo', version: '1.0.0', bundleFileName: 'memo@1.0.0.aaa.zip' }],
		};

		const mockFetch = createMockFetch({
			[MANIFEST_FILE]: { ok: true, body: manifest },
			'memo@1.0.0.aaa.zip': { ok: true, body: zipBuffer },
		});

		const source = new HttpSource({
			baseUrl: 'https://cdn.example.com/quills/',
			manifestFileName: MANIFEST_FILE,
			fetch: mockFetch,
		});

		const bundle = await source.loadQuill('memo', '1.0.0');
		expect(bundle.fontMap).toBeUndefined();

		const data = bundle.data as { files: Record<string, unknown> };
		expect(data.files['Quill.yaml']).toBeDefined();
		expect(data.files['template.typ']).toBeDefined();
	});

	it('should throw load_error when a font hash cannot be fetched', async () => {
		const interBytes = fakeFontBytes('Inter');
		const interHash = md5(interBytes);
		const { zipBuffer } = await createDehydratedBundle('memo', '1.0.0', {
			'fonts/Inter.ttf': interBytes,
		});

		const manifest: QuillManifest = {
			quills: [{ name: 'memo', version: '1.0.0', bundleFileName: 'memo@1.0.0.aaa.zip' }],
		};

		const mockFetch = createMockFetch({
			[MANIFEST_FILE]: { ok: true, body: manifest },
			'memo@1.0.0.aaa.zip': { ok: true, body: zipBuffer },
			[`store/${interHash}`]: { ok: false, status: 404 },
		});

		const source = new HttpSource({
			baseUrl: 'https://cdn.example.com/quills/',
			manifestFileName: MANIFEST_FILE,
			fetch: mockFetch,
		});

		await expect(source.loadQuill('memo', '1.0.0')).rejects.toThrow(/Failed to fetch font/);
	});

	it('should throw load_error on invalid fonts.json in ZIP', async () => {
		const encoder = new TextEncoder();
		const files: Record<string, Uint8Array> = {
			'Quill.yaml': encoder.encode('name: memo\nversion: 1.0.0'),
			[FONT_MANIFEST_NAME]: encoder.encode('not valid json'),
		};
		const packed = await packFiles(files);
		const zipBuffer = packed.buffer.slice(
			packed.byteOffset,
			packed.byteOffset + packed.byteLength,
		);

		const manifest: QuillManifest = {
			quills: [{ name: 'memo', version: '1.0.0', bundleFileName: 'memo@1.0.0.aaa.zip' }],
		};

		const mockFetch = createMockFetch({
			[MANIFEST_FILE]: { ok: true, body: manifest },
			'memo@1.0.0.aaa.zip': { ok: true, body: zipBuffer },
		});

		const source = new HttpSource({
			baseUrl: 'https://cdn.example.com/quills/',
			manifestFileName: MANIFEST_FILE,
			fetch: mockFetch,
		});

		await expect(source.loadQuill('memo', '1.0.0')).rejects.toThrow(/Invalid fonts\.json/);
	});
});

describe('End-to-end: packageForHttp -> HttpSource.loadQuill', () => {
	const E2E_ROOT = path.join(import.meta.dirname, '../../.test-fixtures-e2e');
	const E2E_TEST_DIR = path.join(E2E_ROOT, 'quills');
	const E2E_OUTPUT_DIR = path.join(E2E_ROOT, 'output');

	beforeEach(async () => {
		await fs.rm(E2E_ROOT, { recursive: true, force: true });
		await fs.mkdir(E2E_TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(E2E_ROOT, { recursive: true, force: true });
	});

	it('should round-trip: package with fonts -> load with rehydration -> identical data', async () => {
		const interBytes = fakeFontBytes('Inter-Regular');
		const boldBytes = fakeFontBytes('Inter-Bold');

		// Create a quill with fonts on disk.
		const quillDir = path.join(E2E_TEST_DIR, 'memo', '1.0.0');
		await fs.mkdir(quillDir, { recursive: true });
		await fs.writeFile(path.join(quillDir, 'Quill.yaml'), 'name: memo\nversion: 1.0.0');
		await fs.writeFile(path.join(quillDir, 'template.typ'), '// Template');
		const fontsDir = path.join(quillDir, 'assets', 'fonts');
		await fs.mkdir(fontsDir, { recursive: true });
		await fs.writeFile(path.join(fontsDir, 'Inter-Regular.ttf'), interBytes);
		await fs.writeFile(path.join(fontsDir, 'Inter-Bold.ttf'), boldBytes);

		// Load directly from filesystem (pre-strip, the reference).
		const fsSource = new FileSystemSource(E2E_TEST_DIR);
		const directBundle = await fsSource.loadQuill('memo', '1.0.0');

		// Package for HTTP (dehydrates fonts).
		const { manifestFileName } = await fsSource.packageForHttp(E2E_OUTPUT_DIR);

		// Create a mock fetch that serves the packaged output directory.
		const mockFetch = vi.fn(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url.toString();
			const urlPath = new URL(urlStr).pathname.replace(/^\/quills\//, '');
			const filePath = path.join(E2E_OUTPUT_DIR, urlPath);
			try {
				const data = await fs.readFile(filePath);
				return new Response(
					data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
				);
			} catch {
				return new Response(null, { status: 404, statusText: 'Not Found' });
			}
		}) as unknown as typeof globalThis.fetch;

		// Load via HttpSource (rehydrates fonts).
		const httpSource = new HttpSource({
			baseUrl: 'https://cdn.example.com/quills/',
			manifestFileName,
			fetch: mockFetch,
		});

		const httpBundle = await httpSource.loadQuill('memo', '1.0.0');

		// The engine data should be identical.
		expect(httpBundle.data).toEqual(directBundle.data);

		// fontMap should be present.
		expect(httpBundle.fontMap).toBeDefined();
		expect(httpBundle.fontMap!.size).toBe(2);
	});
});
