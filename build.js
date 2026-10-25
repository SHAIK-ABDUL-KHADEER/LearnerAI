// Builds public/tree.json from the indented outline files in content/.
// Usage: node build.js
const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, 'content');
const OUT = path.join(__dirname, 'public', 'tree.json');
const ROOT_NAME = 'Artificial Intelligence';

function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const items = [];
  let unit = 0;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const expanded = line.replace(/\t/g, '  ');
    const indent = expanded.match(/^ */)[0].length;
    const name = expanded.trim().replace(/^[-*•]\s+/, '').replace(/[.;:,]+$/, '').trim();
    if (!name) continue;
    if (indent > 0 && (unit === 0 || indent < unit)) unit = indent;
    items.push({ indent, name });
  }
  if (unit === 0) unit = 2;
  const roots = [];
  const stack = []; // stack[level] = node
  for (const it of items) {
    let level = Math.round(it.indent / unit);
    if (level > stack.length) level = stack.length; // tolerate skipped levels
    const node = { n: it.name, c: [] };
    if (level === 0) {
      roots.push(node);
    } else {
      const parent = stack[level - 1];
      const dup = parent.c.find((x) => x.n.toLowerCase() === node.n.toLowerCase());
      if (dup) { stack.length = level; stack[level] = dup; continue; }
      parent.c.push(node);
    }
    stack.length = level;
    stack[level] = node;
  }
  return roots;
}

function mergeInto(list, nodes) {
  for (const node of nodes) {
    const dup = list.find((x) => x.n.toLowerCase() === node.n.toLowerCase());
    if (dup) mergeInto(dup.c, node.c);
    else list.push(node);
  }
}

function prune(node) {
  if (node.c.length === 0) delete node.c;
  else node.c.forEach(prune);
}

function count(node) {
  let total = 1, leaves = node.c ? 0 : 1, depth = 1;
  if (node.c) for (const ch of node.c) { const r = count(ch); total += r.total; leaves += r.leaves; depth = Math.max(depth, r.depth + 1); }
  return { total, leaves, depth };
}

const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.txt')).sort();
if (!files.length) { console.error('No content files found in content/'); process.exit(1); }
const root = { n: ROOT_NAME, c: [] };
for (const f of files) {
  const roots = parseFile(path.join(CONTENT_DIR, f));
  const before = count(root).total;
  mergeInto(root.c, roots);
  const after = count(root).total;
  console.log(`${f.padEnd(48)} +${String(after - before).padStart(5)} nodes  (${roots.map((r) => r.n).join(', ')})`);
}
prune(root);
const stats = count(root);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), total: stats.total, leaves: stats.leaves, depth: stats.depth, root }));
console.log(`\nTotal nodes: ${stats.total}   leaves: ${stats.leaves}   max depth: ${stats.depth}\n→ ${path.relative(__dirname, OUT)}`);
