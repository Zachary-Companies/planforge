// Preferences view — renders the form described by /api/questions
// (planning/questions.json is the single source of truth), pre-filled from
// /api/preferences, saved via POST /api/preferences.
//
// Each question carries a `mapsTo` dotted path into stack-preferences.json
// (e.g. "webApp.db"). Leaving a question unanswered omits the field — that is
// what "No preference" means. An "Other" option becomes a free-text input.
// A freeform textarea (top-level `freeform` string) is always offered.

import { apiGet, apiGetOrNull, apiPost } from '../api.js';
import { $, $$, esc, toast } from '../util.js';
import { preferenceGroups, getPath, setPath, deletePath } from '../questions.js';

function questionHtml(q) {
  const hint = q.help ? `<span class="hint">${esc(q.help)}</span>` : '';
  const wide = q.type === 'textarea' ? ' wide' : '';
  let control = '';
  if (q.type === 'select' || q.type === 'multiselect') {
    const opts = q.options.map((o) => `<button type="button" class="opt" data-value="${esc(o.value)}" aria-pressed="false">${esc(o.label)}</button>`).join('');
    const custom = q.allowOther
      ? `<div class="custom-input"><input type="text" data-role="custom" placeholder="${q.type === 'multiselect' ? 'other (comma-separated)…' : 'other…'}"></div>`
      : '';
    control = `<div class="opts" role="group" aria-label="${esc(q.label)}">${opts}</div>${custom}`;
  } else if (q.type === 'textarea') {
    control = `<textarea data-role="value" placeholder="${esc(q.placeholder)}"></textarea>`;
  } else {
    control = `<input type="text" data-role="value" placeholder="${esc(q.placeholder)}">`;
  }
  return `
    <div class="field${wide}" data-qid="${esc(q.id)}" data-type="${esc(q.type)}" data-maps-to="${esc(q.mapsTo ?? '')}">
      <label>${esc(q.label)}</label>
      ${control}
      ${hint}
    </div>`;
}

function prefillField(field, prefs) {
  const path = field.dataset.mapsTo;
  const value = path ? getPath(prefs, path) : undefined;
  if (value === undefined || value === null) return;
  const type = field.dataset.type;
  if (type === 'select' || type === 'multiselect') {
    const values = (Array.isArray(value) ? value : [value]).map(String);
    const known = new Set();
    for (const btn of $$('.opt', field)) {
      known.add(btn.dataset.value);
      if (values.includes(btn.dataset.value)) btn.setAttribute('aria-pressed', 'true');
    }
    const extras = values.filter((v) => !known.has(v));
    const custom = $('[data-role="custom"]', field);
    if (extras.length && custom) custom.value = extras.join(', ');
  } else {
    const input = $('[data-role="value"]', field);
    if (input) input.value = Array.isArray(value) ? value.join('\n') : String(value);
  }
}

function readField(field) {
  const type = field.dataset.type;
  if (type === 'select' || type === 'multiselect') {
    const values = $$('.opt[aria-pressed="true"]', field).map((b) => b.dataset.value);
    const custom = $('[data-role="custom"]', field);
    if (custom && custom.value.trim()) {
      for (const extra of custom.value.split(',').map((s) => s.trim()).filter(Boolean)) values.push(extra);
    }
    if (!values.length) return undefined;
    return type === 'multiselect' ? values : values[0];
  }
  const input = $('[data-role="value"]', field);
  const v = input ? input.value.trim() : '';
  return v || undefined;
}

export function renderPreferences(root) {
  root.innerHTML = '<div class="loading-row"><span class="spinner"></span>loading preferences…</div>';
  let existing = null;
  let destroyed = false;

  (async () => {
    let questions;
    try {
      [questions, existing] = await Promise.all([apiGet('/api/questions'), apiGetOrNull('/api/preferences')]);
    } catch (err) {
      root.innerHTML = `<div class="notice err">Could not load the question set: ${esc(err.message)}</div>`;
      return;
    }
    if (destroyed) return;

    const groups = preferenceGroups(questions);
    if (!groups.length) {
      root.innerHTML = `
        <div class="page-head"><div><h1>Preferences</h1></div></div>
        <div class="notice warn">planning/questions.json was found but no preference questions could be
        read from it — the form cannot render. Fix the file or remove it to use the built-in set.</div>`;
      return;
    }

    const fallbackNote = questions.fallback
      ? '<div class="notice">Using the built-in question set — <code>planning/questions.json</code> is not present in this install.</div>'
      : '';

    const hero = existing ? '' : `
      <div class="hero">
        <h2>Two minutes here pays off on every build</h2>
        <p>Tell PlanForge which technologies you actually like. Every plan's architecture section starts
        from these choices (and records any deviation), and every agent in the build pool gets your stack
        summary injected into its prompt — so the software that ships looks like <em>you</em> built it.
        Skipping a question just means "no preference" — the planner picks boring, mainstream defaults.</p>
      </div>`;

    root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Preferences</h1>
          <div class="sub">Your default stack per kind of app. Saved to <code>stack-preferences.json</code>
          plus a readable <code>TECH-PREFERENCES.md</code> in your workspace.</div>
        </div>
      </div>
      ${fallbackNote}
      ${hero}
      <form id="pref-form">
        ${groups.map((g) => `
          <section class="card pref-group">
            <div class="group-head">
              <h2>${esc(g.title)}</h2>
              ${g.description ? `<p class="group-desc">${esc(g.description)}</p>` : ''}
            </div>
            <div class="pref-grid">
              ${g.questions.map((q) => questionHtml(q)).join('')}
            </div>
          </section>`).join('')}
        <section class="card pref-group">
          <div class="group-head">
            <h2>Anything else</h2>
            <p class="group-desc">Free-form guidance every planning and build agent will honor.</p>
          </div>
          <div class="pref-grid">
            <div class="field wide" data-qid="freeform" data-type="textarea" data-maps-to="freeform">
              <label>House rules, favorite libraries, hard nos…</label>
              <textarea data-role="value" placeholder="e.g. Prefer boring technology. Never introduce an ORM. All repos get a Makefile."></textarea>
            </div>
          </div>
        </section>
        <div class="savebar">
          <span class="status" id="pref-status">${existing ? 'Loaded from stack-preferences.json' : 'Nothing saved yet'}</span>
          <button type="submit" class="btn primary">Save preferences</button>
        </div>
      </form>`;

    // pill behavior: select = radio (toggles off; picking clears custom),
    // multiselect = plain toggle
    root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.opt');
      if (!btn) return;
      const field = btn.closest('.field');
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      if (field.dataset.type === 'select') {
        for (const b of $$('.opt', field)) b.setAttribute('aria-pressed', 'false');
        if (!pressed) {
          btn.setAttribute('aria-pressed', 'true');
          const custom = $('[data-role="custom"]', field);
          if (custom) custom.value = '';
        }
      } else {
        btn.setAttribute('aria-pressed', String(!pressed));
      }
      markDirty();
    });
    root.addEventListener('input', (ev) => {
      if (ev.target.closest('#pref-form')) markDirty();
      if (ev.target.matches('[data-role="custom"]') && ev.target.closest('.field')?.dataset.type === 'select') {
        for (const b of $$('.opt', ev.target.closest('.field'))) b.setAttribute('aria-pressed', 'false');
      }
    });

    for (const field of $$('.field[data-maps-to]', root)) prefillField(field, existing ?? {});

    function markDirty() {
      const s = $('#pref-status', root);
      if (s) s.textContent = 'Unsaved changes';
    }

    $('#pref-form', root).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      // start from what's on disk so unknown keys survive the round-trip
      const prefs = existing ? structuredClone(existing) : {};
      prefs.version = existing?.version ?? 1;
      for (const field of $$('.field[data-maps-to]', root)) {
        const path = field.dataset.mapsTo;
        if (!path) continue;
        const value = readField(field);
        if (value === undefined) deletePath(prefs, path);
        else setPath(prefs, path, value);
      }
      for (const key of Object.keys(prefs)) {
        const v = prefs[key];
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) delete prefs[key];
      }
      const btn = $('.savebar .btn', root);
      btn.disabled = true;
      try {
        const result = await apiPost('/api/preferences', prefs);
        existing = result.preferences ?? prefs;
        $('#pref-status', root).textContent = 'Saved';
        toast('Preferences saved — plans and agents will honor them');
        const heroEl = $('.hero', root);
        if (heroEl) heroEl.remove();
      } catch (err) {
        $('#pref-status', root).textContent = 'Save failed';
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  })();

  return () => { destroyed = true; };
}
