import path from 'node:path';
import * as vscode from 'vscode';
import { GitRepository } from '../git/repository';
import type { RepositorySummary } from '../git/types';

interface BuiltInRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    onDidChange(listener: () => void): vscode.Disposable;
  };
}

interface BuiltInGitApi {
  readonly repositories: readonly BuiltInRepository[];
  readonly onDidOpenRepository: vscode.Event<BuiltInRepository>;
  readonly onDidCloseRepository: vscode.Event<BuiltInRepository>;
}

interface BuiltInGitExports {
  getAPI(version: 1): BuiltInGitApi;
}

async function builtInGitApi(): Promise<BuiltInGitApi | undefined> {
  const extension = vscode.extensions.getExtension<BuiltInGitExports>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.getAPI(1);
}

export async function discoverRepositories(gitPath: string): Promise<RepositorySummary[]> {
  const roots = new Map<string, RepositorySummary>();
  const api = await builtInGitApi();
  for (const repository of api?.repositories ?? []) {
    const root = path.normalize(repository.rootUri.fsPath);
    roots.set(root, { root, name: path.basename(root) });
  }

  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
    const candidate = new GitRepository(folder.uri.fsPath, gitPath);
    const result = await candidate.run(['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (result.exitCode === 0) {
      const root = path.normalize(result.stdout.trim());
      if (root) {
        roots.set(root, { root, name: path.basename(root) });
      }
    }
  }));

  return [...roots.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function observeBuiltInGit(onChange: () => void): Promise<vscode.Disposable> {
  const subscriptions: vscode.Disposable[] = [];
  const repositorySubscriptions = new Map<string, vscode.Disposable>();
  const api = await builtInGitApi();

  const observeRepository = (repository: BuiltInRepository): void => {
    const key = repository.rootUri.toString();
    repositorySubscriptions.get(key)?.dispose();
    repositorySubscriptions.set(key, repository.state.onDidChange(onChange));
  };
  const stopObservingRepository = (repository: BuiltInRepository): void => {
    const key = repository.rootUri.toString();
    repositorySubscriptions.get(key)?.dispose();
    repositorySubscriptions.delete(key);
  };

  for (const repository of api?.repositories ?? []) {
    observeRepository(repository);
  }
  if (api) {
    subscriptions.push(api.onDidOpenRepository((repository) => {
      observeRepository(repository);
      onChange();
    }));
    subscriptions.push(api.onDidCloseRepository((repository) => {
      stopObservingRepository(repository);
      onChange();
    }));
  }

  return new vscode.Disposable(() => {
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    for (const subscription of repositorySubscriptions.values()) {
      subscription.dispose();
    }
  });
}
