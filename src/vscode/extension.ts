import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ForgeLens');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('forgelens.hello', () => {
      output.appendLine('ForgeLens is active. The agent panel arrives in P1.');
      output.show();
    }),
  );
}

export function deactivate(): void {}
