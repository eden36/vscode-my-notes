// 标准库读取 VSIX，验证运行入口、静态资源与排除范围。
import { execFileSync } from 'node:child_process';
import { packageArtifact } from './package-artifact.mjs';
const archive = await packageArtifact(process.argv[2]);
const check = [
  'import json, sys, zipfile, xml.etree.ElementTree as ET',
  'with zipfile.ZipFile(sys.argv[1]) as archive:',
  '    names = set(archive.namelist())',
  "    required = {'extension/package.json', 'extension/dist/extension.js', 'extension/dist/askpassMain.js', 'extension/dist/settings.js', 'extension/dist/settings.css', 'extension/resources/notes.svg', 'extension/resources/icon.svg', 'extension/resources/icon.png', 'extension/resources/third-party/ripgrep-LICENSE-MIT.txt', 'extension/resources/third-party/pcre2-LICENSE.md', 'extension/dist/ripgrep/LICENSE-vscode-ripgrep'}",
  "    identity = ET.fromstring(archive.read('extension.vsixmanifest')).find('.//{*}Identity')",
  "    target = identity.attrib['TargetPlatform']",
  "    assert target in ('win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64')",
  "    binary = 'extension/dist/ripgrep/' + target + ('/rg.exe' if target.startswith('win32-') else '/rg')",
  '    required.add(binary)',
  '    assert required <= names, sorted(required - names)',
  "    binaries = {name for name in names if name.startswith('extension/dist/ripgrep/') and (name.endswith('/rg') or name.endswith('/rg.exe'))}",
  '    assert binaries == {binary}, sorted(binaries)',
  "    assert target.startswith('win32-') or (archive.getinfo(binary).external_attr >> 16) & 0o111",
  "    forbidden = ('extension/src/', 'extension/out/', 'extension/scripts/', 'extension/node_modules/', 'extension/.dev/', 'extension/tmp/', 'extension/design/')",
  '    assert not any(name.startswith(forbidden) for name in names)',
  "    assert 'extension/REFACTOR_PLAN.md' not in names",
  "    assert 'extension/SEARCH_PLAN.md' not in names",
  "    manifest = json.loads(archive.read('extension/package.json'))",
  "    assert manifest['main'] == './dist/extension.js'",
  "    assert manifest['icon'] == 'resources/icon.png'",
  "    print(json.dumps({'files': len(names), 'version': manifest['version'], 'target': target}))",
].join('\n');
const result = execFileSync('python', ['-c', check, archive], {
  encoding: 'utf8', windowsHide: true
});
console.log(`通过 VSIX 资源与排除清单 ${result.trim()}`);
