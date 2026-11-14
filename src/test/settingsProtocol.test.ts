import * as assert from 'assert';
import { parseInbound, validateConfigUpdate } from '../settings/protocol';

describe('设置协议校验', () => {
  it('拒绝未登记配置项与错误类型', () => {
    assert.throws(() => validateConfigUpdate('unknown', true));
    assert.throws(() => validateConfigUpdate('sync.onSave', 'true'));
    assert.throws(() => parseInbound({ type: 'saveCredential', provider: 'unknown', value: 'fixture' }));
  });
  it('数值范围遵循现有设置声明并支持小数', () => {
    assert.throws(() => validateConfigUpdate('sync.focusCooldownSeconds', 9));
    assert.throws(() => validateConfigUpdate('sync.onSaveDebounceSeconds', 0));
    validateConfigUpdate('sync.onSaveDebounceSeconds', 1.5);
    validateConfigUpdate('sync.focusCooldownSeconds', 172800);
  });
  it('保留合法复合扩展名并拒绝路径字符', () => {
    validateConfigUpdate('defaultNoteExtension', '.tar.gz');
    validateConfigUpdate('noteExtensions', ['md', 'txt', '*']);
    assert.throws(() => validateConfigUpdate('defaultNoteExtension', '../md'));
  });
  it('拒绝嵌入密码、远端越级路径与 Git 选项参数', () => {
    assert.throws(() => validateConfigUpdate('sync.webdav.url', 'https://user:password@example.invalid'));
    assert.throws(() => validateConfigUpdate('sync.webdav.remotePath', '/notes/../other'));
    assert.throws(() => validateConfigUpdate('sync.git.remoteUrl', '--upload-pack=command'));
  });
});
