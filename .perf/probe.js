'use strict';
const fs = require('fs');
const path = require('path');
const { instrument } = require('./instrument');

const files = {
  after: path.join(__dirname, '..', 'renderer', 'agents.js'),
  before: path.join(__dirname, 'baseline', 'agents-before.js')
};
for (const [tag, f] of Object.entries(files)) {
  const out = instrument(fs.readFileSync(f, 'utf8'));
  const probes = [
    ['tCalls wrap', /__PERF__\.tCalls\+\+/],
    ['lCalls wrap', /__PERF__\.lCalls\+\+/],
    ['hCalls wrap', /__PERF__\.hCalls\+\+/],
    ['eTotal', /__PERF__\.eTotal\+\+/],
    ['eBuilt', /__PERF__\.eBuilt\+\+/],
    ['resets', /__PERF__\.resets = /],
    ['md', /__PERF__\.md\+\+/],
    ['diff', /__PERF__\.dAll\+\+/],
    ['lRows', /__PERF__\.lRows\+\+/]
  ];
  console.log(`--- ${tag} ---`);
  for (const [name, re] of probes) console.log(`  ${name}: ${re.test(out) ? 'HIT' : 'MISS'}`);
  const hits = (out.match(/__PERF__\./g) || []).length;
  console.log(`  total __PERF__ refs: ${hits}`);
}