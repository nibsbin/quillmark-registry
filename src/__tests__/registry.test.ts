import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuillRegistry } from '../registry.js';
import { RegistryError } from '../errors.js';
import type {
	QuillBundle,
	QuillData,
	QuillHandle,
	QuillManifest,
	QuillmarkEngine,
	QuillSource,
} from '../types.js';

function createMockBundle(name: string, version: string): QuillBundle {
	const yaml = `Quill:\n  name: ${name}\n  version: ${version}\n  backend: typst\n  description: ${name} fixture\n  plate_file: plate.typ\n`;
	const data: QuillData = new Map([
		['Quill.yaml', new TextEncoder().encode(yaml)],
		['plate.typ', new TextEncoder().encode(`// ${name}`)],
	]);
	return {
		name,
		version,
		data,
		metadata: { name, version },
	};
}

function createMockSource(bundles: QuillBundle[]): QuillSource {
	const manifest: QuillManifest = {
		quills: bundles.map((b) => ({ name: b.name, version: b.version })),
	};
	return {
		getManifest: vi.fn(async () => manifest),
		loadQuill: vi.fn(async (name: string, version: string) => {
			const bundle = bundles.find((b) => b.name === name && b.version === version);
			if (!bundle) {
				if (version && bundles.some((b) => b.name === name)) {
					throw new RegistryError('version_not_found', `Version ${version} not found`, {
						quillName: name,
						version,
					});
				}
				throw new RegistryError('quill_not_found', `Quill ${name} not found`, {
					quillName: name,
				});
			}
			return bundle;
		}),
	};
}

function createMockHandle(): QuillHandle {
	return {
		backendId: 'typst',
		render: vi.fn(() => ({
			artifacts: [
				{ bytes: new Uint8Array([1, 2, 3]), format: 'pdf', mimeType: 'application/pdf' },
			],
			warnings: [],
			outputFormat: 'pdf',
			renderTimeMs: 1,
		})),
	};
}

function createMockEngine(): QuillmarkEngine {
	return {
		quill: vi.fn(() => createMockHandle()),
	};
}

describe('QuillRegistry', () => {
	let source: QuillSource;
	let engine: QuillmarkEngine;
	let bundles: QuillBundle[];

	beforeEach(() => {
		bundles = [
			createMockBundle('usaf_memo', '1.0.0'),
			createMockBundle('classic_resume', '2.1.0'),
		];
		source = createMockSource(bundles);
		engine = createMockEngine();
	});

	describe('getManifest()', () => {
		it('should delegate to source', async () => {
			const registry = new QuillRegistry({ source, engine });
			const manifest = await registry.getManifest();
			expect(manifest).toEqual({
				quills: [
					{ name: 'usaf_memo', version: '1.0.0' },
					{ name: 'classic_resume', version: '2.1.0' },
				],
			});
			expect(source.getManifest).toHaveBeenCalledOnce();
		});
	});

	describe('getAvailableQuills()', () => {
		it('should return metadata from manifest', async () => {
			const registry = new QuillRegistry({ source, engine });
			const quills = await registry.getAvailableQuills();
			expect(quills).toHaveLength(2);
			expect(quills[0].name).toBe('usaf_memo');
			expect(quills[1].name).toBe('classic_resume');
		});
	});

	describe('resolve()', () => {
		it('should load quill from source and attach to engine', async () => {
			const registry = new QuillRegistry({ source, engine });
			const bundle = await registry.resolve('usaf_memo');

			expect(bundle.name).toBe('usaf_memo');
			expect(bundle.version).toBe('1.0.0');
			expect(source.loadQuill).toHaveBeenCalledWith('usaf_memo', '1.0.0');
			expect(engine.quill).toHaveBeenCalledWith(bundle.data);
			expect(bundle.quill).toBeDefined();
			expect(bundle.quill!.backendId).toBe('typst');
		});

		it('should resolve with specific version', async () => {
			const registry = new QuillRegistry({ source, engine });
			const bundle = await registry.resolve('usaf_memo@1.0.0');

			expect(bundle.name).toBe('usaf_memo');
			expect(bundle.version).toBe('1.0.0');
			expect(source.loadQuill).toHaveBeenCalledWith('usaf_memo', '1.0.0');
		});

		it('should resolve semver selector with missing segments to highest matching version', async () => {
			bundles = [
				createMockBundle('usaf_memo', '1.0.0'),
				createMockBundle('usaf_memo', '1.2.0'),
				createMockBundle('usaf_memo', '2.0.0'),
			];
			source = createMockSource(bundles);
			const registry = new QuillRegistry({ source, engine });

			const bundleMajor = await registry.resolve('usaf_memo@1');
			expect(bundleMajor.version).toBe('1.2.0');

			const bundleMinor = await registry.resolve('usaf_memo@1.0');
			expect(bundleMinor.version).toBe('1.0.0');
		});

		it('should throw version_not_found when semver selector has no matches', async () => {
			const registry = new QuillRegistry({ source, engine });
			await expect(registry.resolve('usaf_memo@3')).rejects.toThrow(RegistryError);
		});

		it('should throw quill_not_found when semver selector targets missing quill name', async () => {
			const registry = new QuillRegistry({ source, engine });
			await expect(registry.resolve('nonexistent@1')).rejects.toMatchObject({
				code: 'quill_not_found',
			});
		});

		it('should skip re-attaching already-attached quills', async () => {
			const registry = new QuillRegistry({ source, engine });

			// First resolve: hits source and attaches handle
			await registry.resolve('usaf_memo');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);
			expect(source.getManifest).toHaveBeenCalledTimes(1);
			expect(engine.quill).toHaveBeenCalledTimes(1);

			// Second resolve: re-evaluates latest from startup-loaded manifest,
			// reuses canonical fetch without reloading manifest or re-attaching.
			await registry.resolve('usaf_memo');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);
			expect(source.getManifest).toHaveBeenCalledTimes(1);
			expect(engine.quill).toHaveBeenCalledTimes(1);
		});

		it('should use registry cache for versioned lookups', async () => {
			const registry = new QuillRegistry({ source, engine });

			// First resolve
			await registry.resolve('usaf_memo@1.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);

			// Second resolve with same version: hits registry cache
			await registry.resolve('usaf_memo@1.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);
			expect(engine.quill).toHaveBeenCalledTimes(1);
		});

		it('should reuse cached versioned bundle for unversioned resolve after fetch', async () => {
			const registry = new QuillRegistry({ source, engine });

			await registry.fetch('usaf_memo@1.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);
			expect(engine.quill).toHaveBeenCalledTimes(0);

			const bundle = await registry.resolve('usaf_memo');
			expect(bundle.version).toBe('1.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);
			expect(engine.quill).toHaveBeenCalledTimes(1);
		});

		it('should pick highest cached version for unversioned resolve', async () => {
			bundles = [
				createMockBundle('usaf_memo', '1.0.0'),
				createMockBundle('usaf_memo', '2.0.0'),
			];
			source = createMockSource(bundles);
			const registry = new QuillRegistry({ source, engine });

			await registry.resolve('usaf_memo@1.0.0');
			await registry.resolve('usaf_memo@2.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(2);

			const bundle = await registry.resolve('usaf_memo');
			expect(bundle.version).toBe('2.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(2);
			expect(engine.quill).toHaveBeenCalledTimes(2);
		});

		it('should coalesce concurrent resolve() calls for the same ref', async () => {
			const registry = new QuillRegistry({ source, engine });
			const deferred = Promise.withResolvers<QuillBundle>();
			vi.mocked(source.loadQuill).mockReturnValueOnce(deferred.promise);

			const first = registry.resolve('usaf_memo@1.0.0');
			const second = registry.resolve('usaf_memo@1.0.0');

			expect(source.loadQuill).toHaveBeenCalledTimes(1);

			deferred.resolve(createMockBundle('usaf_memo', '1.0.0'));
			const [firstResolved, secondResolved] = await Promise.all([first, second]);
			expect(firstResolved).toBe(secondResolved);
			expect(firstResolved).toMatchObject({ name: 'usaf_memo', version: '1.0.0' });
			expect(firstResolved.quill).toBeDefined();
			expect(engine.quill).toHaveBeenCalledTimes(1);
		});

		it('should resolve a prefetched bundle after engine is attached later', async () => {
			const registry = new QuillRegistry({ source });
			await registry.fetch('usaf_memo@1.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);

			registry.setEngine(engine);
			const bundle = await registry.resolve('usaf_memo@1.0.0');
			expect(bundle.version).toBe('1.0.0');
			expect(source.loadQuill).toHaveBeenCalledTimes(1);
			expect(engine.quill).toHaveBeenCalledTimes(1);
			expect(bundle.quill).toBeDefined();
		});

		it('should fail fast when resolve is called without an engine', async () => {
			const registry = new QuillRegistry({ source });
			await expect(registry.resolve('usaf_memo')).rejects.toThrow(
				'resolve() requires an attached engine',
			);
			expect(source.loadQuill).not.toHaveBeenCalled();
		});

		it('should throw quill_not_found for unknown quill', async () => {
			const registry = new QuillRegistry({ source, engine });

			try {
				await registry.resolve('nonexistent');
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(RegistryError);
				expect((err as RegistryError).code).toBe('quill_not_found');
			}
		});

		it('should throw version_not_found for wrong version', async () => {
			const registry = new QuillRegistry({ source, engine });

			try {
				await registry.resolve('usaf_memo@9.9.9');
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(RegistryError);
				expect((err as RegistryError).code).toBe('version_not_found');
			}
		});
	});

	describe('fetch()', () => {
		it('should fetch a canonical quill ref without attaching', async () => {
			const registry = new QuillRegistry({ source, engine });
			const bundle = await registry.fetch('usaf_memo@1.0.0');

			expect(bundle.name).toBe('usaf_memo');
			expect(bundle.version).toBe('1.0.0');
			expect(source.loadQuill).toHaveBeenCalledWith('usaf_memo', '1.0.0');
			expect(engine.quill).toHaveBeenCalledTimes(0);
			expect(bundle.quill).toBeUndefined();
		});

		it('should reject non-canonical refs', async () => {
			const registry = new QuillRegistry({ source, engine });
			await expect(registry.fetch('usaf_memo')).rejects.toThrow(
				'fetch() requires a canonical ref',
			);
		});

		it('should reject non-canonical semver selectors', async () => {
			const registry = new QuillRegistry({ source, engine });
			await expect(registry.fetch('usaf_memo@1')).rejects.toThrow(
				'fetch() requires a canonical ref',
			);
		});
	});

	describe('isLoaded() / getQuill() / listLoaded()', () => {
		it('should return false for unloaded quill', () => {
			const registry = new QuillRegistry({ source, engine });
			expect(registry.isLoaded('usaf_memo')).toBe(false);
			expect(registry.getQuill('usaf_memo@1.0.0')).toBeNull();
			expect(registry.listLoaded()).toEqual([]);
		});

		it('should return true after resolve()', async () => {
			const registry = new QuillRegistry({ source, engine });
			await registry.resolve('usaf_memo');
			expect(registry.isLoaded('usaf_memo')).toBe(true);
			expect(registry.isLoaded('usaf_memo@1.0.0')).toBe(true);
			expect(registry.getQuill('usaf_memo@1.0.0')).not.toBeNull();
			expect(registry.listLoaded()).toEqual(['usaf_memo@1.0.0']);
		});

		it('should return false for different quill', async () => {
			const registry = new QuillRegistry({ source, engine });
			await registry.resolve('usaf_memo');
			expect(registry.isLoaded('classic_resume')).toBe(false);
			expect(registry.getQuill('classic_resume@2.1.0')).toBeNull();
		});
	});
});
