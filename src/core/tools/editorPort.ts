export interface DiagnosticInfo {
  path: string;
  /** 1-based. */
  line: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string | undefined;
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
}
