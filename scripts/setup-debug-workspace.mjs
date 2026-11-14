// F5 调试前的准备脚本：生成一个带示例笔记的临时工作区，并把
// syncnotes.notesLocation 指向它，这样调试宿主一启动就能直接看到笔记树，
// 不用每次手动执行「选择笔记目录」，也不会碰到你日常使用的真实笔记。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDir = path.join(repoRoot, '.dev', 'test-workspace');
// 笔记目录必须落在本仓库之外。它自身会成为一个 Git 仓库，若放在仓库内部，
// 插件为保护外层仓库会直接中止同步，Git 后端根本无法调试；.gitignore 也挡不住
// 这一点，Git 判断归属看的是工作树而不是忽略规则。
const notesDir = path.join(homedir(), '.syncnotes-debug', 'notes');
const legacyNotesDir = path.join(workspaceDir, 'notes');
const reset = process.argv.includes('--reset');

const SAMPLE_FILES = {
  '快速开始.md': [
    '# 欢迎使用 SyncNotes 调试工作区',
    '',
    '这是按 F5 启动调试时自动打开的示例笔记目录，用于快速验证笔记与同步功能，',
    '不会影响你日常使用的真实笔记。',
    '',
    `- 目录位置：\`${notesDir}\``,
    '- 特意放在插件仓库之外，Git 后端才能正常调试，也不会牵连插件项目自身的仓库',
    '- 如需清空并重新生成示例内容，运行 `npm run debug:reset`',
    '',
  ].join('\n'),
  '工作/周报.md': ['# 本周周报', '', '- 完成事项：', '- 待办事项：', ''].join('\n'),
  '想法/随手记.md': ['# 随手记', '', '随便记点什么。', ''].join('\n'),
};

if (reset && existsSync(notesDir)) {
  rmSync(notesDir, { recursive: true, force: true });
  console.log('已清空示例笔记目录');
}

if (!existsSync(notesDir)) {
  for (const [relativePath, content] of Object.entries(SAMPLE_FILES)) {
    const filePath = path.join(notesDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
  console.log(`已生成示例笔记：${notesDir}`);
} else {
  console.log(`示例笔记已存在，保留现有内容（如需重置运行 npm run debug:reset）：${notesDir}`);
}

// notesLocation 是 application 作用域，只能从用户设置读取，写在工作区设置里不生效。
// 调试宿主在 launch.json 里指定了独立的 --user-data-dir，因此写进那份用户设置，
// 既能让调试宿主一启动就读到，也不会碰你日常使用的 VS Code 配置。
const userSettingsPath = path.join(repoRoot, '.dev', 'user-data', 'User', 'settings.json');
mkdirSync(path.dirname(userSettingsPath), { recursive: true });

let userSettings = {};
if (existsSync(userSettingsPath)) {
  try {
    userSettings = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
  } catch {
    console.log('调试宿主的用户设置无法解析，将重新生成');
  }
}
userSettings['syncnotes.notesLocation'] = notesDir;
writeFileSync(userSettingsPath, JSON.stringify(userSettings, null, 2), 'utf8');

// 早期版本把 notesLocation 写在工作区设置里，留着会被 VS Code 标为「只能在用户设置中应用」
const legacyWorkspaceSettings = path.join(workspaceDir, '.vscode', 'settings.json');
if (existsSync(legacyWorkspaceSettings)) {
  try {
    const legacy = JSON.parse(readFileSync(legacyWorkspaceSettings, 'utf8'));
    if ('syncnotes.notesLocation' in legacy) {
      delete legacy['syncnotes.notesLocation'];
      if (Object.keys(legacy).length === 0) {
        rmSync(legacyWorkspaceSettings, { force: true });
      } else {
        writeFileSync(legacyWorkspaceSettings, JSON.stringify(legacy, null, 2), 'utf8');
      }
      console.log('已移除工作区设置中失效的 notesLocation');
    }
  } catch {
    // 内容异常就不动它，避免误删用户手写的配置
  }
}

// 旧版本把示例笔记放在仓库内的 .dev/test-workspace/notes，留着会继续挡住 Git 后端调试
if (existsSync(legacyNotesDir)) {
  console.log(`提示：旧的示例笔记目录仍在仓库内，确认无用后可删除：${legacyNotesDir}`);
}

console.log('调试工作区已就绪');
