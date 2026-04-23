import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateQuillsFromDir } from '../node.js';
import type { QuillHandle, QuillmarkEngine } from '../types.js';

/** Engine where the Quill handle throws a Map payload on render — mimics structured wasm error. */
class ThrowingRenderEngine implements QuillmarkEngine {
	quill(): QuillHandle {
		return {
			backendId: 'typst',
			render(): never {
				throw new Map([
					['code', 'typst_error'],
					['message', 'Unknown field "name"'],
				]);
			},
		};
	}
}

describe('validateQuills error formatting', () => {
	it('serializes structured render errors for consumers', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'quill-registry-test-'));
		const quillsDir = path.join(tempRoot, 'quills');
		const quillVersionDir = path.join(quillsDir, 'sample', '0.1.0');
		await fs.mkdir(quillVersionDir, { recursive: true });
		await fs.writeFile(
			path.join(quillVersionDir, 'Quill.yaml'),
			'name: sample\nversion: 0.1.0\nexample_file: example.md\n',
		);
		await fs.writeFile(
			path.join(quillVersionDir, 'example.md'),
			'---\nQUILL: sample@0.1.0\n---\n\nbody\n',
		);

		try {
			const result = await validateQuillsFromDir({
				quillsDir,
				engine: new ThrowingRenderEngine(),
				parseDocument: () => ({}),
			});

			expect(result.failed).toBe(1);
			expect(result.results).toHaveLength(1);
			expect(result.results[0].registered).toBe(true);
			expect(result.results[0].rendered).toBe(false);
			expect(result.results[0].error).toContain('"type": "Map"');
			expect(result.results[0].error).toContain('typst_error');
			expect(result.results[0].error).toContain('Unknown field \\"name\\"');
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
