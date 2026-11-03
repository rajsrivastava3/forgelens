export interface DiagnosticInfo {
  path: string;
  /** 1-based. */
  line: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string | undefined;
}

/** One file's new bytes, or `undefined` to delete it. */
export interface FileWrite {
  path: string;
  bytes: Uint8Array | undefined;
}

/** Everything the tools need from an editor. Implemented by VS Code in the extension and by Node headlessly. */
export interface EditorPort {
  /** Absolute workspace root. Tool paths are relative to this. */
  readonly workspaceRoot: string;
  /** Reads a file as UTF-8 text. Rejects if it does not exist. */
  readTextFile(relativePath: string): Promise<string>;
  /** Workspace files as forward-slash relative paths, honouring ignore rules. */
  listFiles(): Promise<string[]>;
  /** Editor diagnostics, for one file or the whole workspace. */
  getDiagnostics(relativePath?: string): Promise<DiagnosticInfo[]>;
  /** True when this content has staged edits that are not on disk. */
  isStaged?(relativePath: string): boolean;
}

/** What the changeset needs in addition: exact bytes on disk, and an all-or-nothing write. */
export interface WritablePort extends EditorPort {
  /** Exact bytes on disk, or undefined when the file does not exist. */
  readDiskBytes(relativePath: string): Promise<Uint8Array | undefined>;
  /** True when the user has edits in an open editor that are not saved yet. */
  hasUnsavedChanges(relativePath: string): boolean;
  /** Writes every file or none. Rejects after restoring anything it had already changed. */
  writeFiles(writes: readonly FileWrite[]): Promise<void>;
}
