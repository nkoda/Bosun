#!/usr/bin/env node
// Claude Code hook (UserPromptSubmit + Stop). Records what each fleet session is doing in
// <fleet>/.fleet-view/sessions/<id>.json — the dashboard watches that folder, so it refreshes
// every time you prompt and every time the agent finishes. On UserPromptSubmit it also hands
// the agent any review comments that are new since it last saw them (stdout becomes context).
// When the session holds a worker, each event also appends the worker's exact code tree to
// <fleet>/.fleet-view/turns/<task>.jsonl, so the change graph can tell which turn wrote a line.
// Never blocks the session: every failure is swallowed and the exit code is always 0.
const fs = require('fs');
const path = require('path');
const os = require('os');
const review = require('./review');
const { codeTree } = require('./gather');

const KNOWN = path.join(os.homedir(), '.claude', 'fleet', 'fleets.json'); // written by server.js on start

function fleetsFor(cwd, sid) {
  let known = [];
  try { known = JSON.parse(fs.readFileSync(KNOWN, 'utf8')); } catch {}
  for (let d = cwd; d && d !== path.dirname(d); d = path.dirname(d))
    if (fs.existsSync(path.join(d, 'fleet.conf'))) known.push(d);
  return [...new Set(known)].filter(f => {
    if (cwd === f || cwd.startsWith(f + path.sep)) return true;
    const repo = (fs.readFileSync(path.join(f, 'fleet.conf'), 'utf8').match(/^REPO=(.*)$/m) || [])[1];
    if (repo && (cwd === repo || cwd.startsWith(repo + path.sep))) return true;
    return !!heldBy(f, sid);
  });
}

function heldBy(fleet, sid) { // -> { worker, task } the session holds, if any
  try {
    for (const w of fs.readdirSync(path.join(fleet, '.locks'))) {
      const o = fs.readFileSync(path.join(fleet, '.locks', w, 'owner'), 'utf8');
      if (o.includes(`session=${sid}\n`)) return { worker: w, task: (o.match(/^task=(.*)$/m) || [])[1] };
    }
  } catch {}
  return null;
}

// Last assistant text in the transcript (reads only the tail).
function lastReply(transcript) {
  try {
    const fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    for (const l of buf.toString('utf8').split('\n').reverse()) {
      if (!l.includes('"assistant"')) continue;
      try {
        const e = JSON.parse(l);
        const text = (e.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
        if (e.type === 'assistant' && text) return text;
      } catch {}
    }
  } catch {}
  return '';
}

async function main(input) {
  const ev = JSON.parse(input);
  const sid = ev.session_id, cwd = ev.cwd || process.cwd();
  if (!sid) return;
  let out = '';
  const snaps = []; // { fleet, held, at } for each fleet where the session holds a worker
  for (const fleet of fleetsFor(cwd, sid)) {
    const dir = path.join(fleet, '.fleet-view', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.json`);
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const held = heldBy(fleet, sid);
    s = { ...s, session_id: sid, cwd, transcript: ev.transcript_path, at: new Date().toISOString(), event: ev.hook_event_name, worker: held?.worker || null, task: held?.task || null };
    if (ev.hook_event_name === 'UserPromptSubmit') { s.lastPrompt = String(ev.prompt || '').slice(0, 600); s.busy = true; }
    if (ev.hook_event_name === 'Stop') { s.lastReply = lastReply(ev.transcript_path).slice(0, 1200); s.busy = false; }

    if (ev.hook_event_name === 'UserPromptSubmit' && held?.task) {
      const open = review.read(fleet, held.task).filter(i => !i.done);
      const sig = JSON.stringify(open.map(i => [i.file, i.line, i.text, i.thread.length]));
      if (open.length && sig !== s.reviewSig) {
        out += `\n[Fleet review] ${open.length} open review comment(s) on ${held.task} from the user, in ${review.reviewFile(fleet, held.task)}:\n` +
          open.map(i => `- ${i.file}${i.line ? ':' + i.line : ''}: ${i.text.replace(/\n/g, ' ')}${i.thread.at(-1)?.who === 'you' ? ` (follow-up: ${i.thread.at(-1).text})` : ''}`).join('\n') +
          `\nAddress them (or say why not): a comment tagged [inspect] wants an explanation and no code change, [review] wants you to check for problems and report, [change] wants the change made. Then in that file change "- [ ]" to "- [x]" and add an indented "> what you did" line under each (for a follow-up, under its ">> " line).\n`;
      }
      s.reviewSig = sig;
    }
    fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 1));
    fs.renameSync(file + '.tmp', file);
    if (held?.task) snaps.push({ fleet, held, at: s.at });
  }
  if (out) process.stdout.write(out);

  // Only now, with every session file written and the comments handed over: if the hook
  // timeout kills a snapshot, only its turn line is lost.
  const kind = { UserPromptSubmit: 'prompt', Stop: 'stop' }[ev.hook_event_name];
  for (const { fleet, held, at } of kind ? snaps : []) try {
    const tree = await codeTree(path.join(fleet, held.worker));
    if (!tree) continue;
    const turn = { at, event: kind, session: sid, worker: held.worker, task: held.task, tree };
    if (kind === 'prompt') turn.prompt = String(ev.prompt || '').slice(0, 300);
    const turns = path.join(fleet, '.fleet-view', 'turns');
    fs.mkdirSync(turns, { recursive: true });
    fs.appendFileSync(path.join(turns, `${held.task}.jsonl`), JSON.stringify(turn) + '\n');
  } catch {}
}

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', async () => { try { await main(input); } catch {} process.exit(0); });
