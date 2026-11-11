import {spawnSync} from 'node:child_process';
const files = ['renderer.js', 'core/policy.mjs', 'core/controller.mjs', 'bridge/server.mjs',
  'backend/main.mjs', 'core/session-state.mjs', 'launch/before.mjs'];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {stdio: 'inherit', windowsHide: true});
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write('运行入口语法检查通过\n');
