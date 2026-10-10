'use strict';
const fs = require('fs');
const path = require('path');
const { newCounters, makeEnv } = require('./dom-harness');

const ROOT = path.join(__dirname, '..');
const targets = [
  ['after', path.join(ROOT, 'renderer', 'agents.js')],
  ['before', path.join(__dirname, 'baseline', 'agents-before.js')]
];
for (const [tag, file] of targets) {
  const counters = newCounters();
  const src = fs.readFileSync(file, 'utf8');
  try {
    const env = makeEnv(src, { filename: file });
    console.log(`[${tag}] LOAD OK`);
    console.log(`[${tag}] events=${env.events.length}`);
    console.log(`[${tag}] debugAgents=${typeof env.win.__debugAgents}`);
    console.log(`[${tag}] demoAgentEntry=${typeof env.win.__demoAgentEntry}`);
    const d = env.win.__debugAgents ? env.win.__debugAgents() : null;
    console.log(`[${tag}] debug=${JSON.stringify(d)}`);
  } catch (e) {
    console.log(`[${tag}] LOAD FAIL: ${e && e.message}`);
    console.log((e && e.stack || '').split('\n').slice(0, 8).join('\n'));
  }
}