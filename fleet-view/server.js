#!/usr/bin/env node
// Fleet View live server: one per fleet, keeps running after VS Code or the tab closes.
//   node server.js <fleet-dir> [port]      → http://127.0.0.1:<port>/
// Watches locks, sessions (hook.js), reviews and overviews; pushes state over SSE.
// Every /api and /events call needs the token in <fleet>/.fleet-view/token, and the Host
// header must be loopback (blocks DNS rebinding): review comments end up in agent context.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { snapshot, aggregate, transitions, agents, phase } = require('./gather');
const review = require('./review');

const FLEET = path.resolve(process.argv[2] || '');
let PORT = +(process.argv[3] || 7420); // 0, or a busy port, takes a free one; server.json says which
if (!fs.existsSync(path.join(FLEET, 'fleet.conf'))) { console.error('usage: server.js <fleet-dir> [port]'); process.exit(1); }
process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;
let AUTHOR = 'reviewer';
try { AUTHOR = execFileSync('git', ['config', 'user.name']).toString().trim() || AUTHOR; } catch {}

const HOME = path.join(FLEET, '.fleet-view');
const OVERVIEWS = path.join(FLEET, 'scratchpad', 'overviews');
for (const d of [HOME, path.join(HOME, 'sessions'), review.reviewDir(FLEET), OVERVIEWS, path.join(FLEET, '.locks'), path.join(FLEET, 'briefs')]) fs.mkdirSync(d, { recursive: true });

const tokenFile = path.join(HOME, 'token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
const TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();

// Let hook.js find this fleet even from sessions started outside it.
const known = path.join(require('os').homedir(), '.claude', 'fleet', 'fleets.json');
try { const k = new Set(JSON.parse(fs.readFileSync(known, 'utf8'))); k.add(FLEET); fs.writeFileSync(known, JSON.stringify([...k])); }
catch { fs.writeFileSync(known, JSON.stringify([FLEET])); }

const histFile = path.join(HOME, 'history.json');
let hist = {}; try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {}
let state = { loading: true }, jobs = {}, busy = false, again = false;
const clients = new Set();

async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const snap = await snapshot(FLEET);
    // "Before" is the last snapshot that differed; it survives restarts.
    const moved = transitions(hist.snap, snap);
    if (!hist.snap || moved.length) {
      // A slim frame per change, for the page's time scrubber.
      const frame = { at: snap.at, trans: moved, workers: snap.workers.map(w => ({ name: w.name, state: w.state, ticket: w.ticket, title: w.record?.title, phase: w.phase })) };
      hist = { snap, prev: hist.snap || null, trans: moved.length ? moved : hist.trans || [], changedAt: snap.at, frames: [...(hist.frames || []), frame].slice(-200) };
      fs.writeFileSync(histFile, JSON.stringify(hist));
    }
    const reviews = {}, drafts = {};
    for (const t of new Set([...snap.workers.map(w => w.ticket), ...snap.records.map(r => r.task)].filter(Boolean))) {
      const items = review.read(FLEET, t);
      if (items.length) reviews[t] = items;
      const d = review.drafts(FLEET, t);
      if (d.length) drafts[t] = d;
    }
    state = { snap, agg: aggregate(snap), trans: hist.trans, changedAt: hist.changedAt, frames: hist.frames || [], reviews, drafts, jobs, port: PORT };
    autoGuides(snap);
    push();
  } catch (e) { console.error(e); }
  busy = false;
  if (again) { again = false; refresh(); }
}

function push() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const c of clients) c.write(msg);
}

let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 400); };
for (const d of ['.locks', '.fleet-view/sessions', 'scratchpad/reviews', 'scratchpad/overviews', 'briefs'])
  fs.watch(path.join(FLEET, d), { recursive: true }, soon);
setInterval(refresh, 30000);
// Subagent transcripts live under ~/.claude/projects, outside the folders watched above, and change
// on every tool call: poll just those (cached reads, no git) and push only when something moved.
setInterval(() => {
  if (busy || !state.snap) return;
  let moved = false;
  for (const w of state.snap.workers) {
    const si = w.sessionInfo;
    if (!si?.transcript) continue;
    const a = agents(si.transcript);
    if (JSON.stringify(a) === JSON.stringify({ agents: si.agents, sent: si.sent })) continue;
    w.sessionInfo = { ...si, ...a };
    w.phase = phase(w);
    moved = true;
  }
  if (moved) push();
}, 3000);

// Review guides, written headless and read-only by claude -p, one Markdown file per ticket:
//   gate   <TASK>.md         after every gate pass on new code: why, summary, diagrams, reading order, tests
//   review <TASK>.review.md  once the ticket reaches review: all of that plus a line-level review checklist
//                            (logic, schemas, security, standards, code) and the decisions to challenge
// Each file's header names the code tree it was written for, so a guide is written once per tree.
const GUIDE_FILE = { gate: t => `${t}.md`, review: t => `${t}.review.md` };
const clip = (f, n = 8000) => { try { return fs.readFileSync(f, 'utf8').slice(0, n); } catch { return ''; } };

function guidePrompt(r, kind) {
  const brief = clip(path.join(FLEET, 'briefs', `${r.task}.md`));
  const reviews = clip(path.join(review.reviewDir(FLEET), `${r.task}.md`));
  const gate = (r.harness?.steps || []).find(x => x.key === 'gate');
  const where = r.codeDir
    ? `The branch ${r.branch} is checked out in this folder. Diff it against ${r.mergeBase} (its merge-base with ${r.base}) and include uncommitted changes (git diff, git status).`
    : `The branch ${r.branch} is not checked out here. Diff ${r.mergeBase}..${r.branch} (the merge-base with ${r.base}) and read files with git show ${r.branch}:<path>, never from the working tree.`;
  const link = '[path/to/file.js:42](path/to/file.js#L42)';
  return `Write a review guide for ticket ${r.task} (${r.title}), so a developer who has never seen this work can review it. Do not create or edit any file.
${where}
${brief ? `The agreed brief, which is the spec:\n<brief>\n${brief}\n</brief>` : 'There is no brief; take the intent from the commits and the code.'}
${reviews ? `Review comments so far:\n<reviews>\n${reviews}\n</reviews>` : ''}
If a change-walkthrough skill is installed, read its diagrams.md to pick diagrams. If the team has a writing standard skill installed (for commit messages, PR descriptions or reviews), follow it.
Print one Markdown document and nothing else, with these headings in this order:

# <a plain phrase naming what the change delivers>
## Why
Two or three short sentences: the problem and what the ticket asks for. Bold the one phrase that matters most.
## Summary
Three to six bullets, each starting with a bold lead of a few words (**Like this:**) then one sentence: what changed, where it lives, how it works now. No paragraph.
## D1: Big picture
A \`\`\`mermaid flowchart of the part of the system this touches: modules, routes or components and how they connect. Give every node this change adds or modifies the class changed (\`A:::changed\`) and end with \`classDef changed stroke-width:3px\`. Label nodes with the names a reader can grep. One caption line after the block.
## D2: Data flow
A \`\`\`mermaid sequenceDiagram of how data enters, moves through and leaves the change, with the request and response shapes on the arrows. Do not wrap participant names or messages in quotes. One caption line.
(Add D3, D4 only if the change has a state machine or a second flow worth drawing.)
## Reading order
Group the changed files by concern, the core change first, then callers, config, tests. Each group is "### <n>. <name>" where the name matches a changed node label in D1 when there is one, then one sentence. Then one block per file:
${link} (new | modified | deleted)
- What changed: real function, route, key and field names
- Why: why this file had to change
- Check: the one or two things worth the reviewer's eye
## Tests
What tests cover the change, what ran${gate ? ` (gate: ${gate.text})` : ''}, and what is not covered.
${kind === 'review' ? `## Review checklist
Read every changed line for this part. Five subsections, each "### <name>" with bullets that start with a file link in the form ${link}, or one bullet "Nothing found: <what you checked>":
### Logic
Wrong conditions, missed cases, error handling, races, behaviour that differs from the brief.
### Request and response schemas
Every request, response, event or stored shape the change adds or alters, as a table: field, type, required, where it is validated. Then mismatches between producer and consumer.
### Security
Trust boundaries, auth and permission checks, input validation, injection, secrets, data exposure, unsafe defaults.
### Team standards
The repo's CLAUDE.md, AGENTS.md or contributing docs and the team standard skill: naming, structure, commit and comment rules this change breaks.
### Code and comments
Structure, dead code, duplication, comments that are wrong, missing or out of date.
## Open items
Numbered decisions a reviewer should challenge, six at most: the decision, why it was made, its consequence, and a closed question the reviewer can answer in one line.
` : ''}Use repo-relative paths. Never use dashes as punctuation.`;
}

function generateGuide(r, kind) {
  const key = `${r.task}:${kind}`;
  if (jobs[key] || !r.branch || !r.mergeBase) return;
  jobs[key] = { task: r.task, kind, startedAt: new Date().toISOString() };
  const p = spawn('claude', ['-p', guidePrompt(r, kind), '--output-format', 'text',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Skill', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git ls-tree:*)', 'Bash(git merge-base:*)',
    // --output makes git diff, log and show write a file, so the git rules above are not read-only alone.
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash(git *--output*)'], { cwd: r.codeDir || state.snap.repoDir, env: process.env });
  let out = '', err = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (err += d));
  const kill = setTimeout(() => p.kill(), 15 * 60 * 1000);
  p.on('close', code => {
    clearTimeout(kill);
    delete jobs[key];
    // The tree is recorded even on failure, so a broken run is not retried on every refresh.
    const meta = `<!-- kind=${kind} tree=${r.harness?.tree || ''} base=${r.mergeBase} at=${new Date().toISOString()} exit=${code} -->\n`;
    fs.writeFileSync(path.join(OVERVIEWS, GUIDE_FILE[kind](r.task)), meta + (code === 0 && out.trim() ? out.trim() : `Guide generation failed (exit ${code}).\n\n\`\`\`\n${err.slice(-2000)}\n\`\`\``));
    refresh();
  });
  refresh();
}

// After every gate pass on new code, a guide; once the ticket reaches review, the in-depth one.
// ponytail: at most 2 runs at once, the rest wait for a later refresh; a real queue if fleets grow.
function autoGuides(snap) {
  for (const r of snap.records) {
    const h = r.harness, tree = h?.tree;
    if (!tree || !r.mergeBase || !(r.ahead || r.codeDir) || Object.keys(jobs).length >= 2) continue;
    const gatePassed = h.steps.find(x => x.key === 'gate')?.state === 'ok';
    const atReview = r.state === 'review' || !h.blocker;
    if (atReview && r.guides.review?.tree !== tree) generateGuide(r, 'review');
    else if (gatePassed && r.guides.gate?.tree !== tree) generateGuide(r, 'gate');
  }
}

function page() {
  const nonce = crypto.randomBytes(12).toString('base64');
  const csp = `default-src 'none'; style-src 'unsafe-inline' 'self'; font-src 'self'; img-src data: https:; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src 'self'`;
  return fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8')
    .replace('__CSP__', csp).replaceAll('__NONCE__', nonce).replace('__CODICONS__', '/media/codicon.css')
    .replace('__CFG__', JSON.stringify({ server: '', token: TOKEN, mode: 'browser' }));
}

const body = req => new Promise(res => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end(); }
  // Only the VS Code webview gets CORS; the browser page is same-origin. A wildcard would let
  // any website read the token out of GET / and post comments that reach agent context.
  const origin = req.headers.origin || '';
  if (origin.startsWith('vscode-webview://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-fleet-token');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(page()); }
  // Bundled icons, so the page works offline.
  const media = { '/media/codicon.css': 'text/css', '/media/codicon.ttf': 'font/ttf' }[url.pathname];
  if (media) { res.writeHead(200, { 'content-type': media, 'cache-control': 'max-age=86400' }); return res.end(fs.readFileSync(path.join(__dirname, url.pathname))); }

  const token = req.headers['x-fleet-token'] || url.searchParams.get('token');
  if (token !== TOKEN) { res.writeHead(401); return res.end('bad token'); }
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/ping') return json({ ok: true, fleet: FLEET, pid: process.pid });
  if (url.pathname === '/api/state') return json(state);
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    clients.add(res);
    return req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const b = await body(req);
  const w = state.snap?.workers.find(x => x.name === b.worker);
  const task = b.ticket || w?.ticket;
  if (!/^[A-Za-z0-9._-]+$/.test(task || '')) return json({ error: 'no ticket' }, 400);
  if (url.pathname === '/api/comment') {
    if (!String(b.text || '').trim()) return json({ error: 'empty' }, 400);
    review.add(FLEET, task, { file: String(b.file || '(general)').replace(/\n/g, ' '), line: +b.line || null, text: String(b.text), author: b.author || AUTHOR });
    soon(); return json({ ok: true });
  }
  if (url.pathname === '/api/resolve') { review.setDone(FLEET, task, +b.index, !!b.done); soon(); return json({ ok: true }); }
  if (url.pathname === '/api/followup') {
    if (!String(b.text || '').trim()) return json({ error: 'empty' }, 400);
    review.followUp(FLEET, task, +b.index, { text: String(b.text), author: b.author || AUTHOR }); soon(); return json({ ok: true });
  }
  if (url.pathname === '/api/complete') { review.setComplete(FLEET, task, +b.index, !!b.complete, b.author || AUTHOR); soon(); return json({ ok: true }); }
  // A review is drafted privately, then submitted into the review file the agent reads.
  if (url.pathname === '/api/draft') {
    if (!String(b.text || '').trim()) return json({ error: 'empty' }, 400);
    review.addDraft(FLEET, task, { file: String(b.file || '(general)').replace(/\n/g, ' '), line: +b.line || null, text: String(b.text), author: b.author || AUTHOR });
    soon(); return json({ ok: true });
  }
  if (url.pathname === '/api/draft-remove') { review.removeDraft(FLEET, task, +b.index); soon(); return json({ ok: true }); }
  if (url.pathname === '/api/submit') { const n = review.submit(FLEET, task, { note: b.note, author: b.author || AUTHOR }); soon(); return json({ ok: true, n }); }
  // One file's diff for the inline preview: the worker's tree (uncommitted included) or the branch.
  if (url.pathname === '/api/diff') {
    const r = state.snap.records.find(x => x.task === task), file = String(b.file || '');
    if (!r?.mergeBase || !file || path.isAbsolute(file) || file.split('/').includes('..')) return json({ error: 'no diff' }, 400);
    const dir = r.codeDir || state.snap.repoDir;
    const args = r.codeDir ? ['diff', '--no-color', r.mergeBase, '--', file] : ['diff', '--no-color', r.mergeBase, r.branch, '--', file];
    const git = a => new Promise(res => execFile('git', ['-C', dir, ...a], { maxBuffer: 1 << 24 }, (e, out) => res(out || '')));
    let diff = await git(args);
    // An untracked file in the worker has no diff against git yet: show it as all new.
    if (!diff && r.codeDir && fs.existsSync(path.join(dir, file))) diff = await git(['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    return json({ diff: diff.slice(0, 400000) });
  }
  const rec = state.snap.records.find(r => r.task === task);
  if (url.pathname === '/api/guide') {
    if (!rec || !GUIDE_FILE[b.kind]) return json({ error: 'no open ticket or kind' }, 400);
    generateGuide(rec, b.kind); return json({ ok: true });
  }
  // Diagram PNGs for a review tool that cannot render Mermaid, to attach by hand.
  if (url.pathname === '/api/guide-assets') {
    const dir = path.join(FLEET, 'scratchpad', 'guides', task);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [].concat(b.files || [])) {
      if (!/^[\w.-]+\.png$/.test(f.name || '') || typeof f.png !== 'string') continue;
      fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.png, 'base64'));
    }
    return json({ ok: true, dir });
  }
  json({ error: 'not found' }, 404);
});
// A second fleet, or a port someone else holds, falls back to a free port.
server.on('error', e => { if (e.code === 'EADDRINUSE' && PORT) { PORT = 0; server.listen(0, '127.0.0.1'); } else throw e; });
server.listen(PORT, '127.0.0.1');
server.on('listening', () => {
  PORT = server.address().port;
  fs.writeFileSync(path.join(HOME, 'server.json'), JSON.stringify({ port: PORT, pid: process.pid, startedAt: new Date().toISOString() }));
  console.log(`fleet view on http://127.0.0.1:${PORT}/ for ${FLEET}`);
  refresh();
});
