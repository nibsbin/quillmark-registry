import type { QuillData } from './types.js';

/**
 * Converts a flat `Record<string, Uint8Array>` (as produced internally by
 * sources) into the `Map<string, Uint8Array>` shape required by
 * `@quillmark/wasm`'s `Quillmark.quill(tree)` binding.
 *
 * The binding rejects plain objects with `quill requires a Map<string, Uint8Array>`,
 * so this conversion is mandatory.
 */
export function toEngineTree(flatFiles: Record<string, Uint8Array>): QuillData {
	return new Map(Object.entries(flatFiles));
}
