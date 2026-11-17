import path from 'node:path';
import * as vscode from 'vscode';

export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly entries = new Map<string, string>();
  private nextId = 0;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const id = new URLSearchParams(uri.query).get('id');
    return id ? this.entries.get(id) ?? '' : '';
  }

  public create(content: string, filePath: string, label: string): vscode.Uri {
    const id = String(this.nextId++);
    this.entries.set(id, content);
    if (this.entries.size > 500) {
      const first = this.entries.keys().next().value as string | undefined;
      if (first) {
        this.entries.delete(first);
      }
    }
    return vscode.Uri.from({
      scheme: 'vc-smart-git',
      path: `/${path.basename(filePath)}`,
      query: `id=${encodeURIComponent(id)}`,
      fragment: label,
    });
  }

  public dispose(): void {
    this.entries.clear();
  }
}

export function resolveRepositoryPath(root: string, relativePath: string): string {
  const absolute = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Git returned a path outside the repository.');
  }
  return absolute;
}
