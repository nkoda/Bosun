// Review comments live in <fleet>/scratchpad/reviews/<TASK>.md so humans, agents and
// `fleet note` all read the same plain file. Format:
//
//   ## path/to/file.ts:42          (":42" optional = file-level)
//   - [ ] comment text — Author · 2026-11-04 10:31
//     > agent reply
//
// Agents address an item by turning "[ ]" into "[x]" and adding "> " reply lines.
// ponytail: line numbers are stored as written and drift as the code moves; anchor to a snippet if that bites.
const fs = require('fs');
const path = require('path');

const reviewDir = fleet => path.join(fleet, 'scratchpad', 'reviews');
const reviewFile = (fleet, task) => path.join(reviewDir(fleet), `${task}.md`);

const header = task => `# Review: ${task}

<!-- Written by Fleet View. Agent holding ${task}: address each "- [ ]" item, change it
to "- [x]", and add an indented "> " line under it saying what you did. Keep the
"## file:line" headings as they are. -->
`;

function parse(text) {
  const items = [];
  let loc = null, cur = null;
  for (const l of String(text).split('\n')) {
    let m;
    if ((m = l.match(/^## (.+?)(?::(\d+))?\s*$/))) { loc = { file: m[1].trim(), line: m[2] ? +m[2] : null }; cur = null; }
    else if (loc && (m = l.match(/^- \[([ xX])\] (.*)$/))) items.push(cur = { ...loc, done: m[1] !== ' ', text: m[2], replies: [] });
    else if (cur && (m = l.match(/^\s+> ?(.*)$/))) cur.replies.push(m[1]);
    else if (cur && /^\s+\S/.test(l)) cur.text += '\n' + l.trim();
    else if (!l.trim()) cur = null;
  }
  return items;
}

function read(fleet, task) {
  try { return parse(fs.readFileSync(reviewFile(fleet, task), 'utf8')); } catch { return []; }
}

function add(fleet, task, { file, line, text, author }) {
  const f = reviewFile(fleet, task);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const body = text.trim().split('\n').map((l, i) => (i ? '  ' : '') + l).join('\n');
  const block = `\n## ${file}${line ? ':' + line : ''}\n- [ ] ${body} — ${author} · ${stamp}\n`;
  fs.appendFileSync(f, fs.existsSync(f) ? block : header(task) + block);
  return f;
}

// Tick or untick the n-th item (same order as parse()).
function setDone(fleet, task, index, done) {
  const f = reviewFile(fleet, task);
  let n = -1;
  const text = fs.readFileSync(f, 'utf8').replace(/^- \[([ xX])\] /gm, (m) => (++n === index ? `- [${done ? 'x' : ' '}] ` : m));
  fs.writeFileSync(f, text);
}

// Drafts: comments a reviewer is still writing. They sit in <TASK>.draft.json, which the hook
// and the engine never read, until submit() moves them into the review file in one go, so an
// agent never acts on half a review.
const draftFile = (fleet, task) => path.join(reviewDir(fleet), `${task}.draft.json`);
function drafts(fleet, task) {
  try { return JSON.parse(fs.readFileSync(draftFile(fleet, task), 'utf8')); } catch { return []; }
}
function addDraft(fleet, task, { file, line, text, author }) {
  const list = drafts(fleet, task);
  list.push({ file, line: line || null, text: String(text).trim(), author, at: new Date().toISOString() });
  fs.mkdirSync(reviewDir(fleet), { recursive: true });
  fs.writeFileSync(draftFile(fleet, task), JSON.stringify(list, null, 1));
}
function removeDraft(fleet, task, index) {
  const list = drafts(fleet, task);
  list.splice(index, 1);
  list.length ? fs.writeFileSync(draftFile(fleet, task), JSON.stringify(list, null, 1)) : fs.rmSync(draftFile(fleet, task), { force: true });
}
function submit(fleet, task, { note, author } = {}) {
  const list = drafts(fleet, task);
  if (note && note.trim()) list.unshift({ file: '(general)', line: null, text: note.trim(), author });
  for (const d of list) add(fleet, task, d);
  fs.rmSync(draftFile(fleet, task), { force: true });
  return list.length;
}

module.exports = { reviewDir, reviewFile, parse, read, add, setDone, drafts, addDraft, removeDraft, submit };

if (require.main === module) {
  const assert = require('assert');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  add(tmp, 'TASK-1', { file: 'src/a.ts', line: 42, text: 'why not reuse X?\nsecond line', author: 'Reviewer' });
  add(tmp, 'TASK-1', { file: 'lib/b.js', text: 'file-level note', author: 'Reviewer' });
  const f = reviewFile(tmp, 'TASK-1');
  // An agent addresses the first item.
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('- [ ] why', '- [x] why').replace('second line —', 'second line —').replace(/(second line.*\n)/, '$1  > reused X in abc123\n'));
  const items = read(tmp, 'TASK-1');
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual([items[0].file, items[0].line, items[0].done, items[0].replies], ['src/a.ts', 42, true, ['reused X in abc123']]);
  assert(items[0].text.includes('second line'));
  assert.deepStrictEqual([items[1].file, items[1].line, items[1].done], ['lib/b.js', null, false]);
  setDone(tmp, 'TASK-1', 1, true);
  setDone(tmp, 'TASK-1', 0, false);
  assert.deepStrictEqual(read(tmp, 'TASK-1').map(i => i.done), [false, true]);
  // Drafts stay out of the review file until submitted, then land in order after the note.
  addDraft(tmp, 'TASK-1', { file: 'src/c.ts', line: 7, text: '[change] "x = 1": use a constant', author: 'R' });
  addDraft(tmp, 'TASK-1', { file: 'src/d.ts', text: 'second', author: 'R' });
  removeDraft(tmp, 'TASK-1', 1);
  assert.strictEqual(read(tmp, 'TASK-1').length, 2);
  assert.strictEqual(submit(tmp, 'TASK-1', { note: 'overall: close', author: 'R' }), 2);
  assert.deepStrictEqual(read(tmp, 'TASK-1').slice(2).map(i => [i.file, i.line]), [['(general)', null], ['src/c.ts', 7]]);
  assert.deepStrictEqual(drafts(tmp, 'TASK-1'), []);
  fs.rmSync(tmp, { recursive: true });
  console.log('ok');
}
