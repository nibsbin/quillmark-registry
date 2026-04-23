import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Quillmark, init } from '@quillmark/wasm';
import { QuillRegistry } from '../registry.js';
import { FileSystemSource } from '../sources/file-system-source.js';
import { HttpSource } from '../sources/http-source.js';
import type { QuillManifest } from '../types.js';

/** Path to the minimal quill fixtures for integration tests. */
const QUILLS_DIR = path.join(import.meta.dirname, 'fixtures/quills');

/** Temp directory for packageForHttp output. */
const HTTP_OUTPUT_DIR = path.join(import.meta.dirname, '../../.test-fixtures-compat');

describe('engine.quill() compatibility with @quillmark/wasm', () => {
	let wasm: Quillmark;

	beforeAll(() => {
		init();
	});

	afterEach(async () => {
		await fs.rm(HTTP_OUTPUT_DIR, { recursive: true, force: true });
	});

	describe('FileSystemSource → real Quillmark engine', () => {
		it('should attach minimal_quill from filesystem fixtures', async () => {
			wasm = new Quillmark();
			const source = new FileSystemSource(QUILLS_DIR);
			const registry = new QuillRegistry({ source, engine: wasm });

			const bundle = await registry.resolve('minimal_quill');

			expect(bundle.name).toBe('minimal_quill');
			expect(bundle.version).toBe('0.1.0');
			expect(bundle.quill).toBeDefined();
			expect(bundle.quill!.backendId).toBe('typst');
			expect(registry.isLoaded('minimal_quill')).toBe(true);
			expect(registry.listLoaded()).toContain('minimal_quill@0.1.0');

			wasm.free();
		});

		it('should attach all quills from the fixtures', async () => {
			wasm = new Quillmark();
			const source = new FileSystemSource(QUILLS_DIR);
			const registry = new QuillRegistry({ source, engine: wasm });
			const manifest = await registry.getManifest();

			for (const quill of manifest.quills) {
				await registry.resolve(`${quill.name}@${quill.version}`);
			}

			const listed = registry.listLoaded();
			for (const quill of manifest.quills) {
				expect(listed).toContain(`${quill.name}@${quill.version}`);
			}

			wasm.free();
		});

		it('should not re-attach a quill already loaded by the registry', async () => {
			wasm = new Quillmark();
			const spy = vi.spyOn(wasm, 'quill');
			const source = new FileSystemSource(QUILLS_DIR);
			const registry = new QuillRegistry({ source, engine: wasm });

			await registry.resolve('minimal_quill');
			expect(spy).toHaveBeenCalledTimes(1);

			// Second resolve: registry cache hit, skips engine.quill()
			await registry.resolve('minimal_quill');
			expect(spy).toHaveBeenCalledTimes(1);

			spy.mockRestore();
			wasm.free();
		});
	});

	describe('HttpSource → real Quillmark engine', () => {
		it('should attach minimal_quill loaded via HttpSource bundle', async () => {
			wasm = new Quillmark();

			// Package the fixtures for HTTP
			const fsSource = new FileSystemSource(QUILLS_DIR);
			const { manifestFileName } = await fsSource.packageForHttp(HTTP_OUTPUT_DIR);

			const manifestJson = await fs.readFile(
				path.join(HTTP_OUTPUT_DIR, manifestFileName),
				'utf-8',
			);

			const mockFetch = vi.fn(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url.toString();
				if (urlStr.includes(manifestFileName)) {
					return new Response(manifestJson);
				}
				const bundleMatch = urlStr.match(/\/([^/?]+\.zip)/);
				if (bundleMatch) {
					const bundlePath = path.join(HTTP_OUTPUT_DIR, bundleMatch[1]);
					try {
						const bundleData = await fs.readFile(bundlePath);
						return new Response(bundleData);
					} catch {
						return new Response(null, { status: 404 });
					}
				}
				return new Response(null, { status: 404 });
			}) as unknown as typeof globalThis.fetch;

			const httpSource = new HttpSource({
				baseUrl: 'https://cdn.example.com/quills/',
				manifestFileName,
				fetch: mockFetch,
			});
			const registry = new QuillRegistry({ source: httpSource, engine: wasm });

			const bundle = await registry.resolve('minimal_quill');

			expect(bundle.name).toBe('minimal_quill');
			expect(bundle.version).toBe('0.1.0');
			expect(bundle.quill).toBeDefined();
			expect(bundle.quill!.backendId).toBe('typst');
			expect(registry.listLoaded()).toContain('minimal_quill@0.1.0');

			wasm.free();
		});

		it('should attach all quills via HttpSource bundles', async () => {
			wasm = new Quillmark();

			const fsSource = new FileSystemSource(QUILLS_DIR);
			const { manifestFileName } = await fsSource.packageForHttp(HTTP_OUTPUT_DIR);

			const manifestJson = await fs.readFile(
				path.join(HTTP_OUTPUT_DIR, manifestFileName),
				'utf-8',
			);
			const manifest = JSON.parse(manifestJson) as QuillManifest;

			const mockFetch = vi.fn(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url.toString();
				if (urlStr.includes(manifestFileName)) {
					return new Response(manifestJson);
				}
				const bundleMatch = urlStr.match(/\/([^/?]+\.zip)/);
				if (bundleMatch) {
					const bundlePath = path.join(HTTP_OUTPUT_DIR, bundleMatch[1]);
					try {
						const bundleData = await fs.readFile(bundlePath);
						return new Response(bundleData);
					} catch {
						return new Response(null, { status: 404 });
					}
				}
				return new Response(null, { status: 404 });
			}) as unknown as typeof globalThis.fetch;

			const httpSource = new HttpSource({
				baseUrl: 'https://cdn.example.com/quills/',
				manifestFileName,
				fetch: mockFetch,
			});
			const registry = new QuillRegistry({ source: httpSource, engine: wasm });

			for (const quill of manifest.quills) {
				await registry.resolve(`${quill.name}@${quill.version}`);
			}

			const listed = registry.listLoaded();
			for (const quill of manifest.quills) {
				expect(listed).toContain(`${quill.name}@${quill.version}`);
			}

			wasm.free();
		});
	});

	describe('FileSystemSource → packageForHttp → HttpSource roundtrip', () => {
		it('should produce identical attachments through the full roundtrip', async () => {
			const fsSource = new FileSystemSource(QUILLS_DIR);
			const { manifestFileName } = await fsSource.packageForHttp(HTTP_OUTPUT_DIR);

			const manifestJson = await fs.readFile(
				path.join(HTTP_OUTPUT_DIR, manifestFileName),
				'utf-8',
			);

			const mockFetch = vi.fn(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url.toString();
				if (urlStr.includes(manifestFileName)) {
					return new Response(manifestJson);
				}
				const bundleMatch = urlStr.match(/\/([^/?]+\.zip)/);
				if (bundleMatch) {
					const bundlePath = path.join(HTTP_OUTPUT_DIR, bundleMatch[1]);
					try {
						const bundleData = await fs.readFile(bundlePath);
						return new Response(bundleData);
					} catch {
						return new Response(null, { status: 404 });
					}
				}
				return new Response(null, { status: 404 });
			}) as unknown as typeof globalThis.fetch;

			const httpSource = new HttpSource({
				baseUrl: 'https://cdn.example.com/quills/',
				manifestFileName,
				fetch: mockFetch,
			});

			const fsWasm = new Quillmark();
			const fsRegistry = new QuillRegistry({ source: fsSource, engine: fsWasm });
			const fsBundle = await fsRegistry.resolve('minimal_quill');

			const httpWasm = new Quillmark();
			const httpRegistry = new QuillRegistry({ source: httpSource, engine: httpWasm });
			const httpBundle = await httpRegistry.resolve('minimal_quill');

			expect(fsBundle.name).toBe(httpBundle.name);
			expect(fsBundle.version).toBe(httpBundle.version);
			expect(fsBundle.quill!.backendId).toBe(httpBundle.quill!.backendId);

			fsWasm.free();
			httpWasm.free();
		});
	});
});
