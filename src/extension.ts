import * as vscode from 'vscode';
import { SmartGitViewProvider } from './webview/provider';
import { GitContentProvider } from './vscode/diffProvider';
import { GitBlameController } from './vscode/blameController';
import { observeBuiltInGit } from './vscode/repositoryDiscovery';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('VC Smart Git', { log: true });
  const contentProvider = new GitContentProvider();
  const provider = new SmartGitViewProvider(context, contentProvider, output);
  const blameController = new GitBlameController(output);

  context.subscriptions.push(
    output,
    contentProvider,
    provider,
    blameController,
    vscode.workspace.registerTextDocumentContentProvider('vc-smart-git', contentProvider),
    vscode.window.registerWebviewViewProvider('vcSmartGit.toolWindow', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('vcSmartGit.open', async () => {
      await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
      await vscode.commands.executeCommand('workbench.view.extension.vcSmartGit');
      await vscode.commands.executeCommand('vcSmartGit.toolWindow.focus');
    }),
    vscode.commands.registerCommand('vcSmartGit.refresh', () => provider.runAction('refresh')),
    vscode.commands.registerCommand('vcSmartGit.fetch', () => provider.runAction('fetch')),
    vscode.commands.registerCommand('vcSmartGit.pull', () => provider.runAction('pull')),
    vscode.commands.registerCommand('vcSmartGit.push', () => provider.runAction('push')),
    vscode.commands.registerCommand('vcSmartGit.stageAll', () => provider.runAction('stageAll')),
    vscode.commands.registerCommand('vcSmartGit.unstageAll', () => provider.runAction('unstageAll')),
    vscode.commands.registerCommand('vcSmartGit.continueOperation', () => provider.runAction('continueOperation')),
    vscode.commands.registerCommand('vcSmartGit.abortOperation', () => provider.runAction('abortOperation')),
    vscode.commands.registerCommand('vcSmartGit.annotateBlame', () => blameController.annotateActive()),
    vscode.commands.registerCommand('vcSmartGit.hideBlame', () => blameController.hideActive()),
    vscode.workspace.onDidSaveTextDocument(() => provider.scheduleRefresh()),
    vscode.workspace.onDidCreateFiles(() => provider.scheduleRefresh()),
    vscode.workspace.onDidDeleteFiles(() => provider.scheduleRefresh()),
    vscode.workspace.onDidRenameFiles(() => provider.scheduleRefresh()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        provider.scheduleRefresh(50);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.scheduleRefresh(50)),
    vscode.window.onDidChangeActiveColorTheme(() => provider.scheduleRefresh(0)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vcSmartGit')) {
        provider.scheduleRefresh(50);
      }
    }),
  );

  try {
    context.subscriptions.push(await observeBuiltInGit(() => provider.scheduleRefresh()));
  } catch (error) {
    output.warn(`Unable to observe the built-in Git extension: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function deactivate(): void {}
