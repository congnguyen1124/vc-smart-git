export interface GitBlameLine {
  hash: string;
  originalLine: number;
  finalLine: number;
  author: string;
  authorEmail: string;
  authorTime: number;
  authorTimezone: string;
  summary: string;
  filePath: string;
  content: string;
  uncommitted: boolean;
}

const headerPattern = /^(\^?[0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/i;

export function parseBlamePorcelain(output: string): GitBlameLine[] {
  const rows = output.split('\n');
  const result: GitBlameLine[] = [];
  let index = 0;

  while (index < rows.length) {
    const header = headerPattern.exec(rows[index] ?? '');
    if (!header) {
      index += 1;
      continue;
    }

    const hash = (header[1] ?? '').replace(/^\^/, '');
    const originalLine = Number(header[2]);
    const finalLine = Number(header[3]);
    const metadata: Record<string, string> = {};
    index += 1;

    while (index < rows.length && !(rows[index] ?? '').startsWith('\t')) {
      const row = rows[index] ?? '';
      const separator = row.indexOf(' ');
      if (separator > 0) {
        metadata[row.slice(0, separator)] = row.slice(separator + 1);
      } else if (row) {
        metadata[row] = '';
      }
      index += 1;
    }

    const content = (rows[index] ?? '').startsWith('\t') ? (rows[index] ?? '').slice(1) : '';
    if ((rows[index] ?? '').startsWith('\t')) {
      index += 1;
    }
    const authorEmail = metadata['author-mail'] ?? '';
    result.push({
      hash,
      originalLine,
      finalLine,
      author: metadata.author ?? 'Unknown',
      authorEmail: authorEmail.replace(/^<|>$/g, ''),
      authorTime: Number(metadata['author-time'] ?? 0),
      authorTimezone: metadata['author-tz'] ?? '',
      summary: metadata.summary ?? '',
      filePath: metadata.filename ?? '',
      content,
      uncommitted: /^0+$/.test(hash),
    });
  }

  return result;
}
