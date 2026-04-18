# Proposal: Quivers — `@quillmark/quiver`

**Status:** Design decided. Ready for implementation planning.
**Audience:** Senior SWE tasked with planning the implementation.
**Scope:** Full rewrite of `@quillmark/registry` as `@quillmark/quiver`.

## Summary

A **Quiver** is a named, versioned collection of Quills with a formal manifest
(`Quiver.yaml`). It replaces the current `QuillSource` abstraction as the
primary unit of distribution, composition, and runtime loading. Consumers
compose one or more Quivers into a `QuillRegistry`; the registry resolves
quills across them with a deterministic precedence policy. Quivers are
distributed primarily through npm, with first-class support for git
subtree / folder copy as a fallback.

This is a conceptual realignment, not just a rename: `QuillSource` is today
an implementation-detail interface (`FileSystemSource`, `HttpSource`). We
promote the concept to a user-facing, branded primitive. The package, the
runtime, and the distribution story all reorganize around it.

## Motivation

Two concrete use cases drive this:

1. **Customer-specific bundles.** A downstream MCP server or web app is
   deployed per-customer (industry verticals, individual firms, etc.), each
   with its own document set. A Quiver per customer is the natural unit.
   Multi-tenant deployments must be able to load several Quivers into a
   single registry and resolve quills across them.
2. **Developer publishing loop.** Quiver authors want to version, test
   (already supported), package, and release updates to consumers without
   bespoke tooling. npm already solves this well; we adopt it rather than
   reinvent it.

Today neither workflow is first-class. `QuillSource` is an internal seam;
there is no manifest format, no composition story, and no canonical way to
publish a bundle of quills.

## Core decisions

### 1. Quiver replaces QuillSource as the primary abstraction

- Rename `QuillSource` → `Quiver` throughout the codebase and public API.
- `Quiver` remains pluggable (filesystem, HTTP, npm-installed, etc.) — the
  shape of the interface is similar to today's `QuillSource`, but it now
  carries identity (`name`, `version`) and is the thing users think about.
- Runtime stays transparent for apps that use a single Quiver: `resolve('usaf_memo')`
  still works. The Quiver concept surfaces only at composition and publish
  time.

### 2. `Quiver.yaml` is required

Every Quiver ships a `Quiver.yaml` at its root. It is the single source of
truth for Quiver identity and is required for any Quiver to load, publish,
or compose. No inferred / implicit Quivers.

**Minimum fields** (planner to finalize exact schema):

- `name` — string, required. Also serves as the namespace (see §3).
- `version` — semver, required.
- `description` — string, optional.
- Convention: quills live under `./quills/<name>/<version>/Quill.yaml`
  (matching today's `FileSystemSource` layout).

Capitalization and extension mirror `Quill.yaml` exactly — the two files
are a symmetric pair.

**Out of scope for the initial schema:** explicit `namespace:`,
`priority:` / `layer:`, inter-quiver `dependencies:`, per-quill aliases.
All punted (see §8).

A `quiver init` CLI that scaffolds a default `Quiver.yaml` should be part
of the initial release to keep the zero-config path ergonomic.

### 3. Quiver `name` is the namespace

Fully-qualified quill references take the form `<quiver-name>/<quill-name>`,
e.g., `acme-legal/usaf_memo`. Rules:

- Within a single Quiver, `name` acts as the namespace prefix; no separate
  `namespace:` field.
- Unqualified `resolve('usaf_memo')` continues to work and resolves via the
  precedence policy (§4). Qualification is only needed to disambiguate.
- Renaming a Quiver is a breaking change — treat `name` like an npm package
  name. Bump semver-major.
- npm package name and `Quiver.yaml` `name` are **decoupled**. An npm
  package `@acme/legal-quiver` may declare `name: acme-legal` in its
  `Quiver.yaml`. This keeps distribution channel independent of runtime
  identity (important because git subtree / folder copy must also work).

### 4. Composition and precedence

`QuillRegistry` accepts multiple Quivers. Today's `{ source }` option
becomes plural (`{ quivers: [...] }`, exact naming TBD by planner).

**Precedence policy:**

- **Consumer owns layering order.** Order in the `quivers` array defines
  precedence; higher-layer (earlier or later — planner picks one and
  documents it) wins collisions. Do **not** let Quivers self-declare
  priority; a published Quiver cannot know its position in another app's
  stack.
- **Alphabetical by Quiver `name` as tie-breaker** at the same layer
  (only relevant if we later introduce grouping; for a flat array the
  order itself is sufficient).
- **Collisions emit a warning** when an unqualified `resolve()` matches
  across Quivers. Qualified resolves (`acme-legal/usaf_memo`) are
  unambiguous and silent.

The `resolve()` flow for multi-Quiver registries:

1. If ref is qualified (`quiver/quill[@version]`) → dispatch to that
   specific Quiver.
2. If unqualified → iterate Quivers in precedence order; return first
   match; warn if later Quivers also match.
3. Engine-cache fast path (`engine.resolveQuill`) still applies on top.

### 5. Distribution: npm first-class, git / folder copy supported

**Developer → consumer distribution = npm.** A Quiver is published as an
npm package whose `files` include `Quiver.yaml` and `quills/`. Consumers
`npm install @acme/legal-quiver`, and a built-in `Quiver` implementation
loads from `node_modules/<pkg>`.

- Semver, lockfiles, scoped names, audit, mirrors — all free.
- Scoped npm name (`@acme/legal-quiver`) is the developer-facing handle;
  `Quiver.yaml`'s `name` is the runtime handle. Decoupled intentionally.

**Git subtree / folder copy must also work.** Not every consumer runs
npm (CI pipelines, vendored deployments, air-gapped environments). Any
`Quiver.yaml`-bearing directory on disk must load via the
filesystem-backed Quiver with no additional ceremony.

**End-user (browser) delivery stays HTTP-zip.** The existing hashed-zip
pipeline (`packageForHttp`, `HttpSource`, font dehydration, manifest
pointer) remains — it is the runtime delivery format for the browser.
Conceptually:

- **npm / git** = developer distribution format (source tree).
- **HTTP-zip** = end-user delivery format (compiled, hashed, CDN-cached).

The packaging step that turns the former into the latter remains in the
package (renamed appropriately). Two formats, one pipeline.

### 6. Runtime shape

- **Class names:** keep `QuillRegistry` (still accurate — one per app,
  holds loaded quills). The package is plural-flavored; the class is
  singular.
- `QuillRegistry` accepts `{ quivers: Quiver[], engine }` at construction
  (exact option name TBD). Today's single-source form may be preserved as
  a convenience (`{ quiver: Quiver }`) or dropped — planner's call.
- `engine.resolveQuill()` fast-path, in-memory bundle cache, lazy loading,
  and `preload()` semantics all carry over unchanged.
- Error model (`RegistryError` with typed codes) carries over; add a code
  for quiver-level failures (e.g., `quiver_not_found`, `quiver_invalid`)
  as needed.

### 7. Package rename: `@quillmark/registry` → `@quillmark/quiver`

- Publish as `@quillmark/quiver` (singular, matches npm idiom).
- Verify the name is available on npm before committing.
- Export surface reorganizes around the Quiver primitive. Current
  browser / Node entry split (`@quillmark/registry` vs
  `@quillmark/registry/node`) stays — the Node entry owns filesystem
  Quivers and `packageForHttp`.
- No backwards-compatibility shims. This is pre-1.0 and marked
  "Under Development"; a clean break is cheaper than dragging legacy
  names forward. Downstream migration is a one-time import rewrite.

## What moves

| Today                                        | After                                                    |
| -------------------------------------------- | -------------------------------------------------------- |
| `@quillmark/registry` package                | `@quillmark/quiver`                                      |
| `QuillSource` interface                      | `Quiver` interface (carries `name`, `version`)           |
| `FileSystemSource`                           | Filesystem-backed Quiver (reads `Quiver.yaml` at root)   |
| `HttpSource`                                 | HTTP-backed Quiver (end-user delivery format)            |
| `{ source }` option on `QuillRegistry`       | `{ quivers: [...] }` (plural)                            |
| `manifest.json` (flat quill list)            | Per-Quiver manifests + `Quiver.yaml`                     |
| `scripts/package-quills.js`-style packaging  | `packageForHttp()` on filesystem Quiver (unchanged role) |
| Implicit "whatever quills are in the folder" | Requires `Quiver.yaml` at root                           |

## What stays

- `@quillmark/wasm` peer dependency model and `QuillmarkEngine` interface.
- Engine-side APIs (`registerQuill`, `resolveQuill`, `listQuills`) —
  unchanged.
- `Quill.yaml` format for individual quills.
- Font dehydration / content-addressed store (orthogonal; applies at
  HTTP-zip packaging time).
- Lazy loading, in-memory bundle cache, dedupe-by-canonical-ref semantics.
- Validation entry points (`validateQuills`, `validateQuillsFromDir`) —
  adapt to take a Quiver rather than a source.

## Out of scope (explicit punts)

- **Inter-quiver dependencies.** If a Quiver really needs quills from
  another Quiver, npm's dependency graph handles it at install time. We
  do not model Quiver→Quiver deps in `Quiver.yaml`.
- **Marketplace / registry service.** Git repos, subtrees, and npm are
  sufficient distribution channels. No hosted index, search, or
  discovery service.
- **Quiver-level lockfile.** npm's lockfile covers it for the npm path.
  Git / folder-copy consumers accept reproducibility-by-commit-SHA.
- **Per-quill aliases** in `Quiver.yaml`. Escape hatch for later if
  needed; not in v1.
- **Quiver-declared priority.** Precedence is always a consumer-side
  concern.
- **Runtime schema evolution for `Quiver.yaml`.** Pick a v1 schema;
  worry about versioning the schema itself later.

## Open questions for the planner

These are decisions the implementation plan should resolve, not things
still up for debate at the product level:

1. **Exact `Quiver.yaml` schema** — finalize field list, types, required
   vs. optional, validation rules. Reserve unknown-field policy
   (tolerate vs. reject) explicitly.
2. **Exact `Quiver` interface shape** — which methods move to the
   instance vs. stay registry-level (e.g., `getManifest` — per-Quiver
   or still aggregate?).
3. **Precedence direction** — earlier-wins vs. later-wins in the
   `quivers` array. Pick one; document with an example; match common
   idiom (middleware stacks differ; PATH-like precedence vs.
   CSS-like cascade).
4. **Single-Quiver convenience API** — preserve `{ quiver: ... }` as
   shorthand for `{ quivers: [...] }`, or require the array everywhere?
5. **`quiver init` scope** — just scaffold `Quiver.yaml`, or also
   `package.json` + `.gitignore` + a sample quill?
6. **Migration path** — existing consumers of `@quillmark/registry`
   have a `{ source }` construction and flat manifests. Is there a
   codemod or just a docs-driven migration?
7. **Engine compatibility field** — does `Quiver.yaml` declare a
   minimum `@quillmark/wasm` version? Useful for friendlier errors;
   adds schema surface. Recommend yes, optional.
8. **Validation semantics for a composed registry** — does
   `validateQuills` run per-Quiver, across the composite, or both?
   Collision detection belongs here.
9. **HTTP delivery of multi-Quiver deployments** — does each Quiver
   get its own hashed manifest + zip set, or do we produce a single
   combined manifest at packaging time? Affects CDN layout and cache
   invalidation granularity.
10. **npm-backed Quiver loader** — is this a distinct `Quiver`
    implementation, or does the filesystem Quiver simply get pointed
    at `node_modules/<pkg>` by the consumer? Recommend the latter for
    simplicity; confirm during planning.

## Success criteria

- A developer can run `quiver init`, add quills under `quills/`, run
  tests, and `npm publish` a working Quiver with no bespoke tooling.
- A consumer can `npm install` one or more Quivers, construct a
  `QuillRegistry` with them, and resolve quills with deterministic
  precedence.
- Git subtree / folder copy works identically to npm install at the
  runtime level — the loader does not care how the Quiver got on disk.
- Browser HTTP-zip delivery continues to work with equivalent or better
  ergonomics than today (font dehydration, hashed manifests, etc.).
- No implicit Quivers: a directory without `Quiver.yaml` fails to load
  with a clear error.
