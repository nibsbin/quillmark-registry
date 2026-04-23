/**
 * Flat in-memory file tree: path → bytes.
 * Accepted by `@quillmark/wasm`'s `Quillmark.quill(tree)` (requires a `Map`,
 * not a plain object, per the wasm binding contract).
 */
export type QuillData = Map<string, Uint8Array>;

/** Metadata about a quill, extracted from Quill.yaml or manifest. */
export interface QuillMetadata {
	name: string;
	version: string;
	description?: string;
	/**
	 * Packaged bundle filename under the HTTP base URL (e.g. `name@1.0.0.a1b2c3.zip`).
	 * Set by `FileSystemSource.packageForHttp()`; required for `HttpSource.loadQuill()`.
	 */
	bundleFileName?: string;
}

/** Manifest listing all available quills from a source. */
export interface QuillManifest {
	quills: QuillMetadata[];
}

/** A resolved quill bundle ready for engine registration. */
export interface QuillBundle {
	name: string;
	version: string;
	/** Flat file tree (`Map<string, Uint8Array>`) passed verbatim to `Quillmark.quill()`. */
	data: QuillData;
	metadata: QuillMetadata;
	/**
	 * The engine-attached Quill handle. Populated by {@link QuillRegistry.resolve}
	 * once the bundle has been passed through `engine.quill()`.
	 *
	 * Unset on bundles returned from {@link QuillRegistry.fetch} (which skips engine
	 * attachment) and from {@link QuillSource.loadQuill} (which knows nothing about
	 * any engine).
	 */
	quill?: QuillHandle;
}

/** Pluggable backend that knows how to list and fetch Quills from a specific location. */
export interface QuillSource {
	getManifest(): Promise<QuillManifest>;
	loadQuill(name: string, version: string): Promise<QuillBundle>;
}

/**
 * Minimal structural type for the Quill handle returned by
 * `Quillmark.quill(tree)` in `@quillmark/wasm`.
 *
 * The registry only reads `backendId` and invokes `render()`; callers with
 * the full `@quillmark/wasm` types can cast to `Quill` for advanced usage
 * (`open`, `projectForm`, etc.).
 */
export interface QuillHandle {
	readonly backendId: string;
	render(doc: unknown, opts?: unknown): {
		artifacts: Array<{ bytes: Uint8Array; format: string; mimeType: string }>;
		warnings: unknown[];
		outputFormat: string;
		renderTimeMs: number;
	};
	free?(): void;
}

/**
 * Minimal structural type for the `@quillmark/wasm` engine instance.
 * The registry only calls `quill(tree)` — it never imports or instantiates the engine.
 *
 * Structurally compatible with `@quillmark/wasm`'s `Quillmark` class so a
 * `new Quillmark()` instance can be passed directly without adapters.
 */
export interface QuillmarkEngine {
	quill(tree: QuillData): QuillHandle;
}
