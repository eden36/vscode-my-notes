import * as fs from 'node:fs/promises';
import path from 'node:path';

/** 验收显式指定的 VSIX，默认选择当前版本最新的打包产物。 */
export async function packageArtifact(explicit) {
  if (explicit) {
    const file = path.resolve(explicit);
    await fs.access(file);
    return file;
  }
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const candidates = ['.dev/mynotes-refactor.vsix', `${manifest.name}-${manifest.version}.vsix`];
  const available = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      available.push({ file: path.resolve(candidate), time: stat.mtimeMs });
    } catch (error) {
      if (error.code !== 'ENOENT') { throw error; }
    }
  }
  available.sort((left, right) => right.time - left.time);
  if (!available.length) { throw new Error('缺少 VSIX，请先运行 npm run package。'); }
  return available[0].file;
}
