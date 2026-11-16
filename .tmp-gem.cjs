// Runs the bundled Gemini CLI in a copy of the chat's work dir with a given settings variant and reports which tools it saw / used.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const variant = process.argv[2];
const src = path.join(os.tmpdir(), 'household-agent-gemini');
const dir = path.join(os.tmpdir(), `gem-variant-${variant}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.cpSync(src, dir, { recursive: true });
const sf = path.join(dir, '.gemini', 'settings.json');
const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
if (variant === 'nocore') delete s.tools.core;
if (variant === 'withmcp') s.tools.core = ['activate_skill', 'api', 'sql'];
if (variant === 'exclude') { delete s.tools.core; s.tools.exclude = ['run_shell_command', 'write_file', 'replace', 'read_file', 'read_many_files', 'glob', 'search_file_content', 'grep_search', 'list_directory', 'web_fetch', 'google_web_search', 'save_memory', 'write_todos']; }
fs.writeFileSync(sf, JSON.stringify(s, null, 2));
const key = fs.readFileSync(path.join(os.tmpdir(), 'fcfo-test-home', 'secrets', 'gemini-api-key'), 'utf8').trim();
const c = spawn(process.execPath, ['c:/projects/familycfo/node_modules/@google/gemini-cli/bundle/gemini.js', '--output-format', 'stream-json',
  '--allowed-mcp-server-names', 'household', '--extensions', 'none', '--skip-trust', '--model', 'gemini-2.5-flash'], {
  cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GEMINI_API_KEY: key, GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_SYSTEM_MD: path.join(dir, 'system.md') },
});
c.stdin.end('List the exact names of the tools you can call, then use the api tool to read /summary and tell me the total bank balance.');
let out = '';
c.stdout.on('data', d => out += d);
const t = setTimeout(() => c.kill(), 150000);
c.on('close', () => {
  clearTimeout(t);
  const ev = out.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tools = ev.filter(e => e.type === 'tool_use').map(e => e.tool_name);
  const text = ev.filter(e => e.type === 'message' && e.role === 'assistant').map(e => e.content).join('');
  console.log(`[${variant}] tools used: ${tools.join(', ') || '-'}\n  text: ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
