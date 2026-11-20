// Fleet View: a thin VS Code host for server.js. The server owns state and keeps running
// when VS Code or the tab closes; this file starts one per fleet if needed, shows ui.html in
// the Explorer view and an editor tab per fleet, and routes clicks into VS Code (sessions,
// diffs, files). A window sees the fleet it is inside and the fleets under its folders, never
// one beside or above them.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { findFleetDir } = require('./gather');
const review = require('./review');
const graph = require('./graph');

const LABEL = { working: 'Working', needs: 'Needs you', review: 'Ready for review', stuck: 'Stuck', idle: 'Idle' };
const title = w => w.record?.title || w.ticket || w.name;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function activate(ctx) {
  const cfg = () => vscode.workspace.getConfiguration('fleetView');
  const log = vscode.window.createOutputChannel('Fleet View', { log: true });
  ctx.subscriptions.push(log);
  let author = 'reviewer';
  execFile('git', ['config', 'user.name'], (e, out) => { if (out && out.trim()) author = out.trim(); });

  // --- which fleets this window can see
  function discover() {
    const out = new Set();
    if (cfg().get('dir')) out.add(path.resolve(cfg().get('dir')));
    for (const f of vscode.workspace.workspaceFolders || []) {
      const root = f.uri.fsPath, up = findFleetDir(root);
      if (up) out.add(up); // the window is inside a fleet (a worker, main/, or the fleet folder)
      const walk = (dir, depth) => {
        if (fs.existsSync(path.join(dir, 'fleet.conf'))) return out.add(dir);
        if (!depth || fs.existsSync(path.join(dir, '.git'))) return; // fleets hold repos; they are not inside one
        let ds = [];
        try { ds = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
        for (const d of ds) if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') walk(path.join(dir, d.name), depth - 1);
      };
      walk(root, 3);
    }
    return [...out];
  }

  const fleets = [];
  const byDir = dir => fleets.find(F => F.dir === dir);
  const many = () => fleets.length > 1;

  // --- one fleet: its server, live state, status bar item, dashboard tab and gutter threads
  function makeFleet(dir) {
    const home = path.join(dir, '.fleet-view');
    fs.mkdirSync(home, { recursive: true });
    const F = { dir, name: path.basename(dir).replace(/-fleet$/, ''), state: null, panel: null, seen: null, workingSince: {}, threads: new Map(), sig: '' };
    F.token = () => { try { return fs.readFileSync(path.join(home, 'token'), 'utf8').trim(); } catch { return ''; } };
    F.port = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')).port; } catch { return null; } };
    F.base = () => `http://127.0.0.1:${F.port()}`;
    const ping = port => new Promise(res => http.get(`http://127.0.0.1:${port}/api/ping?token=${F.token()}`, r => {
      let b = ''; r.on('data', d => (b += d)); r.on('end', () => { try { res(JSON.parse(b).fleet === dir); } catch { res(false); } });
    }).on('error', () => res(false)));
    F.ensure = async () => {
      if (F.port() && await ping(F.port())) return true;
      // Detached, so it outlives this window. The first fleet asks for the configured port; the
      // server takes a free one if that is busy and records it in server.json.
      const log = fs.openSync(path.join(home, 'server.log'), 'a');
      spawn(process.execPath, [path.join(__dirname, 'server.js'), dir, String(fleets[0] === F ? cfg().get('port') : 0)], {
        detached: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }).unref();
      for (let i = 0; i < 40; i++) { await sleep(250); if (F.port() && await ping(F.port())) return true; }
      vscode.window.showErrorMessage(`Fleet View: the ${F.name} server did not start. See ${home}/server.log`);
      return false;
    };
    F.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    F.status.command = { command: 'fleetView.open', title: 'Open', arguments: [dir] };
    ctx.subscriptions.push(F.status);

    let stream;
    const subscribe = () => {
      stream = http.get(`${F.base()}/events?token=${F.token()}`, res => {
        let buf = '';
        res.on('data', d => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            if (chunk.startsWith('data: ')) { try { onState(F, JSON.parse(chunk.slice(6))); } catch {} }
          }
        });
        res.on('end', () => setTimeout(() => F.ensure().then(subscribe), 3000));
      }).on('error', () => setTimeout(() => F.ensure().then(subscribe), 3000));
    };
    ctx.subscriptions.push({ dispose: () => stream && stream.destroy() });
    fleets.push(F);
    F.ensure().then(ok => ok && subscribe());
    return F;
  }

  function onState(F, s) {
    if (!s.snap) return;
    F.state = s;
    const ws = s.snap.workers, n = k => ws.filter(w => w.phase?.key === k).length;
    F.status.text = `$(server-process)${many() ? ' ' + F.name : ''} ${ws.length - n('idle')}/${ws.length}${n('working') ? ` $(loading~spin) ${n('working')}` : ''}${n('needs') ? ` $(bell-dot) ${n('needs')}` : ''}`
      + `${n('review') ? ` $(check) ${n('review')}` : ''}${n('stuck') ? ` $(warning) ${n('stuck')}` : ''}`;
    F.status.tooltip = `${s.snap.name} fleet\n` + ws.map(w => `${w.name}: ${LABEL[w.phase?.key] || w.state}${w.ticket ? ' · ' + title(w) : ''}`).join('\n');
    F.status.show();
    renderThreads(F);
    notify(F, s);
  }

  // Tap the user on the shoulder when a worker needs them, instead of making them watch the page.
  // ponytail: every open window gets the stream, so only the focused one speaks; no cross-window dedupe.
  function notify(F, s) {
    const now = { phase: Object.fromEntries(s.snap.workers.map(w => [w.name, w.phase?.key])), overlaps: new Set(s.agg.overlaps.map(o => o.file)) };
    const before = F.seen;
    F.seen = now;
    for (const w of s.snap.workers) if (w.phase?.key === 'working' && before?.phase[w.name] !== 'working') F.workingSince[w.name] = Date.now();
    if (!before || !vscode.window.state.focused) return; // nothing for what was already true at startup
    const who = w => `${many() ? F.name + ' ' : ''}${w.name}`;
    for (const w of s.snap.workers) {
      const p = w.phase?.key, sid = w.sessionInfo?.session_id;
      if (p === before.phase[w.name]) continue;
      // A quick back-and-forth in a session you are typing into should not ping you every turn.
      if (p === 'needs' && before.phase[w.name] === 'working' && Date.now() - (F.workingSince[w.name] || 0) < 90e3) continue;
      const msg = p === 'needs' ? `${who(w)} needs you: ${title(w)}${w.phase.why ? ` (${w.phase.why})` : ''}`
        : p === 'review' ? `${who(w)} is ready for review: ${title(w)}`
        : p === 'stuck' ? `${who(w)} is stuck: ${w.phase.why}. ${title(w)}` : null;
      if (!msg) continue;
      const buttons = p === 'review' ? ['Review changes'] : sid ? ['Open session', 'Show'] : ['Show'];
      (p === 'stuck' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(msg, ...buttons).then(b => {
        if (b === 'Open session') resume(F, sid, w.sessionInfo.cwd);
        else if (b) openPanel(F, w.name);
      });
    }
    for (const o of s.agg.overlaps) if (!before.overlaps.has(o.file))
      vscode.window.showWarningMessage(`${many() ? F.name + ': ' : ''}${path.basename(o.file)} is now changed in ${o.workers.join(' and ')}. Expect a merge conflict.`, 'Show')
        .then(b => b && openPanel(F, o.workers[o.workers.length - 1]));
  }

  // --- gutter review comments (VS Code Comments API), mirrored from the review .md and drafts
  const comments = vscode.comments.createCommentController('fleetView.review', 'Fleet review');
  ctx.subscriptions.push(comments);
  const workerOf = p => {
    for (const F of fleets) for (const w of F.state?.snap.workers || []) if (p.startsWith(w.dir + path.sep)) return { F, w };
    return {};
  };
  comments.commentingRangeProvider = {
    provideCommentingRanges: doc => doc.uri.scheme === 'file' && workerOf(doc.uri.fsPath).w?.ticket ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [],
  };
  // Status colour, shown in the Comments panel and on the thread: none for a draft, red while the
  // agent owes an answer, yellow once it answered, green when you mark it complete.
  const DOT = { draft: '', open: '🔴 ', answered: '🟡 ', complete: '🟢 ' };
  const SAYS = { draft: 'draft, not sent', open: 'waiting on the agent', answered: 'answered, your turn', complete: 'complete' };
  const itemOf = new Map(); // thread → { F, w, index }, for Reply / Mark complete / Reopen
  function renderThreads(F) {
    const s = F.state;
    const next = JSON.stringify(s.reviews) + JSON.stringify(s.drafts || {}) + s.snap.workers.map(w => w.dir + w.ticket).join();
    if (next === F.sig) return;
    F.sig = next;
    // Update threads in place and dispose only the ones whose item is gone: disposing a thread
    // throws away a reply half-typed in it, and the agent rewrites the review file all the time.
    const old = F.threads, seen = new Map();
    F.threads = new Map();
    // Drafts show too, so a review in progress is visible where it was written.
    const items = w => [...(s.reviews[w.ticket] || []).map((it, index) => ({ ...it, index })), ...(s.drafts?.[w.ticket] || []).map(d => ({ ...d, draft: true, done: false, replies: [] }))];
    for (const w of s.snap.workers) for (const it of items(w)) {
      if (!it.file || it.file.startsWith('(') || it.file.startsWith('review guide')) continue; // guide-level notes have no line to sit on
      const line = Math.max(0, (it.line || 1) - 1), st = review.status(it);
      // The comment text never changes once written (replies go under it), so it identifies the item.
      let key = [w.dir, it.draft ? 'draft' : 'item', it.file, line, it.text].join('\0');
      seen.set(key, (seen.get(key) || 0) + 1); key += '\0' + seen.get(key);
      const body = [
        { body: new vscode.MarkdownString(it.text), mode: vscode.CommentMode.Preview, author: { name: DOT[st] + 'review' } },
        ...(it.thread || []).map(r => ({ body: new vscode.MarkdownString(r.text), mode: vscode.CommentMode.Preview, author: { name: r.who } })),
      ];
      let t = old.get(key);
      old.delete(key);
      if (t) t.comments = body;
      else t = comments.createCommentThread(vscode.Uri.file(path.join(w.dir, it.file)), new vscode.Range(line, 0, line, 0), body);
      // Only on a status change, so a thread you folded or opened stays that way.
      if (t.contextValue !== st) t.collapsibleState = st === 'complete' ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
      t.label = `${DOT[st]}${w.ticket} · ${SAYS[st]}`;
      t.contextValue = st;
      // Complete is Resolved, so the Comments panel's filter can hide or show the completed ones.
      t.state = st === 'draft' ? undefined : st === 'complete' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      t.canReply = st !== 'draft';
      itemOf.delete(t);
      if (st !== 'draft') itemOf.set(t, { F, w, index: it.index });
      F.threads.set(key, t);
    }
    old.forEach(t => { itemOf.delete(t); t.dispose(); });
  }

  // --- sessions: the Claude Code panel when the session belongs to this window, else a terminal
  const slug = p => p.replace(/[^A-Za-z0-9]/g, '-');
  function sessionHome(F, sid, cwd) {
    const projects = path.join(require('os').homedir(), '.claude', 'projects');
    let project = null;
    try { project = fs.readdirSync(projects).find(d => fs.existsSync(path.join(projects, d, `${sid}.jsonl`))); } catch {}
    const candidates = [cwd, F.dir, path.join(F.dir, 'main'), ...(F.state?.snap.workers || []).map(w => w.dir)].filter(Boolean);
    return cwd || candidates.find(c => slug(c) === project) || F.dir;
  }
  // A new Claude Code tab in this window's active editor group — the same command Claude
  // Code's own vscode://anthropic.claude-code/open?session= link runs. It finds sessions
  // across the repo's git worktrees, so fleet workers' sessions open here too.
  const openSession = (sid, prompt) => vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sid, prompt);
  // One way to open a session everywhere: the fleetView.openIn setting, ⌥-click for the other.
  function resume(F, sid, cwd, prompt, alt) {
    return (cfg().get('openIn') === 'terminal') !== !!alt ? resumeInTerminal(F, sid, cwd, prompt) : openSession(sid, prompt);
  }
  function resumeInTerminal(F, sid, cwd, prompt) {
    const t = vscode.window.createTerminal({ name: `claude ${sid.slice(0, 8)}`, cwd: sessionHome(F, sid, cwd) });
    t.show();
    t.sendText(`claude --resume ${sid}${prompt ? ' ' + JSON.stringify(prompt) : ''}`);
  }

  // --- webviews: each one shows one fleet; the sidebar can switch between them
  function html(F, webview, extra) {
    const nonce = crypto.randomBytes(12).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; img-src data: https:; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src ${F.base()}`;
    return fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8')
      .replace('__CSP__', csp).replaceAll('__NONCE__', nonce)
      .replace('__CODICONS__', webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'media', 'codicon.css'))).toString())
      .replace('__CFG__', JSON.stringify({ server: F.base(), token: F.token(), mode: 'vscode', author, openIn: cfg().get('openIn'),
        fleet: F.dir, fleets: fleets.map(x => ({ dir: x.dir, name: x.name })), ...extra }));
  }
  function attach(F, webview, extra, onSwitch) {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'media'))] };
    webview.html = html(F, webview, extra);
    // Every click is logged, and a failure shows instead of doing nothing (Output → Fleet View).
    const sub = webview.onDidReceiveMessage(async m => {
      log.info('click', JSON.stringify(m).slice(0, 400));
      try { await onMessage(m); } catch (e) {
        log.error(`${m.type} failed: ${e?.stack || e}`);
        vscode.window.showErrorMessage(`Fleet View: ${m.type}${m.file ? ' ' + m.file : ''} failed: ${e?.message || e}`);
      }
    });
    async function onMessage(m) {
      if (m.type === 'resume') resume(F, m.sid, m.cwd, m.prompt, m.alt);
      // Open a file at a line: the worker's copy, or the branch's (read-only) when no worker has it.
      if (m.type === 'open') {
        const uri = m.rev ? vscode.Uri.from({ scheme: 'fleet-git', path: '/' + m.file, query: JSON.stringify({ dir: m.dir, rev: m.rev }) }) : vscode.Uri.file(path.join(m.dir, m.file));
        const line = Math.max(0, (+m.line || 1) - 1);
        await vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(line, 0, line, 0) });
      }
      if (m.type === 'url') vscode.env.openExternal(vscode.Uri.parse(m.url));
      if (m.type === 'dashboard') openPanel(F, m.sel);
      if (m.type === 'refresh') webview.html = html(F, webview, extra);
      if (m.type === 'reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
      if (m.type === 'switch-fleet' && byDir(m.dir)) onSwitch ? onSwitch(byDir(m.dir)) : openPanel(byDir(m.dir)); // a tab per fleet; the sidebar swaps
      // Before = the merge-base; after = the worker's file on disk, where gutter comments attach,
      // or the branch itself (m.right) when no worker has it checked out.
      if (m.type === 'diff') {
        const at = rev => vscode.Uri.from({ scheme: 'fleet-git', path: '/' + m.file, query: JSON.stringify({ dir: m.dir, rev }) });
        const right = m.right ? at(m.right) : vscode.Uri.file(path.join(m.dir, m.file));
        const line = Math.max(0, (+m.line || 1) - 1);
        await vscode.commands.executeCommand('vscode.diff', at(m.rev), right, `${path.basename(m.file)} (${m.rev.slice(0, 7)} ↔ ${m.right || path.basename(m.dir)})`,
          { selection: new vscode.Range(line, 0, line, 0) });
      }
      if (m.type === 'graph') {
        // The page shows a spinner from the click until the graph is on the server.
        webview.postMessage({ type: 'cg-busy', task: m.task, on: true });
        try { await buildGraph(F, m.task, m.force); } finally { webview.postMessage({ type: 'cg-busy', task: m.task, on: false }); }
      }
    }
    return () => sub.dispose();
  }
  function openPanel(F, sel) {
    if (F.panel) { F.panel.reveal(); if (sel) F.panel.webview.postMessage({ type: 'select', sel }); return; }
    F.ensure().then(() => {
      const p = vscode.window.createWebviewPanel('fleetView.panel', many() ? `Fleet · ${F.name}` : 'Fleet', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      p.iconPath = new vscode.ThemeIcon('server-process');
      setup(F, p, sel);
    });
  }
  function setup(F, p, sel) {
    log.info('dashboard tab attached:', F.dir);
    F.panel = p;
    const detach = attach(F, p.webview, sel ? { sel } : {});
    p.onDidDispose(() => { detach(); F.panel = null; });
  }
  // Ask which fleet when there is more than one.
  async function pickFleet(placeHolder) {
    if (fleets.length < 2) return fleets[0];
    const pick = await vscode.window.showQuickPick(fleets.map(F => ({ label: `$(server-process) ${F.name}`, description: F.status.text.replace(/\$\([^)]*\)/g, '').trim(), detail: F.dir, F })), { placeHolder });
    return pick?.F;
  }

  for (const dir of discover()) makeFleet(dir);
  log.info('activated; fleets:', fleets.map(F => F.dir).join(', ') || '(none)');
  // ponytail: folders added later bring their fleets in; removing a folder leaves its fleet until reload.
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { for (const dir of discover()) if (!byDir(dir)) makeFleet(dir); }));

  const sideFleet = () => byDir(ctx.workspaceState.get('fleetView.sidebar')) || fleets[0];
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('fleet-git', {
      provideTextDocumentContent: uri => new Promise(res => {
        const { dir, rev } = JSON.parse(uri.query);
        execFile('git', ['-C', dir, 'show', `${rev}:${uri.path.slice(1)}`], { maxBuffer: 1 << 26 }, (e, out) => res(e ? '' : out));
      }),
    }),
    vscode.window.registerWebviewViewProvider('fleetView.sidebar', {
      resolveWebviewView: view => {
        if (!fleets.length) { view.webview.html = '<p style="padding:8px 12px">No fleet in this workspace. A fleet is a folder with a fleet.conf.</p>'; return; }
        let detach = () => {};
        const show = F => { detach(); ctx.workspaceState.update('fleetView.sidebar', F.dir); F.ensure().then(() => { detach = attach(F, view.webview, { compact: true }, show); }); };
        show(sideFleet());
        view.onDidDispose(() => detach());
      },
    }),
    vscode.window.registerWebviewPanelSerializer('fleetView.panel', {
      deserializeWebviewPanel: async (p, st) => { const F = byDir(st?.fleet) || fleets[0]; if (!F) return p.dispose(); await F.ensure(); setup(F, p); },
    }),
    vscode.commands.registerCommand('fleetView.open', async dir => { const F = byDir(dir) || await pickFleet('Open which fleet?'); if (F) openPanel(F); }),
    vscode.commands.registerCommand('fleetView.goTo', async () => {
      const pick = await vscode.window.showQuickPick(fleets.flatMap(F => [
        ...(many() ? [{ label: F.name, kind: vscode.QuickPickItemKind.Separator }] : []),
        { label: '$(dashboard) Overview', description: many() ? F.name : '', F, sel: 'overview' }, { label: '$(layout) Lanes', description: many() ? F.name : '', F, sel: 'lanes' },
        ...(F.state?.snap.workers || []).map(w => ({ label: title(w), description: `${w.name} · ${LABEL[w.phase?.key] || w.state}`, detail: w.phase?.why, F, sel: w.name })),
      ]), { placeHolder: 'Go to a worker', matchOnDescription: true });
      if (pick?.F) openPanel(pick.F, pick.sel);
    }),
    vscode.commands.registerCommand('fleetView.openBrowser', async () => { const F = await pickFleet('Open which fleet in the browser?'); if (F) vscode.env.openExternal(vscode.Uri.parse(`${F.base()}/`)); }),
    vscode.commands.registerCommand('fleetView.restartServer', async () => {
      for (const F of fleets) {
        try { process.kill(JSON.parse(fs.readFileSync(path.join(F.dir, '.fleet-view', 'server.json'), 'utf8')).pid); } catch {}
        await sleep(500);
        await F.ensure();
        F.panel?.webview.postMessage({ type: 'select', sel: 'overview' });
      }
    }),
    // One gutter button per intent; the tag is what Fleet View and the agent read.
    ...['inspect', 'review', 'change'].map(intent => vscode.commands.registerCommand(`fleetView.${intent}`, reply => addComment(reply, intent))),
    vscode.commands.registerCommand('fleetView.followUp', reply => {
      const at = itemOf.get(reply.thread);
      if (!at || !reply.text.trim()) return;
      send(at.F, 'followup', { worker: at.w.name, index: at.index, text: reply.text, author },
        () => review.followUp(at.F.dir, at.w.ticket, at.index, { text: reply.text, author }));
    }),
    ...[['complete', true], ['reopen', false]].map(([cmd, complete]) => vscode.commands.registerCommand(`fleetView.${cmd}`, thread => {
      const at = itemOf.get(thread);
      if (at) send(at.F, 'complete', { worker: at.w.name, index: at.index, complete, author }, () => review.setComplete(at.F.dir, at.w.ticket, at.index, complete, author));
    })),
  );
  // Through the server, so every view updates at once; straight to the file when it is down.
  // Resolves when the server has answered (or the fallback ran).
  function send(F, api, body, fallback) {
    F.sig = ''; // the server's next push re-syncs the threads (in place, so other half-typed replies survive)
    return new Promise(res => {
      const req = http.request(`${F.base()}/api/${api}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-token': F.token() } },
        r => { r.resume(); r.on('end', res); });
      req.on('error', e => { fallback(e); res(); });
      req.end(JSON.stringify(body));
    });
  }
  // --- change graph: symbols and calls come from this window's language servers, which only the
  // extension host can ask. graph.js does the rest; the server stores the result for every view.
  const at = r => ({ line: r.start.line + 1, endLine: r.end.line + 1 });
  const lsp = {
    async symbols(abs) {
      const uri = vscode.Uri.file(abs), ask = () => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
      let r = await ask();
      // A language server that has just started answers empty: one retry, then the file stays a file node.
      if (!r?.length && fs.statSync(abs).size) { await sleep(3000); r = await ask(); }
      const out = [];
      const walk = (s, depth) => {
        const range = s.range || s.location.range, sel = s.selectionRange || range;
        out.push({ name: s.name, kind: vscode.SymbolKind[s.kind], ...at(range), selLine: sel.start.line + 1, selChar: sel.start.character, depth });
        for (const c of s.children || []) walk(c, depth + 1);
      };
      for (const s of r || []) walk(s, s.children ? 0 : s.containerName ? 1 : 0); // DocumentSymbol[] or SymbolInformation[]
      return out;
    },
    async outgoing(abs, s) {
      const items = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', vscode.Uri.file(abs), new vscode.Position(s.selLine - 1, s.selChar)) || [];
      const calls = (await Promise.all(items.map(i => vscode.commands.executeCommand('vscode.provideOutgoingCalls', i)))).flat().filter(Boolean);
      return calls.map(({ to }) => ({ file: to.uri.fsPath, name: to.name, kind: vscode.SymbolKind[to.kind], ...at(to.range),
        selLine: to.selectionRange.start.line + 1, selChar: to.selectionRange.start.character }));
    },
  };
  const building = new Map(); // task → the build in flight; a second click waits on the same one
  function buildGraph(F, task, force) {
    const r = F.state?.snap.records.find(x => x.task === task), tree = r?.harness?.tree;
    if (!r?.codeDir || !r.mergeBase || !tree) return;
    if (building.has(task)) return building.get(task);
    if (!force && F.state.graphs?.[task]?.tree === tree) return;
    const t0 = Date.now();
    const job = vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Change graph: ${task}` }, async () => {
      const g = await graph.build({ fleet: F.dir, task, dir: r.codeDir, base: r.mergeBase, tree, lsp });
      log.info(`graph ${task}: ${g.nodes.filter(n => n.status !== 'context').length} symbols, ${g.chains.length} chains, ${Date.now() - t0} ms`);
      await send(F, 'graph', { ticket: task, graph: g }, e => log.error(`graph ${task}: could not reach the server: ${e.message}`));
    }).finally(() => building.delete(task));
    building.set(task, job);
    return job;
  }
  function addComment(reply, intent) {
    const { F, w } = workerOf(reply.thread.uri.fsPath);
    if (!w || !reply.text.trim()) return;
    const line = reply.thread.range ? reply.thread.range.start.line + 1 : null;
    const file = path.relative(w.dir, reply.thread.uri.fsPath).split(path.sep).join('/');
    reply.thread.dispose(); // the .md is the truth; the server's next push recreates it
    // A draft, like every comment written in Fleet View; Submit review hands them to the agent together.
    const text = `[${intent}] ${reply.text}`;
    send(F, 'draft', { worker: w.name, file, line, text, author }, () => review.addDraft(F.dir, w.ticket, { file, line, text, author }));
  }
}

module.exports = { activate, deactivate() {} };
