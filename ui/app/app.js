// PlanForge SPA shell — hash router + nav + boot. No dependencies, no build.

import { apiGet } from './api.js';
import { $, $$, esc } from './util.js';
import { renderPreferences } from './views/preferences.js';
import { renderPlans } from './views/plans.js';
import { renderRuns } from './views/runs.js';

const ctx = { config: null };

const ROUTES = [
  { re: /^#\/preferences$/, nav: 'preferences', view: (m, el) => renderPreferences(el, ctx) },
  { re: /^#\/plans\/new$/, nav: 'plans', view: (m, el) => renderPlans(el, ctx, { mode: 'new' }) },
  { re: /^#\/plans\/([^/]+)$/, nav: 'plans', view: (m, el) => renderPlans(el, ctx, { mode: 'detail', slug: decodeURIComponent(m[1]) }) },
  { re: /^#\/plans$/, nav: 'plans', view: (m, el) => renderPlans(el, ctx, { mode: 'list' }) },
  { re: /^#\/runs\/([^/]+)$/, nav: 'runs', view: (m, el) => renderRuns(el, ctx, { mode: 'live', id: decodeURIComponent(m[1]) }) },
  { re: /^#\/runs$/, nav: 'runs', view: (m, el) => renderRuns(el, ctx, { mode: 'list' }) },
];

let cleanup = null;

function route() {
  const hash = window.location.hash || defaultHash();
  const match = ROUTES.map((r) => ({ r, m: hash.match(r.re) })).find((x) => x.m);
  const main = $('#main');
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* view teardown */ } }
  cleanup = null;

  for (const a of $$('.nav a')) a.classList.toggle('active', Boolean(match) && a.dataset.nav === match.r.nav);

  // fresh container per view so per-view listeners die with the node
  main.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'view';
  main.appendChild(container);

  if (!match) {
    window.location.hash = defaultHash();
    return;
  }
  cleanup = match.r.view(match.m, container) ?? null;
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function defaultHash() {
  // first visit flows naturally: no preferences yet → start there
  if (ctx.config && ctx.config.hasPreferences === false) return '#/preferences';
  return '#/plans';
}

function paintFooter() {
  const foot = $('#side-foot');
  if (!foot) return;
  if (!ctx.config) { foot.innerHTML = '<span class="dim">server unreachable</span>'; return; }
  const c = ctx.config;
  foot.innerHTML = `
    ${c.configPath ? 'workspace' : '<span title="no planforge.config.json found — using defaults">workspace (defaults)</span>'}
    <span class="ws" title="${esc(c.workspace ?? '')}">${esc(c.workspace ?? '')}</span>`;
}

async function boot() {
  try {
    ctx.config = await apiGet('/api/config');
  } catch {
    ctx.config = null;
  }
  paintFooter();
  if (!window.location.hash) window.location.hash = defaultHash();
  route();
  // keep the config flags (hasPreferences, hasCli) fresh-ish
  setInterval(async () => {
    try { ctx.config = await apiGet('/api/config'); paintFooter(); } catch { /* transient */ }
  }, 30_000);
}

window.addEventListener('hashchange', route);
boot();
