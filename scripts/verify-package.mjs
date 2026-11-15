// 标准库读取 VSIX，验证运行入口、静态资源与排除范围。
import { execFileSync } from 'node:child_process';
import { packageArtifact } from './package-artifact.mjs';
const archive = await packageArtifact(process.argv[2]);
const check = [
  'import json, sys, zipfile',
  'with zipfile.ZipFile(sys.argv[1]) as archive:',
  '    names = set(archive.namelist())',
  "    required = {'extension/package.json', 'extension/dist/extension.js', 'extension/dist/askpassMain.js', 'extension/dist/settings.js', 'extension/dist/settings.css', 'extension/resources/notes.svg', 'extension/resources/third-party/ripgrep-LICENSE-MIT.txt', 'extension/resources/third-party/pcre2-LICENSE.md', 'extension/dist/ripgrep/LICENSE-vscode-ripgrep'}",
  "    required |= {'extension/dist/ripgrep/' + platform + ('/rg.exe' if platform.startswith('win32-') else '/rg') for platform in ('win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64')}",
  '    assert required <= names, sorted(required - names)',
  "    assert all((archive.getinfo('extension/dist/ripgrep/' + platform + '/rg').external_attr >> 16) & 0o111 for platform in ('darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'))",
  "    forbidden = ('extension/src/', 'extension/out/', 'extension/scripts/', 'extension/node_modules/', 'extension/.dev/', 'extension/tmp/')",
  '    assert not any(name.startswith(forbidden) for name in names)',
  "    assert 'extension/REFACTOR_PLAN.md' not in names",
  "    assert 'extension/SEARCH_PLAN.md' not in names",
  "    manifest = json.loads(archive.read('extension/package.json'))",
  "    assert manifest['main'] == './dist/extension.js'",
  "    print(json.dumps({'files': len(names), 'version': manifest['version']}))",
].join('\n');
const result = execFileSync('python', ['-c', check, archive], {
  encoding: 'utf8', windowsHide: true
});
console.log(`通过 VSIX 资源与排除清单 ${result.trim()}`);
