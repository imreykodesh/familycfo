const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const kiro = process.env.LOCALAPPDATA + '\\Kiro-Cli\\kiro-cli.exe';
const t0 = Date.now();
const c = spawn(kiro, ['acp'], { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, NO_COLOR: '1', PATH: path.dirname(kiro) + ';' + process.env.PATH } });
let buf = '', id = 0; const pending = new Map();
const req = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
c.stdout.on('data', d => {
  buf += d; let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n).trim(); buf = buf.slice(n + 1);
    if (!line.startsWith('{')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  }
});
let err = ''; c.stderr.on('data', d => err += d);
const kill = setTimeout(() => { console.log('TIMEOUT', err.slice(-500)); c.kill(); process.exit(1); }, 90000);
(async () => {
  const init = await req('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'familycfo', version: '1' } });
  console.log('init', Date.now() - t0, 'ms', JSON.stringify(init.agentInfo));
  const s = await req('session/new', { cwd: os.tmpdir(), mcpServers: [] });
  console.log('session', Date.now() - t0, 'ms');
  const m = s.models;
  console.log('current:', m?.currentModelId);
  for (const x of m?.availableModels ?? []) console.log(`- ${x.modelId} | ${x.name} | ${x.description ?? ''}`);
  clearTimeout(kill); c.kill(); process.exit(0);
})().catch(e => { console.log('ERR', e.message, err.slice(-500)); c.kill(); process.exit(1); });
