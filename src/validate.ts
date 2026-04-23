import { QuillRegistry } from './registry.js';
import type { QuillmarkEngine, QuillSource } from './types.js';
import { formatUnknownError } from './errors.js';

/**
 * Options for {@link validateQuills}.
 *
 * Use any {@link QuillSource} (e.g. {@link HttpSource} in the browser). For
 * filesystem-backed validation on Node, use {@link validateQuillsFromDir} from
 * `@quillmark/registry/node`.
 *
 * ```ts
 * import { validateQuills, HttpSource } from '@quillmark/registry';
 * import { Document, Quillmark, init } from '@quillmark/wasm';
 *
 * init();
 * const engine = new Quillmark();
 * const source = new HttpSource({ baseUrl: 'https://example.com/quills' });
 * try {
 *   const { passed, failed } = await validateQuills({
 *     source,
 *     engine,
 *     parseDocument: Document.fromMarkdown,
 *   });
 * } finally {
 *   engine.free();
 * }
 * ```
 */
export interface ValidateQuillsOptions {
	/** Quill listing and loading backend (HTTP, in-memory test double, etc.). */
	source: QuillSource;

	/**
	 * Initialised WASM engine instance (e.g. `new Quillmark()` from `@quillmark/wasm`).
	 * Must support `quill(tree)`.
	 */
	engine: QuillmarkEngine;

	/**
	 * Markdown-to-Document parser (inject `Document.fromMarkdown` from `@quillmark/wasm`).
	 *
	 * The registry avoids a direct `@quillmark/wasm` import so it can be consumed
	 * in environments where the wasm module is loaded differently; callers wire
	 * it in explicitly.
	 */
	parseDocument: (markdown: string) => unknown;

	/**
	 * Output format used to render each quill's example document.
	 * Defaults to `"pdf"`.
	 */
	format?: string;
}

/** Validation result for a single quill version. */
export interface QuillValidationEntry {
	name: string;
	version: string;
	/** Whether `engine.quill()` succeeded (validates quill structure). */
	registered: boolean;
	/** Whether the quill's example document rendered to non-empty artifacts. */
	rendered: boolean;
	/** Error message if any validation step failed. */
	error?: string;
}

/** Aggregate result returned by {@link validateQuills}. */
export interface ValidateQuillsResult {
	results: QuillValidationEntry[];
	/** Number of quills that passed all validation steps. */
	passed: number;
	/** Number of quills that failed at least one validation step. */
	failed: number;
}

const EXAMPLE_FILE_RE = /^\s*example_file:\s*['"]?([^'"\s#]+)['"]?/m;
const DEFAULT_EXAMPLE_FILE = 'example.md';

/** Naively reads the `example_file` key out of Quill.yaml bytes, if present. */
function readExampleFileName(yamlBytes: Uint8Array | undefined): string | null {
	if (!yamlBytes) return null;
	const text = new TextDecoder('utf-8', { fatal: false }).decode(yamlBytes);
	const match = text.match(EXAMPLE_FILE_RE);
	return match?.[1] ?? null;
}

/**
 * Validates every quill from a {@link QuillSource} by registering it with the WASM engine
 * and rendering its example document when present.
 *
 * Designed for CI gates and local checks. Each quill goes through two validation stages:
 *
 * 1. **Registration** — `engine.quill(tree)` validates the quill's file structure,
 *    `Quill.yaml` schema, and backend package layout.
 * 2. **Render** — if the quill's `Quill.yaml` declares `example_file` (or ships an
 *    `example.md`), the file is parsed via `parseDocument` and rendered to the
 *    requested `format` (default `"pdf"`), confirming end-to-end compilation.
 *
 * @returns Per-quill results and aggregate pass/fail counts.
 */
export async function validateQuills(
	options: ValidateQuillsOptions,
): Promise<ValidateQuillsResult> {
	const { source, engine, parseDocument, format = 'pdf' } = options;
	const registry = new QuillRegistry({ source, engine });
	const manifest = await source.getManifest();
	const results: QuillValidationEntry[] = [];

	for (const quill of manifest.quills) {
		const entry: QuillValidationEntry = {
			name: quill.name,
			version: quill.version,
			registered: false,
			rendered: false,
		};

		try {
			const ref = `${quill.name}@${quill.version}`;
			const bundle = await registry.resolve(ref);
			entry.registered = true;

			const exampleFileName =
				readExampleFileName(bundle.data.get('Quill.yaml')) ?? DEFAULT_EXAMPLE_FILE;
			const exampleBytes = bundle.data.get(exampleFileName);
			if (!exampleBytes) {
				// No example declared — registration alone is a pass.
				entry.rendered = true;
			} else {
				const exampleMd = new TextDecoder().decode(exampleBytes);
				const doc = parseDocument(exampleMd);
				const result = bundle.quill!.render(doc, { format });

				const firstArtifact = result.artifacts[0];
				if (!firstArtifact || firstArtifact.bytes.length === 0) {
					entry.error = 'Render produced no output artifacts';
				} else {
					entry.rendered = true;
				}
			}
		} catch (err) {
			entry.error = formatUnknownError(err);
		}

		results.push(entry);
	}

	const failed = results.filter((r) => r.error !== undefined).length;
	const passed = results.length - failed;

	return { results, passed, failed };
}
