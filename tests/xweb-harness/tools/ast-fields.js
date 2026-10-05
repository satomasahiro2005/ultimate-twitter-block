#!/usr/bin/env node
'use strict';

// Print the fields x-web asks for, per GraphQL type, from captured operation
// ASTs (JSON files written by `run.js --dump-ops DIR`). Use it to see which
// fields the fake graph (data/xweb-graph.js) has to provide for a screen.
//
//   node tests/xweb-harness/tools/ast-fields.js DIR [TypeName ...]

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const only = new Set(process.argv.slice(3));
const types = {};

function add(type, field, info) {
  const t = types[type] || (types[type] = {});
  const prev = t[field];
  if (!prev) t[field] = info;
  else if (info.child && prev.child && prev.child.indexOf(info.child) === -1) prev.child += '|' + info.child;
}

function walk(sels, type, seen) {
  for (const s of sels || []) {
    switch (s.kind) {
      case 'ScalarField':
        add(type, s.name, { kind: 'scalar', args: (s.args || []).map((a) => a.name).join(',') });
        break;
      case 'LinkedField': {
        const child = s.concreteType || ('?' + s.name);
        add(type, s.name, { kind: 'linked', child, plural: s.plural, args: (s.args || []).map((a) => a.name).join(',') });
        walk(s.selections, child, seen);
        break;
      }
      case 'InlineFragment': walk(s.selections, s.abstractKey ? type + '~' + s.type : s.type, seen); break;
      case 'FragmentSpread':
        if (s.fragment && !seen.has(s.fragment)) { seen.add(s.fragment); walk(s.fragment.selections, type, seen); seen.delete(s.fragment); }
        break;
      case 'Condition': case 'Defer': case 'Stream': walk(s.selections, type, seen); break;
      case 'ClientComponent': if (s.fragment) walk(s.fragment.selections, type, seen); break;
      default: break;
    }
  }
}

for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  const node = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  walk(node.operation.selections, 'Query', new Set());
}

for (const t of Object.keys(types).sort()) {
  if (only.size && ![...only].some((o) => t === o || t.endsWith('~' + o) || t.startsWith('?') && t.slice(1) === o)) continue;
  console.log(t);
  for (const [f, i] of Object.entries(types[t]).sort()) {
    console.log('  ' + f + (i.args ? '(' + i.args + ')' : '') + (i.kind === 'linked' ? ' -> ' + i.child + (i.plural ? '[]' : '') : ''));
  }
}
