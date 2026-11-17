import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMaterialIconPath, type MaterialIconThemeData } from '../vscode/materialIcons';

const theme: MaterialIconThemeData = {
  iconDefinitions: {
    file: { iconPath: './../icons/file.svg' },
    node: { iconPath: './../icons/node.svg' },
    typescript: { iconPath: './../icons/typescript.svg' },
    test: { iconPath: './../icons/test-ts.svg' },
    toml: { iconPath: './../icons/toml.svg' },
    tomlLight: { iconPath: './../icons/toml_light.svg' },
  },
  file: 'file',
  fileNames: { 'package.json': 'node' },
  fileExtensions: { ts: 'typescript', 'test.ts': 'test', toml: 'toml' },
  light: { fileExtensions: { toml: 'tomlLight' } },
};

test('resolveMaterialIconPath follows Material Icon Theme filename and compound-extension priority', () => {
  assert.equal(resolveMaterialIconPath('package.json', theme, false), './../icons/node.svg');
  assert.equal(resolveMaterialIconPath('src/widget.test.ts', theme, false), './../icons/test-ts.svg');
  assert.equal(resolveMaterialIconPath('src/widget.ts', theme, false), './../icons/typescript.svg');
});

test('resolveMaterialIconPath supports light variants, Windows paths, and fallback icons', () => {
  assert.equal(resolveMaterialIconPath('config/app.toml', theme, true), './../icons/toml_light.svg');
  assert.equal(resolveMaterialIconPath('src\\main.ts', theme, false), './../icons/typescript.svg');
  assert.equal(resolveMaterialIconPath('README', theme, false), './../icons/file.svg');
});
