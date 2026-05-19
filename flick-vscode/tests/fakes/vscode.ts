// Minimal fake of the `vscode` API surface the Flick extension host touches.
// esbuild.test.js aliases the bare `vscode` import to this module, so the
// controller / store / settings code runs unchanged under `node --test`.
//
// Only the members actually used by the code under test are implemented.

// --- configuration ---------------------------------------------------------

const configStore = new Map<string, unknown>();

/** Test helper: seed a `flick.<key>` configuration value. */
export function __setConfig(key: string, value: unknown): void {
  configStore.set(key, value);
}

let workspaceFoldersInternal: Array<{ uri: { fsPath: string } }> | undefined;

/** Test helper: stand in for an open workspace folder so code paths like
 *  `vscode.workspace.workspaceFolders?.[0]` resolve to something. Pass
 *  `undefined` (the default after __reset) to model single-file mode. */
export function __setWorkspaceFolder(fsPath: string | undefined): void {
  workspaceFoldersInternal = fsPath ? [{ uri: { fsPath } }] : undefined;
}

/** Test helper: reset all fake state between tests. */
export function __reset(): void {
  configStore.clear();
  __warningResponse = 'Delete';
  executedCommands.length = 0;
  workspaceFoldersInternal = undefined;
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const workspace = {
  getConfiguration(section: string) {
    const prefix = `${section}.`;
    return {
      get<T>(key: string): T | undefined {
        return configStore.get(prefix + key) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        configStore.set(prefix + key, value);
      },
    };
  },
  onDidChangeConfiguration(): { dispose(): void } {
    return { dispose() {} };
  },
  get workspaceFolders(): Array<{ uri: { fsPath: string } }> | undefined {
    return workspaceFoldersInternal;
  },
};

// --- window ----------------------------------------------------------------

let __warningResponse: string | undefined = 'Delete';

/** Test helper: control what the next showWarningMessage modal "returns". */
export function __setWarningResponse(value: string | undefined): void {
  __warningResponse = value;
}

export const window = {
  async showWarningMessage(): Promise<string | undefined> {
    return __warningResponse;
  },
};

// --- commands --------------------------------------------------------------

const executedCommands: string[] = [];

/** Test helper: inspect commands the code asked VS Code to run. */
export function __executedCommands(): readonly string[] {
  return executedCommands;
}

export const commands = {
  async executeCommand(command: string): Promise<void> {
    executedCommands.push(command);
  },
};

// --- Uri -------------------------------------------------------------------

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly fsPath: string,
  ) {}

  static file(p: string): Uri {
    return new Uri('file', p.replace(/\\/g, '/'), p);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    const joined = [base.path, ...parts].join('/');
    return new Uri(base.scheme, joined, joined);
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

// `vscode.Disposable` is referenced only as a type in the code under test, but
// export a runtime shape too in case it is constructed.
export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}
