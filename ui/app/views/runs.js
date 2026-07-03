// Runs view — start-run panel + run list + live event-sourced run dashboard.
// Event shapes are exactly docs/ARCHITECTURE.md §2: run-start, plan-start,
// plan-result, seed-slices, launch, worker-done, merge, fix-scan,
// provider-switch, stats, run-done.

import { apiGet, apiPost, openRunEvents } from '../api.js';
import { $, esc, fmtClock, fmtMs, h, runIdToLabel, shortRepo, toast } from '../util.js';

/* ------------------------------------------------- event → readable line */

function eventLine(e) {
  switch (e.type) {
    case 'run-start':
      return `run started — ${e.workers} workers · budget ${e.budget} · ${(e.repos ?? []).map(shortRepo).join(', ')}`;
    case 'plan-start':
      return `planner ${e.tag ?? ''} thinking — wants ${e.want} slice${e.want === 1 ? '' : 's'}`;
    case 'plan-result':
      if (e.status === 'queued') return `planner ${e.tag ?? ''} queued ${e.queued}: ${(e.ids ?? []).join(', ')}`;
      if (e.status === 'saturated') return `planner ${e.tag ?? ''} — pool saturated, waiting for a free worker`;
      if (e.status === 'empty') return `planner ${e.tag ?? ''} — nothing actionable in the plans`;
      if (e.status === 'provider-switch') return `planner ${e.tag ?? ''} — provider switched mid-plan`;
      return `planner ${e.tag ?? ''} — ${e.status}`;
    case 'seed-slices':
      return `seeded ${e.count} hand-authored slice${e.count === 1 ? '' : 's'}: ${(e.ids ?? []).join(', ')}`;
    case 'launch':
      return `w${e.slot} → ${e.sliceId} [${shortRepo(e.repo)}] · ${e.kind ?? 'feature'} (${e.index}/${e.budget})${e.title ? ` — ${e.title}` : ''}`;
    case 'worker-done':
      return `w${e.slot} ${e.sliceId} ${e.ok ? 'done' : 'FAILED'}${e.branch ? ` · ${e.branch}` : ''}`;
    case 'merge':
      return `merged ${(e.merged ?? []).join(', ')}${e.label ? ` (${e.label})` : ''}`;
    case 'fix-scan':
      return `fix scan — found ${e.found}, queued ${e.queued}, fixing ${e.fixing}`;
    case 'verify-start':
      return `verifying ${shortRepo(e.repo)} — ${(e.steps ?? []).join(' → ')}`;
    case 'verify-result':
      return e.ok
        ? `✔ ${shortRepo(e.repo)} builds & tests pass`
        : `✖ ${shortRepo(e.repo)} — ${e.failedStep} failed${e.command ? ` (${e.command})` : ''}`;
    case 'verify-repair':
      return `repairing ${shortRepo(e.repo)} ${e.failedStep} (round ${e.round})`;
    case 'verify-giveup':
      return `verify ${shortRepo(e.repo)} — stopped (${e.reason}); left for a follow-up run`;
    case 'verify-failed':
      return `verify ${shortRepo(e.repo)} — still failing after repair attempts`;
    case 'provider-switch':
      return `providers switched — builder ${e.builder} · reviewer ${e.reviewer}${(e.demoted ?? []).length ? ` · demoted ${(e.demoted ?? []).join(', ')}` : ''}`;
    case 'run-done':
      return `run done — ${e.launched} launched · ${e.mergedPrs} merged · ${e.failed} failed · ${e.fixed} fixed`;
    default:
      return e.type;
  }
}

function eventClass(e) {
  if (e.type === 'launch') return 'launch';
  if (e.type === 'worker-done') return e.ok ? 'ok' : 'fail';
  if (e.type === 'merge') return 'merge';
  if (e.type === 'fix-scan') return 'fix';
  if (e.type === 'verify-result') return e.ok ? 'ok' : 'fail';
  if (e.type === 'verify-repair') return 'fix';
  if (e.type === 'verify-start') return 'plan';
  if (e.type === 'verify-failed' || e.type === 'verify-giveup') return 'warn';
  if (e.type === 'provider-switch') return 'provider';
  if (e.type === 'seed-slices') return 'seed';
  if (e.type === 'plan-result' && e.status === 'saturated') return 'warn';
  if (e.type === 'run-start' || e.type === 'run-done') return 'ok';
  return 'plan';
}

function eventTag(e) {
  if (e.type === 'plan-start' || e.type === 'plan-result') return 'plan';
  if (e.type === 'worker-done') return e.ok ? 'done' : 'fail';
  if (e.type === 'run-start') return 'start';
  if (e.type === 'run-done') return 'finish';
  if (e.type === 'seed-slices') return 'seed';
  if (e.type === 'fix-scan') return 'fix';
  if (e.type.startsWith('verify')) return 'verify';
  if (e.type === 'provider-switch') return 'provider';
  return e.type;
}

/* ------------------------------------------------------------- run list */

function statusPill(status) {
  const label = { running: 'running', done: 'done', stopped: 'stopped', empty: 'no events' }[status] ?? status;
  return `<span class="pill ${esc(status)}"><span class="dot"></span>${esc(label)}</span>`;
}

function renderList(root, ctx) {
  const cfg = ctx.config ?? {};
  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Runs</h1>
        <div class="sub">A continuous pool: a serialized planner keeps disjoint slices queued, workers
        build them in parallel worktrees, PRs merge the moment they're review-clean.</div>
      </div>
    </div>
    <section class="card run-setup">
      <h2>Start a run</h2>
      ${cfg.hasCli === false ? '<div class="notice warn">bin/planforge.mjs is not built yet — starting runs from the UI is disabled until the CLI lands.</div>' : ''}
      <div class="row">
        <div class="field"><label for="run-workers">Workers</label>
          <input id="run-workers" type="number" min="1" max="32" value="${Number(cfg.workers) || 3}"></div>
        <div class="field"><label for="run-max">Max slices</label>
          <input id="run-max" type="number" min="1" max="200" value="${Number(cfg.maxSlices) || 12}"></div>
        <div class="field"><label for="run-builder">Code writer</label>
          <select id="run-builder"><option value="">Auto (recommended)</option></select></div>
        <div class="field"><label for="run-reviewer">Reviewer</label>
          <select id="run-reviewer"><option value="">Auto (recommended)</option></select></div>
        <div class="field"><label>Repos in scope</label>
          <div class="dim" style="padding:8px 2px">${(cfg.repos ?? []).length ? (cfg.repos ?? []).map((r) => `<code>${esc(r)}</code>`).join(' · ') : '<span class="faint">from planforge.config.json</span>'}</div></div>
        <button class="btn primary" id="run-start-btn" ${cfg.hasCli === false ? 'disabled' : ''}>Start run</button>
      </div>
      <div id="run-providers" class="dim" style="padding:4px 2px"></div>
      <details>
        <summary>Models &amp; effort — which model each agent uses</summary>
        <div class="row" style="flex-wrap:wrap" id="models-editor"></div>
        <div class="dim" style="padding:2px">Saved to planforge.config.json; applies to the next run and plan wizard. Per-run overrides: <code>planforge run --model claude=… --effort codex=…</code></div>
      </details>
      <details>
        <summary>Extra tasks (optional) — anything you want done this run, in plain English</summary>
        <div class="dim" style="padding:2px 2px 8px">Describe each task the way you'd tell a teammate — "fix the typo on the login page", "the date picker is broken on mobile". The planner turns each one into a properly-scoped work item (it figures out the files itself) and builds it before other plan work.</div>
        <div id="req-rows"></div>
        <button class="btn" id="req-add">+ Add task</button>
      </details>
      <details>
        <summary>Advanced: seed exact slices (JSON)</summary>
        <div class="dim" style="padding:2px 2px 8px">For when you need precise control the planner shouldn't second-guess. A JSON array; each slice needs <code>id</code> (kebab-case, unique), <code>repo</code> (one of the repos in scope), <code>title</code>, and <code>paths</code> (the files it may touch — this is how parallel workers avoid collisions). Optional: <code>kind</code> ("feature" | "refactor" | "fix"), <code>rationale</code>, <code>notes</code> (guidance for the worker). Prefer "Extra tasks" above unless you know the codebase.</div>
        <textarea id="run-seed" rows="5" placeholder='[
  { "id": "fix-readme-badges", "repo": "owner/repo", "title": "Fix stale README badges", "paths": ["README.md"],
    "notes": "The CI badge points at the old workflow name; update it and check the other badges while there." }
]'></textarea>
      </details>
    </section>
    <div class="sect-title">Past &amp; live runs</div>
    <div id="run-list" class="loading-row"><span class="spinner"></span>loading runs…</div>`;

  // Agent availability + role pickers: which agent writes the code, which one
  // reviews. "Auto" keeps the config-priority failover; a pick pins the role.
  (async () => {
    try {
      const { providers, roles } = await apiGet('/api/providers');
      const label = (name) => (name.length <= 3 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1));
      for (const role of ['builder', 'reviewer']) {
        const sel = $(`#run-${role}`, root);
        if (!sel) continue;
        for (const p of providers) {
          const opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = p.available ? label(p.name) : `${label(p.name)} — not set up`;
          opt.disabled = !p.available;
          sel.appendChild(opt);
        }
        if (roles?.[role]) sel.querySelector('option[value=""]').textContent = `Auto (now: ${label(roles[role])})`;
      }
      const chips = providers.map((p) => `<span class="${p.available ? '' : 'faint'}" title="${esc(p.detail || '')}">${p.available ? '✔' : '✖'} ${esc(label(p.name))}</span>`).join(' &nbsp; ');
      const anyOut = providers.some((p) => !p.available);
      $('#run-providers', root).innerHTML = `Agents: ${chips}${anyOut ? ' &nbsp;·&nbsp; hover an ✖ for how to set it up, or run <code>planforge doctor</code>' : ''}`;
    } catch { /* provider info is a nicety — the run panel works without it */ }
  })();

  // Models & effort editor — dropdowns of known-good ids so a typo can't send
  // a run to a nonexistent model. "Custom…" reveals a text input for ids newer
  // than this catalog; efforts are closed vocabularies.
  const MODEL_CATALOG = {
    claude: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    codex: ['gpt-5.5'],
    glm: ['glm-5.2'],
  };
  const EFFORT_CATALOG = {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    glm: ['', 'low', 'medium', 'high', 'xhigh', 'max'], // '' = provider default
  };
  const MODEL_FIELDS = [
    { key: 'claude', label: 'Claude model', options: MODEL_CATALOG.claude, custom: true },
    { key: 'claudeFallback', label: 'Claude fallback', options: MODEL_CATALOG.claude, custom: true },
    { key: 'claudeEffort', label: 'Claude effort', options: EFFORT_CATALOG.claude },
    { key: 'codex', label: 'Codex model', options: MODEL_CATALOG.codex, custom: true },
    { key: 'codexEffort', label: 'Codex effort', options: EFFORT_CATALOG.codex },
    { key: 'glm', label: 'GLM model', options: MODEL_CATALOG.glm, custom: true },
    { key: 'glmEffort', label: 'GLM effort', options: EFFORT_CATALOG.glm, emptyLabel: 'Provider default' },
  ];
  const editor = $('#models-editor', root);
  for (const f of MODEL_FIELDS) {
    const current = (cfg.models?.[f.key] ?? '').trim();
    // A configured value outside the catalog still renders (selected) — the
    // dropdown never silently rewrites someone's config.
    const options = current && !f.options.includes(current) ? [current, ...f.options] : [...f.options];
    const opts = options.map((o) => {
      const label = o === '' ? (f.emptyLabel ?? '(empty)') : o;
      return `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
    const customOpt = f.custom ? '<option value="__custom__">Custom…</option>' : '';
    const field = h(`<div class="field"><label for="ms-${f.key}">${esc(f.label)}</label>
      <select id="ms-${f.key}">${opts}${customOpt}</select>
      ${f.custom ? `<input id="mc-${f.key}" placeholder="model id" style="display:none;margin-top:4px">` : ''}</div>`);
    editor.appendChild(field);
    if (f.custom) {
      field.querySelector('select').addEventListener('change', (e) => {
        field.querySelector('input').style.display = e.target.value === '__custom__' ? '' : 'none';
      });
    }
  }
  editor.appendChild(h('<button class="btn" id="models-save">Save models</button>'));

  $('#models-save', root).addEventListener('click', async () => {
    const body = {};
    for (const f of MODEL_FIELDS) {
      const sel = $(`#ms-${f.key}`, root).value;
      const v = sel === '__custom__' ? $(`#mc-${f.key}`, root).value.trim() : sel;
      if (!v && f.key !== 'glmEffort') { toast(`${f.label} cannot be empty`, 'err'); return; }
      body[f.key] = v;
    }
    try {
      await apiPost('/api/config/models', body);
      toast('Models saved — applies to the next run');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // Extra tasks: one row per plain-English request; the planner scopes them.
  const reqRows = $('#req-rows', root);
  const addReqRow = () => {
    const row = h(`<div class="row req-row" style="align-items:flex-end">
      <div class="field" style="flex:0 1 220px"><label>Repo</label>
        <select class="req-repo"><option value="">Let the planner choose</option>${(cfg.repos ?? []).map((r) => `<option value="${esc(r)}">${esc(shortRepo(r))}</option>`).join('')}</select></div>
      <div class="field" style="flex:1 1 320px"><label>What needs doing?</label>
        <input class="req-text" placeholder="e.g. fix the typo on the login page"></div>
      <button class="btn req-remove" title="Remove this task" style="flex:0 0 auto;align-self:flex-end">✕</button>
    </div>`);
    row.querySelector('.req-remove').addEventListener('click', () => row.remove());
    reqRows.appendChild(row);
    row.querySelector('.req-text').focus();
  };
  $('#req-add', root).addEventListener('click', addReqRow);

  $('#run-start-btn', root).addEventListener('click', async () => {
    const btn = $('#run-start-btn', root);
    const body = {};
    const workers = $('#run-workers', root).value.trim();
    const maxSlices = $('#run-max', root).value.trim();
    if (workers) body.workers = Number(workers);
    if (maxSlices) body.maxSlices = Number(maxSlices);
    const builder = $('#run-builder', root)?.value;
    const reviewer = $('#run-reviewer', root)?.value;
    if (builder) body.builder = builder;
    if (reviewer) body.reviewer = reviewer;

    const requests = [...root.querySelectorAll('#req-rows .req-row')].map((row) => ({
      repo: row.querySelector('.req-repo').value || undefined,
      text: row.querySelector('.req-text').value.trim(),
    })).filter((r) => r.text);
    if (requests.length) body.requests = requests;

    // Validate seed JSON here, with specific messages — not minutes later
    // when the run rejects it.
    const seedRaw = $('#run-seed', root).value.trim();
    if (seedRaw) {
      try {
        const seed = JSON.parse(seedRaw);
        if (!Array.isArray(seed)) throw new Error('must be a JSON array');
        const ids = new Set();
        seed.forEach((s, i) => {
          if (!s || typeof s !== 'object') throw new Error(`slice ${i + 1} is not an object`);
          if (!s.id || typeof s.id !== 'string') throw new Error(`slice ${i + 1} needs a string "id"`);
          if (ids.has(s.id)) throw new Error(`duplicate slice id "${s.id}"`);
          ids.add(s.id);
          if (!s.repo || ((cfg.repos ?? []).length && !(cfg.repos ?? []).includes(s.repo))) {
            throw new Error(`slice "${s.id}": "repo" must be one of the repos in scope (${(cfg.repos ?? []).join(', ') || 'none configured yet'})`);
          }
          if (!Array.isArray(s.paths) || s.paths.length === 0) throw new Error(`slice "${s.id}" needs a non-empty "paths" array (the files it may touch)`);
        });
        body.seedSlices = seed;
      } catch (err) {
        toast(`Seed slices: ${err.message}`, 'err');
        return;
      }
    }
    btn.disabled = true;
    try {
      const { id } = await apiPost('/api/runs', body);
      toast('Run started');
      window.location.hash = `#/runs/${encodeURIComponent(id)}`;
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  async function refresh() {
    let runs;
    try {
      runs = await apiGet('/api/runs');
    } catch (err) {
      const hostEl = $('#run-list', root);
      if (hostEl) hostEl.outerHTML = `<div id="run-list" class="notice err">Could not list runs: ${esc(err.message)}</div>`;
      return;
    }
    const host = $('#run-list', root);
    if (!host) return;
    if (!runs.length) {
      host.outerHTML = `
        <div id="run-list" class="card empty-state">
          <div class="glyph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-7 4 14 2.5-7h5"/></svg></div>
          <h3>No runs yet</h3>
          <p>Once a plan has buildable slices, start a run and watch the pool plan, build,
          review, and merge in real time.</p>
        </div>`;
      return;
    }
    const rows = runs.map((r) => {
      const s = r.stats ?? {};
      const d = r.runDone;
      const launched = d?.launched ?? s.launched ?? 0;
      const budget = s.budget ?? r.runStart?.budget ?? '?';
      const merged = d?.mergedPrs ?? s.mergedPrs ?? 0;
      const failed = d?.failed ?? s.failed ?? 0;
      return `
        <a class="card run-row" href="#/runs/${encodeURIComponent(r.id)}">
          <div><div class="when">${esc(runIdToLabel(r.id))}</div><div class="id">${esc(r.id)}</div></div>
          ${statusPill(r.status)}
          <span class="spacer"></span>
          <span class="metric"><b>${launched}</b>/${budget} launched</span>
          <span class="metric"><b>${merged}</b> merged</span>
          <span class="metric" ${failed ? 'style="color:var(--err)"' : ''}><b>${failed}</b> failed</span>
          <span class="metric">${s.elapsedMs != null || d ? esc(fmtMs(d?.elapsedMs ?? s.elapsedMs)) : '—'}</span>
        </a>`;
    }).join('');
    host.outerHTML = `<div id="run-list" class="run-rows">${rows}</div>`;
  }
  refresh();
  const timer = setInterval(refresh, 5000);
  return () => clearInterval(timer);
}

/* -------------------------------------------------------------- live view */

const TILE_DEFS = [
  { id: 'progress', label: 'Progress' },
  { id: 'inflight', label: 'In flight' },
  { id: 'queued', label: 'Queued' },
  { id: 'merged', label: 'Merged PRs' },
  { id: 'slices', label: 'Merged slices' },
  { id: 'failed', label: 'Failed' },
  { id: 'fix', label: 'Fix lane' },
  { id: 'elapsed', label: 'Elapsed' },
];

function renderLive(root, ctx, runId) {
  const S = {
    runStart: null,
    stats: null,
    statsAt: 0,
    slots: {},
    provider: null,
    planner: null,
    done: null,
    connected: false,
    maxSlot: 0,
  };
  let feedEmpty = true;
  let slotCount = 0;

  root.innerHTML = `
    <a class="backlink" href="#/runs">&larr; All runs</a>
    <div class="run-head">
      <h1>${esc(runIdToLabel(runId))}</h1>
      <span class="pill" id="run-pill"><span class="dot"></span><span id="run-pill-txt">connecting…</span></span>
      <span class="grow"></span>
      <span class="elapsed num" id="run-elapsed">0s</span>
      <button class="btn danger sm" id="run-stop">Stop run</button>
    </div>
    <div id="done-summary"></div>
    <div class="provider-banner" id="provider-banner"></div>
    <div class="tiles">
      ${TILE_DEFS.map((t) => `
        <div class="tile" id="tile-${t.id}">
          <div class="k">${esc(t.label)}</div>
          <div class="v num" id="tv-${t.id}">—</div>
          <div class="sub" id="ts-${t.id}"></div>
          ${t.id === 'progress' ? '<div class="bar"><i id="progress-bar"></i></div>' : ''}
        </div>`).join('')}
    </div>
    <div class="sect-title" id="slots-title">Workers</div>
    <div class="slot-grid" id="slot-grid"><div class="dim" style="padding:8px 2px">waiting for run-start…</div></div>
    <div class="run-cols">
      <section class="card feed-panel">
        <div class="sect-title" style="margin-top:2px">Event stream</div>
        <div class="feed" id="feed"><div class="empty">waiting for events…</div></div>
      </section>
      <section class="card side-panel">
        <div class="sect-title" style="margin-top:2px">Run</div>
        <div id="run-side"><div class="dim">no run-start event yet</div></div>
        <div class="sect-title">Planner</div>
        <div id="planner-side" class="dim" style="font-size:12.5px">idle</div>
      </section>
    </div>`;

  const set = (id, v) => { const e = $(`#${id}`, root); if (e) e.textContent = v; };

  /* ---- slots ---- */
  function ensureSlots(k) {
    if (k <= slotCount) return;
    const grid = $('#slot-grid', root);
    if (slotCount === 0) grid.innerHTML = '';
    for (let i = slotCount + 1; i <= k; i += 1) {
      grid.appendChild(h(`
        <div class="slot" data-slot="${i}">
          <div class="top"><span>w${i}</span><span class="stime"></span></div>
          <div class="sid">idle</div>
          <div class="srepo">waiting…</div>
          <span class="kind"></span>
        </div>`));
    }
    slotCount = k;
  }
  function paintSlot(n) {
    const cell = $(`.slot[data-slot="${n}"]`, root);
    if (!cell) return;
    const w = S.slots[n];
    if (w) {
      cell.className = `slot busy${w.kind === 'fix' ? ' fix' : ''}`;
      $('.sid', cell).textContent = w.sliceId ?? '?';
      $('.sid', cell).title = w.title ?? '';
      $('.srepo', cell).textContent = shortRepo(w.repo);
      $('.stime', cell).textContent = fmtMs(Date.now() - (w.t ?? Date.now()));
      $('.kind', cell).textContent = w.kind ?? 'feature';
    } else {
      cell.className = 'slot';
      $('.sid', cell).textContent = 'idle';
      $('.sid', cell).title = '';
      $('.srepo', cell).textContent = 'waiting…';
      $('.stime', cell).textContent = '';
      $('.kind', cell).textContent = '';
    }
  }

  /* ---- feed ---- */
  function addFeed(e) {
    if (e.type === 'stats') return; // high-frequency tile feed, not log-worthy
    const feed = $('#feed', root);
    if (!feed) return;
    if (feedEmpty) { feed.innerHTML = ''; feedEmpty = false; }
    const historical = Date.now() - (e.t ?? 0) > 5000;
    const msg = eventLine(e);
    const row = h(`
      <div class="ev ${eventClass(e)}${historical ? '' : ' in'}">
        <span class="et">${esc(fmtClock(e.t))}</span>
        <span class="eg">${esc(eventTag(e))}</span>
        <span class="em" title="${esc(msg)}">${esc(msg)}</span>
      </div>`);
    feed.insertBefore(row, feed.firstChild);
    while (feed.childElementCount > 250) feed.removeChild(feed.lastChild);
  }

  /* ---- tiles / header ---- */
  function elapsedNow() {
    if (S.done?.elapsedMs != null) return S.done.elapsedMs;
    if (S.stats) return (S.stats.elapsedMs ?? 0) + (S.done ? 0 : Date.now() - S.statsAt);
    if (S.runStart?.t) return Date.now() - S.runStart.t;
    return null;
  }

  function paintTiles() {
    const st = S.stats ?? {};
    const d = S.done;
    const k = S.runStart?.workers ?? S.maxSlot ?? 0;
    const launched = d?.launched ?? st.launched ?? 0;
    const budget = st.budget ?? S.runStart?.budget ?? 0;
    const inFlight = d ? 0 : (st.inFlight ?? Object.keys(S.slots).length);

    set('tv-progress', budget ? `${launched}` : '—');
    const sub = $('#ts-progress', root);
    if (sub) sub.textContent = budget ? `of ${budget} slice budget${st.dry ? ' · draining' : ''}` : '';
    const bar = $('#progress-bar', root);
    if (bar && budget) bar.style.width = `${Math.min(100, Math.round((launched / budget) * 100))}%`;

    set('tv-inflight', String(inFlight));
    set('ts-inflight', k ? `${Math.max(0, k - inFlight)} of ${k} idle` : '');
    set('tv-queued', String(d ? 0 : (st.queued ?? 0)));
    set('ts-queued', 'slice buffer');
    set('tv-merged', String(d?.mergedPrs ?? st.mergedPrs ?? 0));
    set('tv-slices', String(st.mergedSlices ?? 0));
    const failed = d?.failed ?? st.failed ?? 0;
    const failedTile = $('#tile-failed', root);
    set('tv-failed', String(failed));
    if (failedTile) failedTile.classList.toggle('alert', failed > 0);
    set('tv-fix', String(d ? 0 : (st.fixing ?? 0)));
    set('ts-fix', `${d ? 0 : (st.fixQueued ?? 0)} queued · ${d?.fixed ?? st.fixed ?? 0} fixed`);
    const el = elapsedNow();
    set('tv-elapsed', el == null ? '—' : fmtMs(el));
    set('run-elapsed', el == null ? '' : fmtMs(el));

    const busy = Object.keys(S.slots).length;
    set('slots-title', k ? `Workers · ${busy}/${k} building` : 'Workers');
  }

  function paintPill() {
    const pill = $('#run-pill', root);
    if (!pill) return;
    let cls = 'stopped';
    let txt = 'waiting';
    if (!S.connected) { cls = 'err'; txt = 'disconnected'; }
    else if (S.done) { cls = 'done'; txt = 'done'; }
    else if (S.stats?.dry) { cls = 'running'; txt = 'draining'; }
    else if (S.runStart) { cls = 'running'; txt = 'running'; }
    pill.className = `pill ${cls}`;
    set('run-pill-txt', txt);
    const stopBtn = $('#run-stop', root);
    if (stopBtn) stopBtn.style.display = S.done ? 'none' : '';
  }

  function paintSide() {
    const side = $('#run-side', root);
    if (!side) return;
    if (!S.runStart) { side.innerHTML = '<div class="dim">no run-start event yet</div>'; return; }
    const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
    let html = kv('Workers', String(S.runStart.workers ?? '?'))
      + kv('Slice budget', String(S.stats?.budget ?? S.runStart.budget ?? '?'));
    if (S.provider) html += kv('Builder → Reviewer', `${esc(S.provider.builder)} → ${esc(S.provider.reviewer)}`);
    if (S.done) html += kv('Result', `${S.done.launched} launched · ${S.done.mergedPrs} merged · ${S.done.failed} failed · ${S.done.fixed} fixed`);
    html += `<div class="repo-list">${(S.runStart.repos ?? []).map((r) => `<span title="${esc(r)}">${esc(r)}</span>`).join('')}</div>`;
    side.innerHTML = html;
  }

  function paintPlanner() {
    const el = $('#planner-side', root);
    if (!el) return;
    const p = S.planner;
    if (!p) { el.textContent = 'idle'; return; }
    if (p.phase === 'planning') el.textContent = `planning ${p.tag ?? ''} — wants ${p.want}`;
    else if (p.status === 'queued') el.textContent = `queued ${p.queued}: ${(p.ids ?? []).join(', ')}`;
    else if (p.status === 'saturated') el.textContent = 'saturated — pool is full, planner waiting';
    else if (p.status === 'empty') el.textContent = 'nothing actionable in the plans';
    else if (p.status === 'provider-switch') el.textContent = 'interrupted by a provider switch';
    else el.textContent = p.status ?? 'idle';
  }

  function paintDone() {
    const hostEl = $('#done-summary', root);
    if (!hostEl) return;
    if (!S.done) { hostEl.innerHTML = ''; return; }
    const d = S.done;
    hostEl.innerHTML = `
      <div class="done-summary">
        <div class="badge">✓</div>
        <div>
          <h3>Run complete</h3>
          <p>${d.launched} slice${d.launched === 1 ? '' : 's'} launched · ${d.mergedPrs} PR${d.mergedPrs === 1 ? '' : 's'} merged ·
          ${d.failed} failed · ${d.fixed} repaired by the fix lane${d.elapsedMs != null ? ` · ${fmtMs(d.elapsedMs)}` : ''}</p>
        </div>
      </div>`;
  }

  function paintProvider() {
    const banner = $('#provider-banner', root);
    if (!banner) return;
    if (!S.provider) { banner.classList.remove('show'); return; }
    const p = S.provider;
    banner.innerHTML = `<span>⇄ Provider switch — builder <b>${esc(p.builder)}</b>, reviewer <b>${esc(p.reviewer)}</b>${(p.demoted ?? []).length ? ` (demoted: ${esc((p.demoted ?? []).join(', '))})` : ''}</span>`;
    banner.classList.add('show');
  }

  /* ---- event handling (ARCHITECTURE.md §2) ---- */
  function handle(e) {
    switch (e.type) {
      case 'run-start':
        S.runStart = e;
        ensureSlots(e.workers ?? 0);
        break;
      case 'plan-start':
        S.planner = { phase: 'planning', tag: e.tag, want: e.want };
        break;
      case 'plan-result':
        S.planner = { phase: 'result', ...e };
        break;
      case 'launch':
        S.maxSlot = Math.max(S.maxSlot, e.slot ?? 0);
        ensureSlots(S.maxSlot);
        S.slots[e.slot] = e;
        paintSlot(e.slot);
        break;
      case 'worker-done':
        delete S.slots[e.slot];
        paintSlot(e.slot);
        break;
      case 'provider-switch':
        S.provider = e;
        paintProvider();
        break;
      case 'stats':
        S.stats = e;
        S.statsAt = Date.now();
        break;
      case 'run-done':
        S.done = e;
        S.slots = {};
        for (let i = 1; i <= slotCount; i += 1) paintSlot(i);
        paintDone();
        break;
      default:
        break; // seed-slices, merge, fix-scan → feed only (additive-only contract)
    }
    addFeed(e);
    paintTiles();
    paintPill();
    paintSide();
    paintPlanner();
  }

  const stream = openRunEvents(runId, handle, (connected) => {
    S.connected = connected;
    paintPill();
  });

  $('#run-stop', root).addEventListener('click', async () => {
    if (!window.confirm('Stop this run? In-flight workers get SIGTERM.')) return;
    try {
      await apiPost(`/api/runs/${encodeURIComponent(runId)}/stop`, {});
      toast('Stop signal sent');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  const ticker = setInterval(() => {
    for (const n of Object.keys(S.slots)) {
      const cell = $(`.slot[data-slot="${n}"] .stime`, root);
      if (cell && S.slots[n]) cell.textContent = fmtMs(Date.now() - (S.slots[n].t ?? Date.now()));
    }
    const el = elapsedNow();
    if (el != null && !S.done) { set('run-elapsed', fmtMs(el)); set('tv-elapsed', fmtMs(el)); }
  }, 1000);

  return () => {
    clearInterval(ticker);
    stream.close();
  };
}

/* ------------------------------------------------------------------ entry */

export function renderRuns(root, ctx, params = {}) {
  if (params.mode === 'live') return renderLive(root, ctx, params.id);
  return renderList(root, ctx);
}
