/** Everything the tools need from an editor. Implemented by VS Code in the extension and by Node headlessly. */
export interface EditorPort {
  /** Absolute workspace root. Tool paths are relative to this. */
  readonly workspaceRoot: string;
  /** Reads a file as UTF-8 text. Rejects if it does not exist. */
  readTextFile(relativePath: string): Promise<string>;
}
