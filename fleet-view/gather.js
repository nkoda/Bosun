// Read-only snapshot of a fleet: locks, per-worker changes, task records.
// Lock state and what needs tidying come from the engine (`fleet status --json`, `fleet gc
// --json`), so the widget always shows what `fleet claim` would see.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const review = require('./review');

// Extension hosts launched from the Dock don't get the shell PATH.
const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`, BD_NO_PAGER: '1', BD_NON_INTERACTIVE: '1', BD_DISABLE_METRICS: '1' };
const run = (cmd, args, extra = {}) => new Promise(res =>
  execFile(cmd, args, { maxBuffer: 1 << 24, env: { ...env, ...extra } }, (err, out) => res(err ? '' : out.trimEnd())));
const git = (dir, ...a) => run('git', ['-C', dir, ...a]);
// The engine next to this folder (install.sh links both from one checkout), else the installed one.
const ENGINE = [path.join(__dirname, '..', 'engine', 'fleet'), path.join(os.homedir(), '.claude', 'fleet', 'fleet')].find(f => fs.existsSync(f));
const engine = async (fleet, ...a) => { try { return JSON.parse(await run(ENGINE, ['-f', fleet, ...a]) || 'null'); } catch { return null; } };
const lines = s => (s ? s.split('\n') : []);

function findFleetDir(start) {
  for (let d = start; d && d !== path.dirname(d); d = path.dirname(d))
    if (fs.existsSync(path.join(d, 'fleet.conf'))) return d;
}

async function readConf(fleet) {
  const out = await run('bash', ['-c',
    '. "$1/fleet.conf" >/dev/null 2>&1; printf "%s\\n" "${WORKERS:-worker-1 worker-2 worker-3}" "${BASE_REMOTE:-origin}" "${BASE_BRANCH:-main}" "${FLEET_NAME:-}" "${JIRA_URL:-}" "${EXTRA_BASES:-}" "${BRIEF_REQUIRED:-0}" "${REVIEW_ROUNDS:-0}" "${GATE:+1}"',
    '_', fleet]);
  const [workers, remote, branch, name, jira, extra, brief, rounds, gate] = out.split('\n');
  return {
    workers: workers.split(/\s+/).filter(Boolean), base: `${remote}/${branch}`, remote, name: name || path.basename(fleet), jira: jira || '',
    extraBases: (extra || '').split(/\s+/).filter(Boolean), // other refs task branches may be cut from
    harness: { brief: brief === '1', rounds: +rounds || 0, gate: gate === '1' }, // what release --state review enforces
  };
}

// The base a branch was cut from: the candidate it has the fewest own commits on top of.
async function pickBase(dir, ref, bases) {
  const scored = await Promise.all(bases.map(async b => ({
    base: b,
    ahead: +(await git(dir, 'rev-list', '--count', `${b}..${ref}`) || Infinity),
    behind: +(await git(dir, 'rev-list', '--count', `${ref}..${b}`) || 0),
  })));
  return scored.sort((a, b) => a.ahead - b.ahead || a.behind - b.behind)[0];
}

const numstat = out => Object.fromEntries(lines(out).map(l => {
  const [add, del, file] = l.split('\t');
  return [file, { add: +add || 0, del: +del || 0 }];
}));

async function workerChanges(dir, bases) {
  const branch = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const head = await git(dir, 'rev-parse', '--short', 'HEAD');
  const { base, ahead, behind } = await pickBase(dir, 'HEAD', bases);
  const mergeBase = await git(dir, 'merge-base', base, 'HEAD');
  const [names, counts, commits, porcelain, wcounts] = await Promise.all([
    git(dir, 'diff', '--no-renames', '--name-status', mergeBase, 'HEAD'),
    git(dir, 'diff', '--no-renames', '--numstat', mergeBase, 'HEAD'),
    git(dir, 'log', '--format=%h%x09%cr%x09%ct%x09%s', '-n', '40', `${mergeBase}..HEAD`),
    git(dir, 'status', '--porcelain', '--untracked-files=all'),
    git(dir, 'diff', '--no-renames', '--numstat', 'HEAD'),
  ]);
  const c = numstat(counts), u = numstat(wcounts);
  const files = lines(names).map(l => {
    const [status, file] = l.split('\t');
    return { file, status, where: 'committed', ...c[file] };
  });
  for (const l of lines(porcelain)) {
    const file = l.slice(3).replace(/^.* -> /, '');
    files.push({ file, status: l.slice(0, 2).trim() || 'M', where: 'uncommitted', add: 0, del: 0, ...u[file] });
  }
  return {
    branch, head, base, mergeBase: mergeBase.slice(0, 10), ahead, behind, files,
    dirty: lines(porcelain).length,
    commits: lines(commits).map(l => { const [sha, when, ts, subject] = l.split('\t'); return { sha, when, ts: +ts, subject }; }),
  };
}

// Same as tree_id() in ../engine/fleet: HEAD plus every uncommitted and untracked change
// as one tree id, so a gate or review result can be matched to the code in the worker.
async function codeTree(dir) {
  const idx = path.join(os.tmpdir(), `fleet-view-index-${process.pid}-${path.basename(dir)}`);
  try { fs.copyFileSync(await git(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'index'), idx); } catch { return ''; }
  await run('git', ['-C', dir, 'add', '-A'], { GIT_INDEX_FILE: idx });
  const t = await run('git', ['-C', dir, 'write-tree'], { GIT_INDEX_FILE: idx });
  fs.rmSync(idx, { force: true });
  return t;
}

// Where a ticket stands against what release --state review checks, in the engine's
// order. Each step: ok | todo | fail | warn (fine, but worth a look) | off (not enforced).
function harnessSteps(conf, m, { brief, tree, unanswered, push }) {
  const h = conf.harness, steps = [];
  const fresh = t => !!t && !!tree && t === tree;
  steps.push(!h.brief ? { key: 'brief', state: 'off', text: 'Brief not required' }
    : brief ? { key: 'brief', state: 'ok', text: 'Brief agreed' } : { key: 'brief', state: 'fail', text: 'No brief: grill the user first' });
  steps.push(!h.gate ? { key: 'gate', state: 'off', text: 'No gate configured' }
    : !m.gate ? { key: 'gate', state: 'todo', text: 'Gate not run' }
    : m.gate !== 'pass' ? { key: 'gate', state: 'fail', text: `Gate failed vs ${m.gate_base || 'base'}` }
    : !fresh(m.gate_tree) ? { key: 'gate', state: 'todo', text: 'Gate passed on older code: rerun' }
    : { key: 'gate', state: 'ok', text: `Gate passed vs ${m.gate_base || 'base'}` });
  const r = +m.review_round || 0, of = `${r}/${h.rounds}`;
  steps.push(!h.rounds ? { key: 'review', state: 'off', text: 'Reviews off' }
    : !r ? { key: 'review', state: 'todo', text: 'Not reviewed' }
    : r >= h.rounds && (+m.review_blocking || !fresh(m.review_tree)) ? { key: 'review', state: 'warn', text: `Review rounds used up (${of}): a human decides` }
    : !fresh(m.review_tree) ? { key: 'review', state: 'todo', text: `Reviewed older code (${of}): review again` }
    : +m.review_blocking ? { key: 'review', state: 'fail', text: `${m.review_blocking} blocking (round ${of})` }
    : { key: 'review', state: 'ok', text: `Approved (round ${of})` });
  steps.push(unanswered ? { key: 'comments', state: 'fail', text: `${unanswered} comment${unanswered === 1 ? '' : 's'} unanswered` }
    : { key: 'comments', state: 'ok', text: 'Comments answered' });
  // Not enforced by release, but "review" means pushed and waiting on a human.
  steps.push(push === 'pushed' ? { key: 'push', state: 'ok', text: 'Pushed at HEAD' } : { key: 'push', state: 'todo', text: push });
  const block = steps.slice(0, 4).find(s => s.state === 'fail' || s.state === 'todo');
  return { steps, blocker: block ? block.text : null };
}

async function harness(fleet, conf, r, codeDir, repoDir) {
  const m = r.metadata || {}, branch = m.branch;
  const tree = codeDir ? await codeTree(codeDir) : branch ? await git(repoDir, 'rev-parse', '-q', '--verify', `refs/heads/${branch}^{tree}`) : '';
  let brief = false;
  try { brief = /^## Acceptance criteria/m.test(fs.readFileSync(path.join(fleet, 'briefs', `${r.external_ref}.md`), 'utf8')); } catch {}
  const unanswered = review.read(fleet, r.external_ref).filter(i => review.status(i) === 'open').length;
  // As of the last fetch: the dashboard never touches the network.
  const head = branch && await git(repoDir, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`);
  const remote = branch && await git(repoDir, 'rev-parse', '-q', '--verify', `refs/remotes/${conf.remote}/${branch}`);
  const push = !remote ? 'Not pushed' : remote === head ? 'pushed'
    : `${await git(repoDir, 'rev-list', '--count', `${remote}..${head}`) || '?'} commit(s) not pushed`;
  return { ...harnessSteps(conf, m, { brief, tree, unanswered, push }), tree };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// A record's notes as timeline entries. The engine writes "[iso] text" per note; a line
// without a timestamp continues the previous note. Notes added with `fleet note` carry no
// session, so each entry inherits the session of the claim before it.
function timeline(notes) {
  const out = [];
  for (const l of lines(notes)) {
    const m = l.match(/^\[(\d{4}-\d\d-\d\dT[\d:]+Z)\] (.*)$/);
    if (!m) { if (out.length) out[out.length - 1].text += '\n' + l; continue; }
    const text = m[2];
    const kind = /^claimed \(/.test(text) ? 'claim' : /^HANDOFF \(/.test(text) ? 'handoff' : /reclaimed from/.test(text) ? 'reclaim' : 'note';
    // Claims and reclaims name their session; other notes belong to the last one named.
    const session = kind === 'claim' || kind === 'reclaim' ? (text.match(UUID) || [])[0] : out.length ? out[out.length - 1].session : undefined;
    out.push({ at: m[1], kind, text, session });
  }
  return out;
}

// What `fleet gc` would do about each record, as the record's warning flags.
const GC_FLAG = { close: r => `${r.reason}: fleet gc --apply closes it`, pause: r => `${r.reason}: fleet gc --apply pauses it`, 'needs-you': r => r.reason };
async function records(fleet, repoDir, bases, conf, codeDirs, gcRows) {
  const out = await run('bd', ['list', '--label', 'fleet-task', '--all', '--json'], { BEADS_DIR: path.join(fleet, 'beads', '.beads') });
  let all = [];
  try { all = JSON.parse(out || '[]'); } catch {}
  // One ticket can have several records (each start-fresh closes one), so a ticket's
  // history is every record with its key, closures included, in time order.
  const history = {};
  for (const r of all) {
    const h = (history[r.external_ref] ||= []);
    h.push(...timeline(r.notes));
    if (r.status === 'closed') h.push({ at: r.closed_at, kind: 'closed', text: r.close_reason || 'closed', session: (String(r.close_reason).match(UUID) || [])[0] });
  }
  for (const h of Object.values(history)) h.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const open = await Promise.all(all.filter(r => r.status !== 'closed').map(async r => {
    const branch = r.metadata?.branch;
    const exists = branch && await git(repoDir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    const fit = exists ? await pickBase(repoDir, branch, bases) : null;
    const state = r.metadata?.state || '?';
    const flags = gcRows.filter(g => g.kind === 'record' && g.id === r.id).map(g => (GC_FLAG[g.action] || (x => x.reason))(g));
    const tl = history[r.external_ref];
    return {
      task: r.external_ref, id: r.id, title: r.title, state, branch, worker: r.metadata?.worker,
      updated: r.updated_at, flags, lastNote: lines(r.notes).slice(-1)[0] || '', notes: lines(r.notes).slice(-4),
      lastSession: tl.filter(e => e.kind === 'claim').map(e => e.session).filter(Boolean).pop(),
      timeline: tl,
      harness: await harness(fleet, conf, r, codeDirs[branch], repoDir),
      // What a review guide is written against: the worker's tree when the branch is checked out, else the branch.
      base: fit?.base, ahead: fit?.ahead, codeDir: codeDirs[branch] || null,
      mergeBase: exists ? await git(repoDir, 'merge-base', branch, fit.base) : null,
      guides: guides(fleet, r.external_ref),
    };
  }));
  // Finished tickets: newest closure per key, unless the key is open again.
  const openKeys = new Set(open.map(r => r.task)), seen = new Set();
  const closed = all.filter(r => r.status === 'closed' && !openKeys.has(r.external_ref))
    .sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))
    .filter(r => !seen.has(r.external_ref) && seen.add(r.external_ref))
    .map(r => ({
      task: r.external_ref, title: r.title, branch: r.metadata?.branch, closedAt: r.closed_at, guides: guides(fleet, r.external_ref),
      outcome: /^start-fresh/.test(r.close_reason || '') ? 'Started over' : 'Done',
      lastSession: history[r.external_ref].filter(e => e.kind === 'claim').map(e => e.session).filter(Boolean).pop(),
      timeline: history[r.external_ref],
    }));
  return { open, closed };
}

// Written by hook.js on every prompt and every agent stop.
function sessions(fleet) {
  const dir = path.join(fleet, '.fleet-view', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch {}
  return names.map(n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

// A JSONL file's entries (only its last `max` bytes), re-read only when the file changes.
const jsonlCache = new Map();
function jsonl(file, max = 1 << 20) {
  let st;
  try { st = fs.statSync(file); } catch { return { entries: [] }; }
  const hit = jsonlCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const fd = fs.openSync(file, 'r'), len = Math.min(st.size, max), buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  const entries = [];
  for (const l of buf.toString('utf8').split('\n')) { try { entries.push(JSON.parse(l)); } catch {} } // a cut first line is dropped
  const out = { mtimeMs: st.mtimeMs, size: st.size, entries };
  jsonlCache.set(file, out);
  return out;
}
const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const toolUses = e => e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content.filter(c => c.type === 'tool_use') : [];
const what = t => `${t.name} ${t.input?.file_path || t.input?.command || t.input?.pattern || t.input?.description || t.input?.url || ''}`.trim().split('\n')[0].slice(0, 140);
// SendMessage calls in a transcript: who this session or agent talked to.
const sentIn = (entries, from) => entries.flatMap(e => toolUses(e).filter(t => t.name === 'SendMessage')
  .map(t => ({ from, to: String(t.input?.to || '?'), summary: String(t.input?.summary || t.input?.message || '').split('\n')[0].slice(0, 140), at: e.timestamp })));

// A session's subagents and messages, from what Claude Code writes beside its transcript:
// <session>/subagents/agent-<id>.jsonl, and agent-<id>.meta.json (type, description, foreground or background).
// ponytail: "running" = no final reply and written in the last 2 minutes; SubagentStart/Stop hooks if that guesses wrong.
// ponytail: flat list; nested agents (spawnDepth > 1) would need their parent found by toolUseId.
function agents(transcript) {
  if (!transcript) return { agents: [], sent: [] };
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.meta.json')); } catch {}
  const list = names.map(n => {
    const id = n.slice('agent-'.length, -'.meta.json'.length), file = path.join(dir, `agent-${id}.jsonl`);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch {}
    const { mtimeMs = 0, entries } = jsonl(file, 8 << 20);
    const last = entries.findLast(e => e.type === 'assistant'), step = entries.flatMap(toolUses).pop();
    const finished = last?.message?.stop_reason === 'end_turn' && !toolUses(last).length;
    return {
      id, type: meta.agentType || 'agent', description: meta.description || '', background: meta.requestShape === 'background',
      status: finished ? 'done' : Date.now() - mtimeMs < 120000 ? 'running' : 'stopped',
      startedAt: entries[0]?.timestamp, at: mtimeMs ? new Date(mtimeMs).toISOString() : null,
      prompt: textOf(entries.find(e => e.type === 'user')?.message).slice(0, 2000),
      reply: finished ? textOf(last.message).slice(-1500) : '', doing: finished || !step ? '' : what(step),
      sent: sentIn(entries, id),
    };
  }).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 30);
  const sent = [...sentIn(jsonl(transcript).entries, 'session'), ...list.flatMap(a => a.sent)].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-20);
  for (const a of list) delete a.sent;
  return { agents: list, sent };
}

// Per-ticket review guides written by server.js: <TASK>.md after a gate pass (or on demand),
// <TASK>.review.md in depth once the ticket reaches review. The header comment says which code.
function guides(fleet, task) {
  const read = f => {
    try {
      const text = fs.readFileSync(path.join(fleet, 'scratchpad', 'overviews', f), 'utf8');
      const meta = Object.fromEntries([...(text.match(/^<!-- (.*?) -->/)?.[1] || '').matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]]));
      return { text: text.replace(/^<!-- .*? -->\n?/, ''), ...meta };
    } catch { return null; }
  };
  return { gate: read(`${task}.md`), review: read(`${task}.review.md`) };
}

async function snapshot(fleet, extraBases = []) {
  const conf = await readConf(fleet);
  const bases = [...new Set([conf.base, ...conf.extraBases, ...extraBases])];
  const [st, gc] = await Promise.all([engine(fleet, 'status', '--json'), engine(fleet, 'gc', '--json')]);
  const workers = await Promise.all(conf.workers.map(async name => {
    const dir = path.join(fleet, name);
    const o = st?.workers?.find(x => x.name === name) || { state: 'UNKNOWN' };   // UNKNOWN: the engine did not answer
    const w = {
      name, dir, state: o.state, task: o.task, session: o.session,
      leaseLeftMin: o.lease_until ? Math.round((+o.lease_until - Date.now() / 1000) / 60) : null,
      claimedAt: o.claimed_at ? new Date(+o.claimed_at * 1000).toISOString() : null,
    };
    return fs.existsSync(path.join(dir, '.git')) ? { ...w, ...(await workerChanges(dir, bases)) } : { ...w, missing: true };
  }));
  const repoDir = fs.existsSync(path.join(fleet, 'main', '.git')) ? path.join(fleet, 'main') : workers[0].dir;
  // A branch checked out in a worker may carry uncommitted work, so its code is the worker's tree.
  const codeDirs = Object.fromEntries(workers.filter(w => w.branch && w.branch !== 'HEAD').map(w => [w.branch, w.dir]));
  const { open: recs, closed } = await records(fleet, repoDir, bases, conf, codeDirs, gc?.rows || []);
  const sess = sessions(fleet);
  const jiraUrl = t => conf.jira && /^[A-Z]+-\d+$/.test(t || '') ? `${conf.jira.replace(/\/$/, '')}/browse/${t}` : null;
  for (const r of [...recs, ...closed]) r.jira = jiraUrl(r.task);
  for (const w of workers) {
    // A free worker still shows the ticket it last ran, so its session can be resumed.
    const rec = recs.find(r => r.task === w.task) || (!w.task && recs.find(r => r.worker === w.name && r.branch === w.branch));
    const sid = w.session || rec?.lastSession;
    Object.assign(w, {
      record: rec || null, ticket: w.task || rec?.task || null, jira: jiraUrl(w.task || rec?.task),
      sessionInfo: sess.find(x => x.session_id === sid) || (sid ? { session_id: sid } : null),
    });
    if (w.sessionInfo?.transcript) w.sessionInfo = { ...w.sessionInfo, ...agents(w.sessionInfo.transcript) };
    w.phase = phase(w);
  }
  return { fleet, repoDir, name: conf.name, bases, jira: conf.jira, harness: conf.harness, at: new Date().toISOString(), workers, records: recs, closed, sessions: sess.slice(0, 12), gc: gc?.rows || [] };
}

// What a person needs to know about a worker, in plain words. The engine's lock state
// (CLAIMED, DEAD, ...) stays on w.state for tooltips.
// ponytail: "busy" is the hook's last word; a session killed mid-turn reads Working until its lock goes DEAD.
const PHASE_LABEL = { working: 'Working', needs: 'Needs you', review: 'Ready for review', stuck: 'Stuck', idle: 'Idle' };
const STUCK = { DEAD: 'Its session ended (nothing uncommitted)', EXPIRED: 'Its lease ran out', LEGACY: 'Locked by hand (old protocol)',
  INTERRUPTED: 'Its session ended with uncommitted work', UNKNOWN: 'The fleet engine did not answer' };
function phase(w) {
  if (STUCK[w.state]) return { key: 'stuck', why: STUCK[w.state] };
  if (w.state !== 'CLAIMED') return { key: 'idle' };
  if (w.sessionInfo?.busy) return { key: 'working' };
  // The agent ended its turn but its background agents are still at it.
  const running = (w.sessionInfo?.agents || []).filter(a => a.status === 'running').length;
  if (running) return { key: 'working', why: `${running} agent${running === 1 ? '' : 's'} still running` };
  const h = w.record?.harness;
  if (h && !h.blocker) return { key: 'review', why: 'Passes everything release checks' };
  return { key: 'needs', why: !w.sessionInfo?.lastReply ? 'No activity from its session yet' : h?.blocker || 'The agent finished its turn' };
}

// Files touched by the fleet, grouped by file and by repo area.
// ponytail: area = the file's first 3 folders; make it configurable if a repo nests deeper.
function aggregate(snap) {
  const byFile = {}, byArea = {};
  for (const w of snap.workers) for (const f of w.files || []) {
    (byFile[f.file] ||= []).push({ worker: w.name, task: w.task, where: f.where, add: f.add, del: f.del });
    const seg = f.file.split('/');
    const area = seg.slice(0, Math.min(seg.length - 1, 3)).join('/') || '(root)';
    const a = (byArea[area] ||= { area, files: 0, add: 0, del: 0, workers: {} });
    a.files++; a.add += f.add || 0; a.del += f.del || 0;
    a.workers[w.name] = (a.workers[w.name] || 0) + 1;
  }
  const overlaps = Object.entries(byFile).filter(([, ws]) => new Set(ws.map(x => x.worker)).size > 1)
    .map(([file, ws]) => ({ file, workers: [...new Set(ws.map(x => x.worker))] }));
  return { areas: Object.values(byArea).sort((a, b) => b.files - a.files), overlaps };
}

// What moved between two snapshots, per worker and per record.
function transitions(prev, next) {
  if (!prev) return [];
  const out = [];
  const ph = w => w.phase?.key || 'idle';
  const key = w => `${ph(w)}|${w.task || '-'}|${w.branch || '-'}|${w.dirty || 0}|${w.head || '-'}`;
  for (const w of next.workers) {
    const p = prev.workers.find(x => x.name === w.name);
    if (!p || key(p) === key(w)) continue;
    const bits = [];
    if (ph(p) !== ph(w)) bits.push(`${PHASE_LABEL[ph(p)]} → ${PHASE_LABEL[ph(w)]}`);
    if (p.task !== w.task) bits.push(w.task ? `took ${w.task}` : `let go of ${p.task}`);
    if (p.head !== w.head) bits.push(`new commit ${w.head}`);
    if (p.dirty !== w.dirty) bits.push(`${w.dirty || 0} uncommitted`);
    out.push({ worker: w.name, text: bits.join(', ') || 'branch changed' });
  }
  for (const r of next.records) {
    const p = prev.records.find(x => x.task === r.task);
    if (!p) out.push({ worker: r.task, text: `started (${r.state})` });
    else if (p.state !== r.state) out.push({ worker: r.task, text: `${p.state} → ${r.state}` });
  }
  for (const p of prev.records) if (!next.records.find(r => r.task === p.task)) out.push({ worker: p.task, text: 'finished' });
  return out;
}

module.exports = { findFleetDir, snapshot, aggregate, transitions, harnessSteps, phase, agents };

// Self-check: `node gather.js [fleet-dir]`
if (require.main === module) {
  const assert = require('assert');
  const fleet = process.argv[2] || findFleetDir(process.cwd());
  assert(fleet, 'no fleet.conf above cwd');
  snapshot(fleet).then(s => {
    assert(s.workers.length > 0, 'no workers');
    for (const w of s.workers) assert(['FREE', 'CLAIMED', 'EXPIRED', 'DEAD', 'INTERRUPTED', 'LEGACY'].includes(w.state), w.state);
    const agg = aggregate(s);
    const later = JSON.parse(JSON.stringify(s));
    later.workers[0].phase = { key: later.workers[0].phase.key === 'idle' ? 'working' : 'idle' };
    later.records.pop();
    const t = transitions(s, later);
    assert(t.some(x => x.worker === s.workers[0].name), 'worker transition missed');
    if (s.records.length) assert(t.some(x => x.text === 'finished'), 'closed record missed');
    // Phases: stuck beats everything, busy is Working, a passing harness is Ready for review.
    const ready = { harness: { blocker: null } }, blocked = { harness: { blocker: 'Gate not run' } };
    assert.strictEqual(phase({ state: 'DEAD', sessionInfo: { busy: true } }).key, 'stuck');
    assert.strictEqual(phase({ state: 'FREE' }).key, 'idle');
    assert.strictEqual(phase({ state: 'CLAIMED', sessionInfo: { busy: true }, record: ready }).key, 'working');
    assert.strictEqual(phase({ state: 'CLAIMED', sessionInfo: { lastReply: 'x' }, record: ready }).key, 'review');
    assert.deepStrictEqual(phase({ state: 'CLAIMED', sessionInfo: { lastReply: 'x' }, record: blocked }), { key: 'needs', why: 'Gate not run' });
    assert.strictEqual(phase({ state: 'CLAIMED' }).why, 'No activity from its session yet');
    assert.strictEqual(phase({ state: 'CLAIMED', sessionInfo: { lastReply: 'x', agents: [{ status: 'running' }] }, record: blocked }).key, 'working');
    // Subagents: a finished one, a running one, a SendMessage from the session.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-agents-')), sub = path.join(tmp, 's', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const L = (...es) => es.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(tmp, 's.jsonl'), L({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'peer', summary: 'hi' } }] } }));
    fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'find x', requestShape: 'background' }));
    fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), L({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: 'look for x' } }, { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'found x' }] } }));
    fs.writeFileSync(path.join(sub, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'fix y' }));
    fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), L({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { content: 'fix y' } }, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'y.js' } }] } }));
    const ag = agents(path.join(tmp, 's.jsonl'));
    fs.rmSync(tmp, { recursive: true });
    assert.deepStrictEqual(ag.agents.map(a => [a.id, a.status, a.doing, a.reply]), [['a2', 'running', 'Read y.js', ''], ['a1', 'done', '', 'found x']]);
    assert.strictEqual(ag.agents[1].prompt, 'look for x');
    assert.deepStrictEqual(ag.sent.map(m => [m.from, m.to, m.summary]), [['session', 'peer', 'hi']]);
    console.log(JSON.stringify({
      workers: s.workers.map(w => [w.name, w.state, w.task, w.branch, w.base, `files=${(w.files || []).length}`]),
      records: s.records.map(r => [r.task, r.state, r.flags.join('; ')]),
      areas: agg.areas.slice(0, 5).map(a => [a.area, a.files]), overlaps: agg.overlaps, transitions: t,
    }, null, 1));
    const tl = timeline('[2026-01-01T00:00:00Z] claimed (new) in worker-1 by 11111111-2222-3333-4444-555555555555\n[2026-01-01T01:00:00Z] did A\nand B\n[2026-01-01T02:00:00Z] HANDOFF (paused): next C');
    assert.deepStrictEqual(tl.map(e => e.kind), ['claim', 'note', 'handoff']);
    assert.strictEqual(tl[2].session, '11111111-2222-3333-4444-555555555555');
    assert.strictEqual(tl[1].text, 'did A\nand B');
    for (const r of s.records) assert(Array.isArray(r.timeline) && r.timeline.length, r.task + ' has no timeline');
    for (const r of s.records) assert.strictEqual(r.harness.steps.length, 5, r.task + ' harness');
    // Harness steps follow the engine's release rules.
    const conf = { harness: { brief: true, rounds: 3, gate: true } };
    const st = (m, x) => harnessSteps(conf, m, { brief: true, tree: 'T', unanswered: 0, push: 'pushed', ...x });
    assert.strictEqual(st({}, { brief: false }).blocker, 'No brief: grill the user first');
    assert.strictEqual(st({ gate: 'pass', gate_tree: 'OLD' }).blocker, 'Gate passed on older code: rerun');
    assert.strictEqual(st({ gate: 'pass', gate_tree: 'T' }).blocker, 'Not reviewed');
    assert.strictEqual(st({ gate: 'pass', gate_tree: 'T', review_round: '1', review_tree: 'T', review_blocking: '2' }).blocker, '2 blocking (round 1/3)');
    assert.strictEqual(st({ gate: 'pass', gate_tree: 'T', review_round: '3', review_tree: 'OLD', review_blocking: '1' }).steps[2].state, 'warn');
    assert.strictEqual(st({ gate: 'pass', gate_tree: 'T', review_round: '2', review_tree: 'T', review_blocking: '0' }, { unanswered: 1 }).blocker, '1 comment unanswered');
    assert.strictEqual(st({ gate: 'pass', gate_tree: 'T', review_round: '2', review_tree: 'T', review_blocking: '0' }).blocker, null);
    console.log('harness:', JSON.stringify(s.records.map(r => [r.task, r.harness.blocker || 'ready'])));
    console.log('ok');
  });
}
