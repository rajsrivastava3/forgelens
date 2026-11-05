import { decodeText } from '../changeset/encoding';
import type { EditorPort } from '../tools/editorPort';
import type { CodeSymbol } from '../tools/symbols';
import { chunkFile, outlineSymbols, type Chunk } from './chunker';
import { buildPack, type PackOptions, type PackResult } from './packer';
import { buildModuleMap, parsePythonImports, resolveImports } from './relations';
import { retrieve, type RetrieveOptions, type RetrievedItem } from './retrieve';
import { pathTokens, tokenize } from './tokenize';

export const INDEX_VERSION = 1;
export const MAX_INDEXED_BYTES = 1_000_000;
const MAX_INDEXED_FILES = 20_000;
const SLICE_MS = 8;
const SAVE_DELAY_MS = 2_000;

const SKIPPED_FILES =
  /(\.(png|jpe?g|gif|ico|webp|bmp|svg|pdf|zip|gz|tar|tgz|7z|whl|exe|dll|so|dylib|pyc|woff2?|ttf|eot|mp[34]|mov|sqlite|lock)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock))$/i;

export interface IndexedChunk extends Chunk {
  /** How often each word appears, with the name and path counted extra. */
  terms: Record<string, number>;
  length: number;
}

export interface IndexedFile {
  mtimeMs: number;
  size: number;
  chunks: IndexedChunk[];
  symbols: CodeSymbol[];
  imports: string[];
}

/** Where the index is kept between sessions. Never inside the workspace. */
export interface IndexStore {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

/** What indexing needs from an editor. readDiskBytes and statFile make it faster and exact when present. */
export type IndexPort = EditorPort & {
  readDiskBytes?(relativePath: string): Promise<Uint8Array | undefined>;
  statFile?(relativePath: string): Promise<FileStat | undefined>;
};

export interface IndexStats {
  files: number;
  chunks: number;
  symbols: number;
  reused: number;
  sizeBytes: number;
  ms: number;
}

export interface ContextEngineOptions {
  store?: IndexStore;
  log?: (message: string) => void;
  now?: () => number;
}

const yieldToEditor = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Reads a file for indexing, or undefined for one that should not be indexed. */
async function readIndexable(port: IndexPort, path: string): Promise<string | undefined> {
  try {
    if (port.readDiskBytes) {
      const bytes = await port.readDiskBytes(path);
      if (!bytes || bytes.length > MAX_INDEXED_BYTES) return undefined;
      return decodeText(bytes)?.text;
    }
    const text = await port.readTextFile(path);
    return text.length > MAX_INDEXED_BYTES || text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

export function indexFile(path: string, text: string, stat: FileStat): IndexedFile {
  const lines = text.split(/\r?\n/);
  const pathWords = pathTokens(path);
  const chunks = chunkFile(path, text).map((chunk): IndexedChunk => {
    const terms: Record<string, number> = {};
    const body = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
    let length = 0;
    const count = (word: string, weight = 1): void => {
      terms[word] = (terms[word] ?? 0) + weight;
      length += weight;
    };
    for (const word of tokenize(body)) count(word);
    // A word in a name or path says more about the chunk than the same word in its body.
    if (chunk.name) for (const word of tokenize(chunk.name)) count(word, 3);
    for (const word of pathWords) count(word, 2);
    return { ...chunk, terms, length };
  });
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    chunks,
    symbols: outlineSymbols(path, text),
    imports: path.endsWith('.py') ? parsePythonImports(text) : [],
  };
}

/** The built index, plus the structures search needs. Rebuilt in slices so the editor stays responsive. */
export class ContextIndex {
  readonly files = new Map<string, IndexedFile>();
  /** word -> (file, chunk index, count) */
  postings = new Map<string, { path: string; chunk: number; count: number }[]>();
  /** Words per file, for "does this doc mention that module". */
  fileTerms = new Map<string, Map<string, number>>();
  imports = new Map<string, string[]>();
  importedBy = new Map<string, string[]>();
  averageLength = 1;
  totalChunks = 0;

  get paths(): string[] {
    return [...this.files.keys()];
  }

  async rebuildSearch(): Promise<void> {
    const postings: ContextIndex['postings'] = new Map();
    const fileTerms: ContextIndex['fileTerms'] = new Map();
    let totalLength = 0;
    let totalChunks = 0;
    let sliceStart = performance.now();
    for (const [path, file] of this.files) {
      const words = new Map<string, number>();
      file.chunks.forEach((chunk, chunkIndex) => {
        totalLength += chunk.length;
        totalChunks += 1;
        for (const [word, count] of Object.entries(chunk.terms)) {
          let list = postings.get(word);
          if (!list) {
            list = [];
            postings.set(word, list);
          }
          list.push({ path, chunk: chunkIndex, count });
          words.set(word, (words.get(word) ?? 0) + count);
        }
      });
      fileTerms.set(path, words);
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToEditor();
        sliceStart = performance.now();
      }
    }
    const modules = buildModuleMap(this.paths);
    const imports = new Map<string, string[]>();
    const importedBy = new Map<string, string[]>();
    for (const [path, file] of this.files) {
      const targets = resolveImports(path, file.imports, modules);
      imports.set(path, targets);
      for (const target of targets) importedBy.set(target, [...(importedBy.get(target) ?? []), path]);
    }
    this.postings = postings;
    this.fileTerms = fileTerms;
    this.imports = imports;
    this.importedBy = importedBy;
    this.totalChunks = totalChunks;
    this.averageLength = totalChunks > 0 ? totalLength / totalChunks : 1;
  }

  /** BM25 over chunks. Identifier splitting and stemming already happened when the words were counted. */
  scoreChunks(terms: readonly string[]): Map<string, { chunk: number; score: number; matched: Set<string> }[]> {
    const k1 = 1.5;
    const b = 0.75;
    const scores = new Map<string, Map<number, { score: number; matched: Set<string> }>>();
    for (const term of new Set(terms)) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (this.totalChunks - list.length + 0.5) / (list.length + 0.5));
      for (const { path, chunk, count } of list) {
        const length = this.files.get(path)?.chunks[chunk]?.length ?? this.averageLength;
        const score = idf * ((count * (k1 + 1)) / (count + k1 * (1 - b + (b * length) / this.averageLength)));
        let perFile = scores.get(path);
        if (!perFile) {
          perFile = new Map();
          scores.set(path, perFile);
        }
        const entry = perFile.get(chunk) ?? { score: 0, matched: new Set<string>() };
        entry.score += score;
        entry.matched.add(term);
        perFile.set(chunk, entry);
      }
    }
    const result = new Map<string, { chunk: number; score: number; matched: Set<string> }[]>();
    for (const [path, perFile] of scores) {
      result.set(
        path,
        [...perFile].map(([chunk, entry]) => ({ chunk, ...entry })).sort((x, y) => y.score - x.score),
      );
    }
    return result;
  }
}

/** Owns the index for one workspace: builds it, keeps it current on save, and answers queries from it. */
export class ContextEngine {
  readonly index = new ContextIndex();
  private building: Promise<IndexStats> | undefined;
  private built = false;
  private searchStale = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly port: IndexPort,
    private readonly options: ContextEngineOptions = {},
  ) {}

  /** Builds on first use. Later calls wait for that build and do nothing else. */
  ensureBuilt(): Promise<IndexStats> {
    this.building ??= this.build().catch((error: unknown) => {
      this.building = undefined;
      throw error;
    });
    return this.building;
  }

  /** A file was saved, created or deleted. Cheap: search structures catch up at the next query. */
  async noteFileChanged(path: string): Promise<void> {
    if (!this.built) return;
    const before = this.index.files.has(path);
    const stat = SKIPPED_FILES.test(path) ? undefined : await this.port.statFile?.(path);
    const tooLarge = stat !== undefined && stat.size > MAX_INDEXED_BYTES;
    const text = SKIPPED_FILES.test(path) || tooLarge ? undefined : await readIndexable(this.port, path);
    if (text === undefined) {
      if (!before) return;
      this.index.files.delete(path);
    } else {
      this.index.files.set(path, indexFile(path, text, stat ?? { mtimeMs: 0, size: text.length }));
    }
    this.searchStale = true;
    this.scheduleSave();
  }

  /** Compares the index with the workspace's file list, after files were created or deleted outside a save. */
  async syncFileList(): Promise<void> {
    if (!this.built) return;
    const listed = new Set((await this.port.listFiles()).filter((path) => !SKIPPED_FILES.test(path)));
    for (const path of this.index.paths) if (!listed.has(path)) await this.noteFileChanged(path);
    for (const path of listed) if (!this.index.files.has(path)) await this.noteFileChanged(path);
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievedItem[]> {
    await this.ready();
    return retrieve(this.index, query, options);
  }

  async pack(query: string, options: RetrieveOptions & PackOptions = {}): Promise<PackResult> {
    const items = await this.retrieve(query, options);
    return buildPack(this.index, items, (path) => this.port.readTextFile(path), options);
  }

  /** Top-level definitions per file, for the repo map. */
  async outlines(): Promise<Map<string, CodeSymbol[]>> {
    await this.ready();
    return new Map([...this.index.files].map(([path, file]) => [path, file.symbols]));
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
  }

  /** Writes any pending change now rather than after the delay. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.options.store?.write(this.serialize());
  }

  private async ready(): Promise<void> {
    await this.ensureBuilt();
    if (this.searchStale) {
      this.searchStale = false;
      await this.index.rebuildSearch();
    }
  }

  private serialize(): string {
    return JSON.stringify({ version: INDEX_VERSION, files: [...this.index.files] });
  }

  private async loadStored(): Promise<Map<string, IndexedFile>> {
    try {
      const raw = await this.options.store?.read();
      if (!raw) return new Map();
      const parsed = JSON.parse(raw) as { version: number; files: [string, IndexedFile][] };
      return parsed.version === INDEX_VERSION ? new Map(parsed.files) : new Map();
    } catch {
      return new Map(); // A damaged index only costs a rebuild.
    }
  }

  private async build(): Promise<IndexStats> {
    const clock = this.options.now ?? (() => performance.now());
    const started = clock();
    const stored = await this.loadStored();
    const listed = (await this.port.listFiles()).filter((path) => !SKIPPED_FILES.test(path)).slice(0, MAX_INDEXED_FILES);
    let reused = 0;
    let sliceStart = performance.now();
    for (const path of listed) {
      const stat = await this.port.statFile?.(path);
      if (stat && stat.size > MAX_INDEXED_BYTES) continue;
      const previous = stored.get(path);
      if (stat && previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        this.index.files.set(path, previous);
        reused += 1;
      } else {
        const text = await readIndexable(this.port, path);
        if (text !== undefined) this.index.files.set(path, indexFile(path, text, stat ?? { mtimeMs: 0, size: text.length }));
      }
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToEditor();
        sliceStart = performance.now();
      }
    }
    await this.index.rebuildSearch();
    this.built = true;

    const serialized = this.serialize();
    if (reused !== this.index.files.size || stored.size !== this.index.files.size) await this.options.store?.write(serialized);
    const stats: IndexStats = {
      files: this.index.files.size,
      chunks: this.index.totalChunks,
      symbols: [...this.index.files.values()].reduce((sum, file) => sum + file.symbols.length, 0),
      reused,
      sizeBytes: serialized.length,
      ms: Math.round(clock() - started),
    };
    this.options.log?.(
      `Indexed ${stats.files} files, ${stats.chunks} chunks, ${stats.symbols} symbols in ${stats.ms} ms (${Math.round(stats.sizeBytes / 1024)} KB, ${stats.reused} files reused).`,
    );
    return stats;
  }

  private scheduleSave(): void {
    if (!this.options.store) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush().catch(() => undefined), SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }
}
