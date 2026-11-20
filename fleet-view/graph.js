// The change graph of one task: what the worker changed (from a diff of the merge-base against
// its tree id), how the changed symbols call each other (from a language-server adapter that
// extension.js supplies), and which turn wrote each line (git blame over the turn snapshots
// hook.js records). Output is the graph in docs/change-graph/plan.md, section 2.4.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Extension hosts launched from the Dock don't get the shell PATH.
const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
// null when git fails or runs past `until` (the build's deadline), so a broken diff is an error and not an empty graph.
const git = (dir, args, { extra = {}, until } = {}) => new Promise(res => {
  const left = until ? until - Date.now() : 0;
  if (until && left <= 0) return res(null);
  execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 26, env: { ...env, ...extra }, timeout: left }, (err, out) => res(err ? null : out));
});

const CALL_MS = 5000, BUILD_MS = 90000, LINK_LOOKUPS = 40, EVENTS = 100, LATE = Symbol('late');
// ponytail: fixed exclude list; make it a fleet.conf key when someone asks.
// `glob` magic, so that `**/` also matches files at the top level.
const EXCLUDE = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'go.sum', '*.min.js', '*.map']
  .map(p => `:(exclude,glob)**/${p}`);
const KEEP = new Set(['function', 'method', 'constructor', 'class', 'interface', 'enum', 'struct', 'module', 'namespace']);
const TOP = new Set(['variable', 'constant']);   // kept at depth 0 only: top-level arrow functions
// The kinds asked for outgoing calls (plan 2.4). ponytail: top-level arrow functions (depth-0
// variables) get no edges; add TOP here once the plan says so.
const CALLS = new Set(['function', 'method', 'constructor']);
// Fixed author and date make the turn-chain commit ids the same on every build.
const FIXED = Object.fromEntries(['AUTHOR', 'COMMITTER'].flatMap(w =>
  [[`GIT_${w}_NAME`, 'bosun'], [`GIT_${w}_EMAIL`, 'bosun@localhost'], [`GIT_${w}_DATE`, '@0 +0000']]));

// A -U0 diff per file: status, binary, and its hunks (1-based; a pure deletion has nc 0 at the line before it).
// ponytail: a path git quotes (tab, newline, `"` or `\` in it) is read with its quotes; unquote it if that ever bites.
function parseDiff(text) {
  const files = {};
  let cur = null, m;
  for (const l of String(text).split('\n')) {
    if (l.startsWith('diff --git ')) {
      const s = l.slice(11);   // "a/<p> b/<p>": the same path twice, as renames are off
      cur = files[s.slice(2, 2 + (s.length - 5) / 2)] = { status: 'modified', binary: false, hunks: [] };
    } else if (!cur) continue;
    else if (l.startsWith('new file mode')) cur.status = 'added';
    else if (l.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (l.startsWith('Binary files ')) cur.binary = true;
    else if ((m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)))
      cur.hunks.push({ os: +m[1], oc: m[2] == null ? 1 : +m[2], ns: +m[3], nc: m[4] == null ? 1 : +m[4] });
  }
  return files;
}
const parseHunks = text => Object.fromEntries(Object.entries(parseDiff(text)).map(([f, d]) => [f, d.hunks]));

// hook.js appends one line per prompt and per stop. Sorted by time; a broken line is skipped.
function readTurns(fleet, task) {
  let text = '';
  if (path.basename(String(task)) === task)
    try { text = fs.readFileSync(path.join(fleet, '.fleet-view', 'turns', `${task}.jsonl`), 'utf8'); } catch {}
  const out = [];
  for (const l of text.split('\n')) {
    try {
      const e = JSON.parse(l);
      if ((e.event === 'prompt' || e.event === 'stop') && /^[0-9a-f]{40,64}$/.test(e.tree))
        out.push({ at: String(e.at || ''), event: e.event, session: e.session, tree: e.tree, prompt: e.prompt });
    } catch {}
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// Connected components of 2 or more nodes, each in topological order (Kahn). `ids` come in file and
// line order, and that order breaks ties and cycles. Largest chain first.
function chains(ids, edges) {
  const at = new Map(ids.map((id, i) => [id, i]));
  const es = edges.filter(e => at.has(e.from) && at.has(e.to) && e.from !== e.to);
  const root = ids.map((_, i) => i);
  const find = i => (root[i] === i ? i : (root[i] = find(root[i])));
  for (const e of es) root[find(at.get(e.from))] = find(at.get(e.to));
  const groups = new Map();
  ids.forEach((id, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); });
  // ponytail: O(n²) per chain; fine at the 60-symbol cap.
  const order = group => {
    const left = new Set(group), out = [];
    const indeg = id => es.filter(e => e.to === id && left.has(e.from)).length;
    while (left.size) {
      // The first node with no caller left, or on a cycle the first node in file and line order.
      const next = group.find(id => left.has(id) && !indeg(id)) || group.find(id => left.has(id));
      left.delete(next);
      out.push(next);
    }
    return out;
  };
  return [...groups.values()].filter(g => g.length > 1).map(order)
    .sort((a, b) => b.length - a.length || at.get(a[0]) - at.get(b[0]));
}

// Flattened symbols with names qualified by what contains them ("Cart.total"), and the kept ones.
function qualify(syms) {
  const out = [], stack = [], seen = new Set();
  const sorted = syms.filter(s => s && s.name != null && +s.line > 0)
    .map(s => ({ s, kind: String(s.kind).toLowerCase(), line: +s.line, endLine: Math.max(+s.endLine || 0, +s.line), depth: +s.depth || 0 }))
    .sort((a, b) => a.line - b.line || b.endLine - a.endLine || a.depth - b.depth);
  for (const x of sorted) {
    while (stack.length && (stack.at(-1).depth >= x.depth || stack.at(-1).endLine < x.endLine)) stack.pop();
    x.name = stack.length ? `${stack.at(-1).name}.${x.s.name}` : String(x.s.name);
    if (seen.has(x.name)) x.name += `:${x.line}`;   // overloads, get/set pairs: one id each
    seen.add(x.name);
    stack.push(x);
    if (KEEP.has(x.kind) || (TOP.has(x.kind) && x.depth === 0)) out.push(x);
  }
  return out;
}
// The innermost kept symbol holding a line, or undefined.
const owner = (kept, line) => kept.filter(x => x.line <= line && line <= x.endLine)
  .sort((a, b) => b.depth - a.depth || (a.endLine - a.line) - (b.endLine - b.line))[0];

// The turn history as commits: base, then the tree at each prompt (labelled null) and at each stop
// (labelled with its turn), then the current tree (labelled with the turn still running, else null).
async function turnChain(dir, base, tree, events, until) {
  const turns = [], steps = [];
  let n = 0, open = false;
  for (const e of events) {
    if (e.event === 'prompt') { turns.push({ n: ++n, at: e.at, session: e.session, prompt: String(e.prompt || '').slice(0, 300) }); open = true; steps.push([e.tree, null]); }
    else { steps.push([e.tree, open ? n : null]); open = false; }
  }
  const label = {};
  if (!events.length) return { turns, head: null, label };
  let head = base, headTree = (await git(dir, ['rev-parse', `${base}^{tree}`], { until }) || '').trim();
  for (const [t, l] of [...steps.slice(-EVENTS), [tree, open ? n : null]]) {
    if (t === headTree) continue;
    const c = await git(dir, ['commit-tree', '--no-gpg-sign', t, '-p', head, '-m', `turn ${l ?? 'none'}`], { extra: FIXED, until });
    if (!c) continue;   // the tree is gone (git gc), or out of time: its lines go to the next step
    head = c.trim(); headTree = t; label[head] = l;
  }
  return { turns, head: headTree === tree ? head : null, label };
}

// Which chain commit wrote each new-side line of the hunks: line -> turn or null.
async function blame(dir, head, label, file, hunks, until) {
  const ranges = hunks.filter(h => h.nc).flatMap(h => ['-L', `${h.ns},+${h.nc}`]);
  const by = new Map();
  if (!head || !ranges.length) return by;
  const out = await git(dir, ['blame', '--porcelain', ...ranges, head, '--', file], { until }) || '';
  for (const m of out.matchAll(/^([0-9a-f]{40,64}) \d+ (\d+)/gm)) by.set(+m[2], label[m[1]] ?? null);
  return by;
}

const span = labels => {
  const ts = labels.filter(t => t != null);
  return ts.length ? { turn: Math.max(...ts), firstTurn: Math.min(...ts) } : { turn: null, firstTurn: null };
};
// ponytail: read from disk, not the tree, like the symbols; can skew if the worker edited after the snapshot.
const lineCount = abs => { try { return fs.readFileSync(abs, 'utf8').split('\n').length - 1 || 1; } catch { return 1; } };
const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id);   // a file id is a prefix of its symbols' ids, so it sorts first

async function build({ fleet, task, dir, base, tree, lsp, max = 60 }) {
  const deadline = Date.now() + BUILD_MS;
  let truncated = false;
  // One language-server call: its result, or null when it fails, hangs past 5 s or the build is out of time.
  const ask = async fn => {
    const left = deadline - Date.now();
    if (left <= 0) { truncated = true; return null; }
    let timer;
    const late = new Promise(res => { timer = setTimeout(() => res(LATE), Math.min(CALL_MS, left)); });
    const r = await Promise.race([Promise.resolve().then(fn).catch(() => null), late]);
    clearTimeout(timer);
    if (r === LATE) { if (left < CALL_MS) truncated = true; return null; }
    return r;
  };

  const diff = await git(dir, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff',
    '--src-prefix=a/', '--dst-prefix=b/', base, tree, '--', ...EXCLUDE], { until: deadline });
  if (diff == null) throw new Error(`git diff ${base} ${tree} failed in ${dir}`);
  const files = parseDiff(diff);
  // A mode-only change has no lines to show.
  const names = Object.keys(files).filter(f => files[f].hunks.length || files[f].binary || files[f].status !== 'modified').sort();
  const { turns, head, label } = await turnChain(dir, base, tree, readTurns(fleet, task), deadline);

  // Per file: who wrote each line, and the kept symbols (none for deleted and binary files).
  const live = names.filter(f => files[f].status !== 'deleted' && !files[f].binary);
  const lspStat = { files: live.length, withSymbols: 0 };
  const info = Object.fromEntries(await Promise.all(names.map(async f => {
    const d = files[f], abs = path.join(dir, f);
    const syms = live.includes(f) ? await ask(() => lsp.symbols(abs)) : null;
    if (Array.isArray(syms) && syms.length) lspStat.withSymbols++;
    return [f, { ...d, abs, kept: Array.isArray(syms) ? qualify(syms) : [], who: await blame(dir, head, label, f, d.hunks, deadline) }];
  })));

  // Each changed line counts toward its innermost kept symbol, else toward the file. Deleted lines
  // count where their hunk starts on the new side.
  const nodes = [], fileNodes = [];
  for (const f of names) {
    const d = info[f], parts = new Map(), fresh = new Set();
    const part = x => { if (!parts.has(x)) parts.set(x, { add: 0, del: 0, labels: [] }); return parts.get(x); };
    for (const h of d.hunks) {
      for (let l = h.ns; l < h.ns + h.nc; l++) { fresh.add(l); const p = part(owner(d.kept, l) || 'file'); p.add++; p.labels.push(d.who.get(l) ?? null); }
      if (h.oc) part(owner(d.kept, h.ns) || 'file').del += h.oc;
    }
    const all = [...parts.values()], sum = k => all.reduce((n, p) => n + p[k], 0);
    const fileNode = (labels, add, del) => ({ id: f, file: f, name: f, kind: 'file', line: 1, endLine: d.status === 'deleted' ? 1 : lineCount(d.abs),
      status: d.status, add: d.binary ? null : add, del: d.binary ? null : del, ...span(labels) });
    fileNodes.push(fileNode(all.flatMap(p => p.labels), sum('add'), sum('del')));
    if (d.binary || d.status === 'deleted' || !d.kept.length) { nodes.push(fileNodes.at(-1)); continue; }
    for (const [x, p] of parts) {
      if (x === 'file') { nodes.push(fileNode(p.labels, p.add, p.del)); continue; }
      nodes.push({ id: `${f}#${x.name}`, file: f, name: x.name, kind: x.kind, line: x.line, endLine: x.endLine,
        // Added: every line of the symbol is new, its inner symbols' lines included.
        status: Array.from({ length: x.endLine - x.line + 1 }, (_, i) => x.line + i).every(l => fresh.has(l)) ? 'added' : 'modified', add: p.add, del: p.del, ...span(p.labels), sym: x });
    }
  }
  const changed = nodes.filter(n => n.sym);
  if (changed.length > max) truncated = true;

  // Where a call target lands: a changed node, or an unchanged symbol inside the worker, or nowhere.
  const roots = [dir, fs.realpathSync(dir)];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const land = t => {
    if (!t || t.file == null) return null;
    const rel = roots.map(r => path.relative(r, path.resolve(dir, String(t.file)))).find(r => r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
    if (rel == null || rel.split(path.sep).includes('node_modules')) return null;
    const file = rel.split(path.sep).join('/'), x = info[file] && owner(info[file].kept, +t.selLine || +t.line);
    const id = `${file}#${x ? x.name : t.name}`;
    if (byId.get(id)?.sym) return { id };
    return { id, target: t, node: { id, file, name: x ? x.name : String(t.name), kind: x ? x.kind : String(t.kind).toLowerCase(),
      line: x ? x.line : +t.line || 1, endLine: x ? x.endLine : +t.endLine || +t.line || 1, status: 'context', add: 0, del: 0, turn: null, firstTurn: null } };
  };
  const edges = new Map(), link = (from, to) => from !== to && edges.set(`${from}\0${to}`, { from, to });
  const outgoing = async (abs, s) => { const r = await ask(() => lsp.outgoing(abs, s)); return (Array.isArray(r) ? r : []).map(land).filter(Boolean); };

  const asked = await Promise.all(changed.filter(n => CALLS.has(n.kind)).map(async n => [n.id, await outgoing(info[n.file].abs, n.sym.s)]));
  const candidates = new Map();
  for (const [from, targets] of asked) for (const t of targets) {
    if (!t.node) { link(from, t.id); continue; }
    if (!candidates.has(t.id)) candidates.set(t.id, { ...t, callers: new Set() });
    candidates.get(t.id).callers.add(from);
  }
  // One more hop from unchanged targets: one that reaches a different changed node is a linking node.
  if (!truncated) {
    const pick = [...candidates.values()].sort((a, b) => byPlace(a.node, b.node)).slice(0, LINK_LOOKUPS);
    for (const [c, reached] of await Promise.all(pick.map(async c => [c, (await outgoing(path.resolve(dir, String(c.target.file)), c.target)).filter(t => !t.node).map(t => t.id)]))) {
      if (![...c.callers].some(a => reached.some(b => b !== a))) continue;
      nodes.push(c.node);
      for (const a of c.callers) link(a, c.id);
      for (const b of reached) link(c.id, b);
    }
  }

  // Over the cap: whole files, and the calls between them.
  let out = nodes, es = [...edges.values()];
  if (changed.length > max) {
    out = fileNodes;
    const fileOf = id => byId.get(id).file;   // no context ids here: the linking hop is skipped when truncated
    es = [...new Map(es.map(e => [fileOf(e.from), fileOf(e.to)]).filter(([a, b]) => a !== b).map(([from, to]) => [`${from}\0${to}`, { from, to }])).values()];
  }
  if (Date.now() >= deadline) truncated = true;   // a git step ran out of time
  out = out.map(({ sym, ...n }) => n).sort(byPlace);
  es.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    v: 1, task, tree, base, builtAt: new Date().toISOString(), lsp: lspStat, truncated, turns,
    nodes: out, edges: es, chains: chains(out.map(n => n.id), es),
  };
}

module.exports = { build, parseHunks, readTurns, chains };

// Self-check: `node graph.js`. A temp repo where f calls g and g calls h; turn 1 edits f, turn 2 edits h.
if (require.main === module) {
  const assert = require('assert');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'graph-'));
  const repo = path.join(tmp, 'worker-1'), fleet = path.join(tmp, 'fleet'), idx = path.join(tmp, 'index');
  const sh = (args, extra = {}) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...extra } }).toString().trim();
  const put = (f, text) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); };
  const edit = (f, from, to) => put(f, fs.readFileSync(path.join(repo, f), 'utf8').replace(from, to));
  // The worker's code as a tree id, untracked files included (what codeTree() in gather.js does).
  const snap = () => { fs.rmSync(idx, { force: true }); sh(['add', '-A'], { GIT_INDEX_FILE: idx }); return sh(['write-tree'], { GIT_INDEX_FILE: idx }); };
  const turnsFile = path.join(fleet, '.fleet-view', 'turns', 'T-1.jsonl');
  fs.mkdirSync(path.dirname(turnsFile), { recursive: true });
  let clock = 0;
  const event = (ev, prompt) => fs.appendFileSync(turnsFile, JSON.stringify({ at: `2026-01-01T00:00:0${clock++}Z`, event: ev, session: 'S', worker: 'worker-1', task: 'T-1', tree: snap(), ...(prompt ? { prompt } : {}) }) + '\n');

  fs.mkdirSync(repo, { recursive: true });
  sh(['init', '-q']);
  put('a.js', 'function f() {\n  return g();\n}\n\nfunction g() {\n  return h();\n}\n\nfunction k() {\n  return 1;\n}\n');
  put('b.js', 'function h() {\n  return 2;\n}\n');
  put('package-lock.json', '{}\n');
  sh(['add', '-A']);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  const base = sh(['rev-parse', 'HEAD']);
  event('prompt', 'edit f');
  edit('a.js', '  return g();', '  const v = g();\n  return v + 1;');
  event('stop');
  edit('a.js', 'return 1;', 'return 10;');   // between turns
  event('prompt', 'edit h');
  edit('b.js', 'return 2;', 'return 3;');
  put('package-lock.json', '{"lockfileVersion": 3}\n');
  put('notes.txt', 'untracked\n');
  put('logo.bin', '\0\x01\x02');
  put('cart.js', 'class Cart {\n  total() {\n    return 1;\n  }\n}\n');
  event('stop');

  // Stub language server: `function x()` up to the next `}` line, and a fixed call map.
  const symbols = abs => {
    const out = [];
    fs.readFileSync(abs, 'utf8').split('\n').forEach((l, i) => {
      const m = l.match(/^function (\w+)\(/);
      if (m) out.push({ name: m[1], kind: 'function', line: i + 1, selLine: i + 1, selChar: 9, depth: 0 });
      else if (l === '}' && out.length && !out.at(-1).endLine) out.at(-1).endLine = i + 1;
    });
    return out;
  };
  const def = n => ['a.js', 'b.js'].map(f => symbols(path.join(repo, f)).filter(s => s.name === n).map(s => ({ file: path.join(repo, f), ...s }))).flat()[0];
  const foreign = [{ file: path.join(repo, 'node_modules', 'lib', 'x.js'), name: 'x', kind: 'function', line: 1, endLine: 3, selLine: 1, selChar: 9 },
    { file: path.join(tmp, 'elsewhere.js'), name: 'y', kind: 'function', line: 1, endLine: 3, selLine: 1, selChar: 9 }];
  const calls = { f: () => [def('g'), ...foreign], g: () => [def('h')] };
  const cart = [{ name: 'Cart', kind: 'Class', line: 1, endLine: 5, selLine: 1, selChar: 6, depth: 0 }, { name: 'total', kind: 'Method', line: 2, endLine: 4, selLine: 2, selChar: 2, depth: 1 }];
  const lsp = { symbols: async abs => (abs.endsWith('cart.js') ? cart : symbols(abs)), outgoing: async (abs, s) => (calls[s.name] || (() => []))() };
  const args = { fleet, task: 'T-1', dir: repo, base, tree: snap(), lsp };

  const hunks = parseHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2 +2,2 @@\n-a\n+b\n+c\n@@ -9,2 +9,0 @@\n-d\n-e\n');
  assert.deepStrictEqual(hunks, { x: [{ os: 2, oc: 1, ns: 2, nc: 2 }, { os: 9, oc: 2, ns: 9, nc: 0 }] });
  assert.deepStrictEqual(chains(['a', 'b', 'c', 'd', 'e'], [{ from: 'c', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'b' }, { from: 'd', to: 'e' }]), [['a', 'b', 'c'], ['d', 'e']]);

  (async () => {
    const g = await build(args);
    const node = id => g.nodes.find(n => n.id === id);
    const pick = (id, ...ks) => ks.map(k => node(id)?.[k]);
    assert.deepStrictEqual(g.nodes.map(n => n.id), ['a.js#f', 'a.js#g', 'a.js#k', 'b.js#h', 'cart.js#Cart', 'cart.js#Cart.total', 'logo.bin', 'notes.txt']);
    // A new class is added as a whole, though its method owns lines 2-4.
    assert.deepStrictEqual([pick('cart.js#Cart', 'kind', 'status', 'add'), pick('cart.js#Cart.total', 'kind', 'status', 'add', 'turn')], [['class', 'added', 2], ['method', 'added', 3, 2]]);
    assert.deepStrictEqual(pick('a.js#f', 'status', 'add', 'del', 'turn', 'firstTurn', 'line', 'endLine'), ['modified', 2, 1, 1, 1, 1, 4]);
    assert.deepStrictEqual(pick('b.js#h', 'status', 'add', 'del', 'turn', 'firstTurn'), ['modified', 1, 1, 2, 2]);
    assert.deepStrictEqual(pick('a.js#g', 'status', 'add', 'del', 'turn'), ['context', 0, 0, null]);
    assert.deepStrictEqual(pick('a.js#k', 'status', 'turn', 'firstTurn'), ['modified', null, null]);   // edited between turns
    assert.deepStrictEqual(pick('logo.bin', 'kind', 'status', 'add', 'del'), ['file', 'added', null, null]);
    assert.deepStrictEqual(pick('notes.txt', 'kind', 'status', 'add', 'del', 'turn'), ['file', 'added', 1, 0, 2]);
    assert.deepStrictEqual(g.edges, [{ from: 'a.js#f', to: 'a.js#g' }, { from: 'a.js#g', to: 'b.js#h' }]);
    assert.deepStrictEqual(g.chains, [['a.js#f', 'a.js#g', 'b.js#h']]);
    assert.deepStrictEqual(g.turns.map(t => [t.n, t.prompt]), [[1, 'edit f'], [2, 'edit h']]);
    assert.deepStrictEqual([g.lsp, g.truncated], [{ files: 4, withSymbols: 3 }, false]);
    // The same input gives the same JSON, apart from builtAt.
    const same = x => JSON.stringify({ ...x, builtAt: '' });
    assert.strictEqual(same(await build(args)), same(g));
    // Over the cap: whole files only.
    const t = await build({ ...args, max: 1 });
    assert.deepStrictEqual([t.truncated, t.nodes.map(n => [n.id, n.kind, n.add, n.del]), t.edges], [true, [['a.js', 'file', 3, 2], ['b.js', 'file', 1, 1], ['cart.js', 'file', 5, 0], ['logo.bin', 'file', null, null], ['notes.txt', 'file', 1, 0]], []]);
    // A language server that never answers: each call gives up after 5 s, and every file is a file node.
    const hung = await build({ ...args, lsp: { symbols: () => new Promise(() => {}), outgoing: lsp.outgoing } });
    assert.deepStrictEqual([hung.nodes.map(n => n.kind), hung.lsp.withSymbols], [['file', 'file', 'file', 'file', 'file'], 0]);
    // A turn still running owns the current tree.
    event('prompt', 'edit k');
    edit('a.js', 'return 10;', 'return 11;');
    const r = await build({ ...args, tree: snap() });
    assert.deepStrictEqual([r.nodes.find(n => n.id === 'a.js#k').turn, r.turns.length], [3, 3]);
    fs.rmSync(tmp, { recursive: true });
    console.log('ok');
  })().catch(e => { console.error(e); process.exit(1); });
}
