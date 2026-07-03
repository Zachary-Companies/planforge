import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjectActions, listProjects, localDirForRepo } from './project.mjs';

function proj(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-proj-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
const actionsById = (r) => Object.fromEntries(r.actions.map((a) => [a.id, a]));

test('localDirForRepo takes the basename of owner/repo', () => {
  assert.equal(localDirForRepo('acme/circle-album', '/ws'), join('/ws', 'circle-album'));
  assert.equal(localDirForRepo('circle-album', '/ws'), join('/ws', 'circle-album'));
});

test('detects node scripts and prepends install when node_modules is missing', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', deploy: 'firebase deploy' } }),
    'package-lock.json': '{}',
  });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.start.available, true);
  assert.equal(a.start.longRunning, true);
  assert.equal(a.start.command, 'npm install && npm run dev');
  assert.equal(a.build.command, 'npm install && npm run build');
  assert.equal(a.publish.command, 'npm install && npm run deploy');
  assert.equal(a.publish.confirm, true);
});

test('no install prefix once node_modules exists; respects pnpm lockfile', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { start: 'node .', build: 'tsc' } }),
    'pnpm-lock.yaml': '',
    'node_modules/.keep': '',
  });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.start.command, 'pnpm start');
  assert.equal(a.build.command, 'pnpm build');
});

test('publish falls back to a detected deploy target when there is no script', () => {
  const dir = proj({
    'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }),
    'node_modules/.keep': '',
    'firebase.json': '{}',
  });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.publish.available, true);
  assert.match(a.publish.command, /firebase-tools deploy/);
  assert.match(a.publish.label, /Firebase/);
});

test('missing actions are reported unavailable with a fix hint', () => {
  const dir = proj({ 'package.json': JSON.stringify({ scripts: {} }), 'node_modules/.keep': '' });
  const a = actionsById(detectProjectActions(dir));
  assert.equal(a.start.available, false);
  assert.match(a.start.reason, /dev\/start script/);
  assert.equal(a.publish.available, false);
});

test('config overrides force or hide commands', () => {
  const dir = proj({ 'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', deploy: 'x' } }), 'node_modules/.keep': '' });
  const a = actionsById(detectProjectActions(dir, { start: 'make run', publish: '' }));
  assert.equal(a.start.command, 'make run');
  assert.ok(!('publish' in a), 'empty override hides the action');
  assert.equal(a.build.available, true); // untouched
});

test('a static site (index.html, no package.json) can be served', () => {
  const dir = proj({ 'index.html': '<h1>hi</h1>' });
  const r = detectProjectActions(dir);
  assert.equal(r.kind, 'static');
  const a = actionsById(r);
  assert.match(a.start.command, /serve/);
});

test('non-existent project reports exists:false and no actions', () => {
  const r = detectProjectActions('/no/such/dir');
  assert.equal(r.exists, false);
  assert.equal(r.actions.length, 0);
});

test('listProjects sorts existing first and applies overrides by name or repo', () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-ws-'));
  mkdirSync(join(ws, 'built'), { recursive: true });
  writeFileSync(join(ws, 'built', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  writeFileSync(join(ws, 'built', 'package-lock.json'), '{}');
  const list = listProjects({
    repos: ['acme/missing', 'acme/built'],
    workspace: ws,
    projectsConfig: { 'acme/built': { start: 'custom-start' } },
  });
  assert.equal(list[0].name, 'built');
  assert.equal(list[0].exists, true);
  assert.equal(actionsById(list[0]).start.command, 'custom-start');
  assert.equal(list[1].exists, false);
});
