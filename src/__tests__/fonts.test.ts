import { describe, it, expect } from 'vitest';
import {
	isFontFile,
	parseFontManifest,
	collectUniqueHashes,
	FONT_MANIFEST_NAME,
} from '../fonts.js';

describe('isFontFile', () => {
	it.each([
		'assets/fonts/Inter-Regular.ttf',
		'fonts/Bold.otf',
		'packages/pkg/font.woff',
		'deep/path/font.woff2',
		'UPPER.TTF',
		'mixed.Otf',
	])('should return true for font path: %s', (p) => {
		expect(isFontFile(p)).toBe(true);
	});

	it.each([
		'template.typ',
		'Quill.yaml',
		'assets/image.png',
		'README.md',
		'fonts.json',
		'font.ttf.bak',
	])('should return false for non-font path: %s', (p) => {
		expect(isFontFile(p)).toBe(false);
	});
});

describe('parseFontManifest', () => {
	it('should parse a valid manifest', () => {
		const json = JSON.stringify({
			version: 1,
			files: {
				'assets/fonts/Inter-Regular.ttf': '3f2a8c1d9e4b5a7f0c8d6e3a1b4f9c2d',
				'assets/fonts/Inter-Bold.ttf': 'a7e3b2d5f0c8e1a4b7d2f5c9e0a3b6d1',
			},
		});
		const manifest = parseFontManifest(json);
		expect(manifest.version).toBe(1);
		expect(Object.keys(manifest.files)).toHaveLength(2);
		expect(manifest.files['assets/fonts/Inter-Regular.ttf']).toBe(
			'3f2a8c1d9e4b5a7f0c8d6e3a1b4f9c2d',
		);
	});

	it('should parse a manifest with no files', () => {
		const manifest = parseFontManifest(JSON.stringify({ version: 1, files: {} }));
		expect(manifest.version).toBe(1);
		expect(Object.keys(manifest.files)).toHaveLength(0);
	});

	it('should throw on invalid JSON', () => {
		expect(() => parseFontManifest('not json')).toThrow('not valid JSON');
	});

	it('should throw on non-object', () => {
		expect(() => parseFontManifest('"string"')).toThrow('must be a JSON object');
	});

	it('should throw on array', () => {
		expect(() => parseFontManifest('[]')).toThrow('must be a JSON object');
	});

	it('should throw on unsupported version', () => {
		expect(() => parseFontManifest(JSON.stringify({ version: 2, files: {} }))).toThrow(
			'Unsupported fonts.json version: 2',
		);
	});

	it('should throw on missing version', () => {
		expect(() => parseFontManifest(JSON.stringify({ files: {} }))).toThrow(
			'Unsupported fonts.json version',
		);
	});

	it('should throw on invalid files value', () => {
		expect(() => parseFontManifest(JSON.stringify({ version: 1, files: 'bad' }))).toThrow(
			'"files" must be a plain object',
		);
	});

	it('should throw on invalid hash (too short)', () => {
		expect(() =>
			parseFontManifest(JSON.stringify({ version: 1, files: { 'a.ttf': 'abc' } })),
		).toThrow('invalid hash');
	});

	it('should throw on invalid hash (uppercase)', () => {
		expect(() =>
			parseFontManifest(
				JSON.stringify({ version: 1, files: { 'a.ttf': '3F2A8C1D9E4B5A7F0C8D6E3A1B4F9C2D' } }),
			),
		).toThrow('invalid hash');
	});

	it('should throw on non-string hash', () => {
		expect(() =>
			parseFontManifest(JSON.stringify({ version: 1, files: { 'a.ttf': 123 } })),
		).toThrow('invalid hash');
	});
});

describe('collectUniqueHashes', () => {
	it('should return unique hashes', () => {
		const manifest = {
			version: 1 as const,
			files: {
				'a.ttf': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				'b.ttf': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				'c.ttf': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // duplicate of a.ttf
			},
		};
		const hashes = collectUniqueHashes(manifest);
		expect(hashes).toHaveLength(2);
		expect(new Set(hashes).size).toBe(2);
		expect(hashes).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		expect(hashes).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
	});

	it('should return empty array for empty manifest', () => {
		expect(collectUniqueHashes({ version: 1, files: {} })).toEqual([]);
	});
});

describe('FONT_MANIFEST_NAME', () => {
	it('should be fonts.json', () => {
		expect(FONT_MANIFEST_NAME).toBe('fonts.json');
	});
});
