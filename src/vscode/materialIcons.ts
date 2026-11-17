import * as path from 'node:path';

interface IconThemeMappings {
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
}


export interface MaterialIconThemeData extends IconThemeMappings {
  iconDefinitions: Record<string, { iconPath?: string }>;
  file?: string;
  light?: IconThemeMappings;
}

function lookup(mapping: Record<string, string> | undefined, key: string): string | undefined {
  return mapping?.[key] ?? mapping?.[key.toLowerCase()];
}

function extensionCandidates(fileName: string): string[] {
  const normalized = fileName.toLowerCase();
  const candidates: string[] = [];
  for (let index = normalized.indexOf('.'); index >= 0; index = normalized.indexOf('.', index + 1)) {
    if (index + 1 < normalized.length) {
      candidates.push(normalized.slice(index + 1));
    }
  }
  return candidates;
}

export function resolveMaterialIconPath(
  filePath: string,
  theme: MaterialIconThemeData,
  useLightVariant: boolean,
): string | undefined {
  const fileName = path.posix.basename(filePath.replaceAll('\\', '/'));
  const light = useLightVariant ? theme.light : undefined;
  let definition = lookup(light?.fileNames, fileName)
    ?? lookup(theme.fileNames, fileName);

  if (!definition) {
    const candidates = extensionCandidates(fileName);
    for (const candidate of candidates) {
      definition = lookup(light?.fileExtensions, candidate)
        ?? lookup(theme.fileExtensions, candidate);
      if (definition) {
        break;
      }
    }
  }

  definition ??= theme.file;
  return definition ? theme.iconDefinitions[definition]?.iconPath : undefined;
}
