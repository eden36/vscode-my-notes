/**
 * git 通过 GIT_ASKPASS 以独立进程拉起本脚本索取凭据，并把提示语作为第一个参数传入。
 * 凭据经环境变量传递——写在命令行上会暴露在进程列表中。
 * 本文件单独打包为 dist/askpassMain.js，不能引用 vscode 模块。
 */
function main(): void {
  const prompt = (process.argv[2] ?? '').toLowerCase();

  let value: string | undefined;
  if (prompt.includes('username')) {
    value = process.env['SYNCNOTES_GIT_USERNAME'];
  } else if (prompt.includes('password') || prompt.includes('token')) {
    value = process.env['SYNCNOTES_GIT_PASSWORD'];
  }

  // 无法识别的提示（如 SSH key 口令）一律不作答，让 git 按失败处理而不是挂起
  if (value === undefined) {
    process.exit(1);
  }

  process.stdout.write(`${value}\n`);
  process.exit(0);
}

main();
