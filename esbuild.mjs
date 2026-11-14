import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * 打印构建错误的插件。watch 模式下 esbuild 默认静默失败，这里显式输出，
 * 否则改坏代码时终端没有任何反馈。
 *
 * `[watch] build started` / `[watch] build finished` 这两行是固定格式，
 * 供 .vscode/tasks.json 里自定义的 problemMatcher 识别构建的开始与结束——
 * 不依赖任何第三方扩展（如 connor4312.esbuild-problem-matchers）。
 * 错误行按 `<file>:<line>:<column>: error: <message>` 输出，同一份正则
 * 也用来把错误关联到具体文件，在「问题」面板中可点击跳转。
 */
let pendingBuilds = 0;

const problemReporter = {
  name: 'problem-reporter',
  setup(build) {
    build.onStart(() => {
      if (pendingBuilds === 0) {
        console.log('[watch] build started');
      }
      pendingBuilds++;
    });
    build.onEnd((result) => {
      for (const error of result.errors) {
        const loc = error.location;
        console.log(loc ? `${loc.file}:${loc.line}:${loc.column}: error: ${error.text}` : `esbuild: error: ${error.text}`);
      }
      for (const warning of result.warnings) {
        const loc = warning.location;
        console.log(loc ? `${loc.file}:${loc.line}:${loc.column}: warning: ${warning.text}` : `esbuild: warning: ${warning.text}`);
      }
      pendingBuilds--;
      if (pendingBuilds === 0) {
        console.log('[watch] build finished');
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // vscode 由扩展宿主在运行时注入，不能打包
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [problemReporter],
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
  }),
  // git 的 GIT_ASKPASS 会把这个脚本作为独立进程拉起，必须单独打包
  esbuild.context({
    ...shared,
    entryPoints: ['src/sync/git/askpassMain.ts'],
    outfile: 'dist/askpassMain.js',
  }),
  esbuild.context({
    ...shared,
    entryPoints: ['src/settings/webview/settings.ts'],
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: 'dist/settings.js',
  }),
  esbuild.context({
    ...shared,
    entryPoints: ['src/settings/webview/settings.css'],
    outfile: 'dist/settings.css',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
