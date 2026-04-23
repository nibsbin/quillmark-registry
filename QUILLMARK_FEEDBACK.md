# Feedback on `@quillmark/wasm@0.58.2-rc.5` (migration from 0.54.0)

Consumer: `@quillmark/registry`. All findings below are from an end-to-end
migration of the registry, including ~132 tests that exercise filesystem and
HTTP sources, bundle packaging, font dehydration, and live renders against
the wasm engine.

**Net result:** migration succeeded. Build is clean, full suite green, no
workarounds required. But the API change is aggressive enough that every
downstream package will need deliberate porting — this is not a drop-in
replacement.

## Summary of breaking changes we had to absorb

| 0.54.0 | 0.58.2-rc.5 |
|---|---|
| `engine.registerQuill(tree) → QuillInfo` | `engine.quill(tree) → Quill` (engine no longer tracks quills at all) |
| `engine.resolveQuill(ref) / listQuills()` | **Removed.** Caller owns the `name@version → Quill` map. |
| `engine.render(parsed, opts)` | `quill.render(doc, opts)` on the returned handle |
| Tree shape: nested `{ files: { 'Quill.yaml': { contents: '…' }, assets: { 'logo.png': { contents: [u8…] } } } }` | Flat `Map<string, Uint8Array>` — plain paths, raw bytes |
| `Quillmark.parseMarkdown(md) → ParsedDocument` | `Document.fromMarkdown(md) → Document` (new class, richer API) |
| `QuillInfo.example / supportedFormats / schema / defaults / examples` | **All gone from the engine surface.** |
| `QUILL` ref mismatch on render | Hard error → warning (`quill::ref_mismatch`). Nice. |

The new shape is cleaner. No more binary-vs-text contortions in the tree,
no more double bookkeeping of quills across the registry and engine.

## Blockers / friction encountered

### 1. `engine.quill()` requires `Map`, not `Record` — and the binding type hides that `Record` is allowed

The README says:

> in-memory trees (`Map<string, Uint8Array>` / `Record<string, Uint8Array>`)

But the generated `.d.ts` says:

```ts
/** The tree must be a `Map<string, Uint8Array>`. */
quill(tree: any): Quill;
```

And at runtime, passing a `Record` throws:

```
quill requires a Map<string, Uint8Array>
```

So the README is lying or the binding is stricter than advertised. Pick one.
We ended up writing a tiny `toEngineTree(files) = new Map(Object.entries(files))`
helper because every source we have produces `Record<string, Uint8Array>`
internally.

**Ask:** either loosen the binding to accept `Record` (the conversion is
cheap), or remove the `Record` claim from the README.

### 2. No way to read a quill's metadata (example, schema, supported formats) from a `Quill` handle

This was the biggest rewrite pain. In 0.54 we used `info.example`,
`info.supportedFormats[0]`, etc., to drive validation:

```ts
const info = engine.resolveQuill(name);
if (info?.example && info.supportedFormats?.length > 0) { … }
```

In 0.58 the `Quill` handle only exposes `backendId`, `render`, `projectForm`,
and `open`. There is no way to ask "what example does this quill ship with?"
or "what formats can it render?"

We worked around it by re-parsing `Quill.yaml` from the raw bytes (naive regex
for `example_file:`) and falling back to `example.md` by convention. That's
fine for the registry's narrow CI validator, but it reopens schema parsing
that the engine used to own.

**Ask:** add `quill.info` or `quill.metadata` (read-only projection of
Quill.yaml) on the `Quill` handle. Otherwise every consumer that used to call
`engine.resolveQuill()` for metadata has to hand-roll YAML parsing.

Related: we previously had `engine.getQuillSchema(name)` and `getQuillInfo(name)`
on the engine. Both gone with nothing replacing them. The docs note says:

> Output schema APIs are no longer engine-level in WASM.

…but doesn't point to where they moved. `projectForm(doc)` is documented on
`Quill` and returns `{ main: { schema, values }, cards, diagnostics }`, which
might cover part of the schema story, but that's a per-document projection,
not the static quill schema. Please clarify the migration path in the README.

### 3. `Document.fromMarkdown` now requires `QUILL:` in frontmatter

```
Missing required QUILL field. Add `QUILL: <name>` to the frontmatter.
```

This is fine for our use case but is a silent source of test-fixture rot —
any old mock markdown without `QUILL:` fails at parse time instead of render
time. Document this in the CHANGELOG / migration notes.

### 4. `engine.quill()` is strict about `Quill.yaml` structure in ways 0.54 wasn't

Both of these shapes are now rejected, when at least the first used to work:

- Flat top-level keys: `name: foo\nversion: 1.0.0\n…` →
  `Missing required 'Quill' section in Quill.yaml`.
- Nested `Quill:` block without `description:` →
  `Missing required 'description' field in 'Quill' section`.

`description` being *required* is surprising. Our test fixtures worked
before without it. Either this is a genuine schema tightening (document it)
or `description` shouldn't be mandatory.

### 5. Each `engine.quill(tree)` call returns a **new** `Quill` handle even for identical trees

```ts
const q1 = engine.quill(tree);
const q2 = engine.quill(tree);
console.log(q1 === q2); // false
```

This is fine — it's the caller's job to cache — but it is a footgun because
each handle owns memory (you must call `free()` on each). Consumers that used
to rely on the engine deduping `registerQuill` calls will now leak. The
registry handles this by caching by canonical `name@version`, but any naive
port is going to allocate a fresh handle per render.

**Ask:** either document this loudly in the migration notes, or add an
optional `name@version` cache inside the engine (opt-in via a second arg).

### 6. `init()` is still a footgun

Forgetting `init()` still produces cryptic panics deep inside the wasm module
with no "call init() first" hint. Unchanged from 0.54 but worth mentioning.

## Things that got better

- **Flat `Map<string, Uint8Array>`** is a huge simplification. We dropped a
  ~50-line `toEngineFileTree` helper that hand-rolled the binary/text split.
- **`Document`** is a real class with `frontmatter`, `cards`, `body`, and
  `warnings` exposed. Round-trip `toMarkdown()` is great.
- **QUILL mismatch as a warning** is a nicer developer experience than the
  old hard failure — we used to rewrite `QUILL:` lines on the fly in the CI
  validator. That hack is gone now.
- **Diagnostics attached to thrown errors** (`err.diagnostic = { severity,
  code, message }`) make error-code-sensitive handling possible without
  string matching. Good.

## Suggested migration checklist for the next downstream package

1. Replace every `engine.registerQuill(tree)` with `const q = engine.quill(tree)`
   and **cache the handle** by `name@version`. The engine has no memory.
2. Convert all tree-builders from `{ files: { … nested … } }` to
   `Map<string, Uint8Array>`. Drop any binary/text split logic.
3. Replace `Quillmark.parseMarkdown(md)` with `Document.fromMarkdown(md)`.
   Ensure all markdown has `QUILL:` in frontmatter.
4. Replace `engine.render(parsed, { quill })` with `quill.render(doc, opts)`.
   The quill is implicit in the handle; `opts.format` selects the output.
5. If you used `info.example / supportedFormats / schema`, plan to parse
   `Quill.yaml` yourself or lean on convention (`example.md`, default `pdf`).
6. Call `free()` on every `Quill` handle you create. The engine no longer
   owns their lifetime.
7. If you used `engine.resolveQuill(name) / listQuills()` for bookkeeping,
   own that map yourself.

## Registry-specific migration notes (for reviewers of this PR)

- `QuillData` was `unknown` (an opaque nested tree); now it's
  `Map<string, Uint8Array>` explicitly.
- `QuillBundle.quill?: QuillHandle` is populated by `registry.resolve()` and
  unset by `registry.fetch()`. Consumers render via `bundle.quill!.render(…)`.
- `registry.isLoaded()` now checks the registry's own handle cache, not
  `engine.resolveQuill()`.
- New `registry.getQuill(canonicalRef)` and `registry.listLoaded()` methods
  expose the handle cache.
- `validateQuills` now takes `parseDocument` (wrap `Document.fromMarkdown`)
  and an optional `format` (defaults to `"pdf"`). It reads `example_file`
  from `Quill.yaml` or falls back to `example.md`.
- `toEngineFileTree` → `toEngineTree` (flat `Map` conversion).
