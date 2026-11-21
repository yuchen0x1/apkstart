'use strict';

/** pwsh 经 Node 拉起 Windows PowerShell 5.1 时，不能继承 7 的模块搜索路径。 */
function windowsPowerShellEnv(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  // 仅让 5.1 重建模块路径；执行策略、语言限制等其余环境原样保留。
  return env;
}

module.exports = { windowsPowerShellEnv };
