// Plans view — list of build plans, rendered plan detail (+ revise box), and
// the "New plan" wizard: a stepper driven by /api/questions interview steps
// that streams the plan agent's progress while it forges the document.

import { apiGet, apiPost, apiText, streamNdjson } from '../api.js';
import { $, $$, esc, fmtMs, h, relTime, toast } from '../util.js';
import { renderMarkdown } from '../md.js';
import { interviewSteps } from '../questions.js';

function appendConsoleLine(consoleEl, text, isStderr) {
  const prev = $('.line.last', consoleEl);
  if (prev) prev.classList.remove('last');
  const line = h(`<span class="line last${isStderr ? ' stderr' : ''}">${esc(text)}</span>`);
  consoleEl.appendChild(line);
  while (consoleEl.childElementCount > 400) consoleEl.removeChild(consoleEl.firstChild);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// The plan pipeline's stages, in order, with human labels. review-N and any
// future stage name are handled dynamically.
const PLAN_STAGE_LABELS = {
  draft: 'Drafting the plan',
  revise: 'Applying your changes',
  deepen: 'Digging into the details',
  write: 'Writing the plan file',
  scaffold: 'Setting up the project folder',
};
function planStageLabel(name) {
  const review = name.match(/^review-(\d+)/);
  if (review) return `Consistency review ${review[1]}`;
  return PLAN_STAGE_LABELS[name] || name;
}

// A live stage checklist with a per-stage ticking clock. Both the new-plan
// wizard and the revise/refine box use it so an agent that thinks silently for
// minutes always looks alive. Returns { el, stage(name), finish(ok) }.
function createStageTracker() {
  const el = document.createElement('div');
  el.className = 'forge-stages';
  let startedAt = null;
  const tick = setInterval(() => {
    const clock = el.querySelector('.stage-active .stage-clock');
    if (clock && startedAt) clock.textContent = fmtMs(Date.now() - startedAt);
  }, 1000);
  const closePrev = (mark) => {
    const prev = el.querySelector('.stage-active');
    if (prev) { prev.classList.remove('stage-active'); prev.querySelector('.stage-mark').textContent = mark; }
  };
  return {
    el,
    stage(name) {
      closePrev('✔');
      startedAt = Date.now();
      el.appendChild(h(`<div class="stage-row stage-active">
        <span class="stage-mark"><span class="spinner"></span></span>
        <span class="stage-name">${esc(planStageLabel(name))}</span>
        <span class="stage-clock dim">0s</span>
      </div>`));
    },
    finish(ok) { clearInterval(tick); closePrev(ok ? '✔' : '✖'); },
  };
}

// Route one NDJSON stream event: @plan-stage markers advance the tracker,
// everything else scrolls the console.
function feedPlanEvent(tracker, consoleEl, e) {
  if (e.type === 'progress') {
    const m = e.line.match(/^@plan-stage\s+(\S+)/);
    if (m) { tracker.stage(m[1]); return; }
    appendConsoleLine(consoleEl, e.line, e.stream === 'stderr');
  } else if (e.type === 'start') {
    appendConsoleLine(consoleEl, `$ ${e.cmd}`);
  }
}

// A compact "6 / 27 built" progress bar from a plan's slice tallies.
function planProgress(s) {
  if (!s || !s.total) return '';
  const done = s.shipped;
  const pct = Math.round((done / s.total) * 100);
  const left = s.total - done;
  return `<div class="plan-progress" title="${done} shipped · ${s.pending} pending${s.blocked ? ` · ${s.blocked} blocked` : ''}${s.building ? ` · ${s.building} building` : ''}">
      <div class="pp-bar"><div class="pp-fill" style="width:${pct}%"></div></div>
      <div class="pp-label">${done} / ${s.total} built${left > 0 ? ` · ${left} to go` : ' · complete'}</div>
    </div>`;
}

/* ------------------------------------------------------------------ list */

function renderList(root, ctx) {
  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Plans</h1>
        <div class="sub">Build plans are the single source of truth for what gets built —
        thesis, architecture, open decisions, and phases of file-disjoint slices.</div>
      </div>
      <div class="page-actions">
        <a class="btn primary" href="#/plans/new">＋ New plan</a>
      </div>
    </div>
    <div id="plan-list" class="loading-row"><span class="spinner"></span>loading plans…</div>`;

  (async () => {
    let plans;
    try {
      plans = await apiGet('/api/plans');
    } catch (err) {
      $('#plan-list', root).outerHTML = `<div class="notice err">Could not list plans: ${esc(err.message)}</div>`;
      return;
    }
    const host = $('#plan-list', root);
    if (!host) return;
    if (!plans.length) {
      host.outerHTML = `
        <div class="card empty-state">
          <div class="glyph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h9a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H9M9 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M9 4v16"/><path d="M12 8h4M12 12h4M12 16h2"/></svg></div>
          <h3>No plans yet</h3>
          <p>Answer eight quick questions about your idea and the plan agent will draft a full
          build plan — architecture, open decisions, and buildable slices.</p>
          <a class="btn primary" href="#/plans/new">Forge your first plan</a>
        </div>`;
      return;
    }
    host.outerHTML = `
      <div class="plan-grid">
        ${plans.map((p) => `
          <a class="card plan-card" href="#/plans/${encodeURIComponent(p.slug)}">
            <h3>${esc(p.title)}</h3>
            <span class="slug">${esc(p.slug)}-build-plan.md</span>
            ${planProgress(p.slices)}
            <div class="meta">
              <span class="chip info">${p.phases} phase${p.phases === 1 ? '' : 's'}</span>
              <span class="chip ${p.openDecisions ? 'warn' : 'ok'}">${p.openDecisions
                ? `${p.openDecisions} open decision${p.openDecisions === 1 ? '' : 's'}`
                : 'decisions settled'}</span>
              <span class="chip">${esc(relTime(p.mtime))}</span>
            </div>
          </a>`).join('')}
      </div>`;
  })();
  return () => {};
}

/* ---------------------------------------------------------------- detail */

function renderDetail(root, ctx, slug) {
  root.innerHTML = `
    <a class="backlink" href="#/plans">&larr; All plans</a>
    <div class="plan-detail-cols">
      <div class="card md-doc" id="plan-doc"><div class="loading-row"><span class="spinner"></span>loading plan…</div></div>
      <div class="plan-side">
      <div class="card build-card" id="build-card" hidden></div>
      <div class="card revise-card">
        <h3>Add features &amp; refine</h3>
        <p class="hint">Add new features or change anything — the plan agent applies it, digs into
        the details, and runs consistency reviews, so the new work is as thorough as the rest.
        Shipped slices and the status ledger are preserved.</p>
        <textarea id="revise-text" placeholder="e.g. Add photo comments and a shareable public album link. Also switch storage to Firebase."></textarea>
        <div class="actions"><button class="btn primary sm" id="revise-btn">Add &amp; refine</button></div>
        <div class="forge-stages" id="revise-stages" style="margin-top:12px"></div>
        <div class="console" id="revise-console" style="display:none;margin-top:12px"></div>
      </div>
      </div>
    </div>`;

  // Build-progress card: how much of the plan is built, and a one-click "build
  // the rest" that starts a pool run. This is the answer to "it isn't doing
  // everything in the plan" — the pending slices just haven't been built yet.
  async function loadProgress() {
    try {
      const plans = await apiGet('/api/plans');
      const p = (Array.isArray(plans) ? plans : []).find((x) => x.slug === slug);
      const s = p?.slices;
      const card = $('#build-card', root);
      if (!card || !s || !s.total) return;
      const left = s.pending + s.building;
      card.hidden = false;
      card.innerHTML = `<h3>Build progress</h3>
        ${planProgress(s)}
        ${left > 0
          ? `<p class="hint">${s.pending} slice${s.pending === 1 ? '' : 's'} still to build${s.blocked ? ` (${s.blocked} blocked on an open decision)` : ''}. Run the build pool to work through them.</p>
             <button class="btn primary sm" id="build-pending">Build the ${s.pending} pending slice${s.pending === 1 ? '' : 's'} ▶</button>`
          : `<p class="hint">Every slice in this plan is built. 🎉</p>`}`;
      const btn = $('#build-pending', root);
      btn?.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const { id } = await apiPost('/api/runs', { maxSlices: Math.max(12, s.pending + 3) });
          toast('Build pool started');
          window.location.hash = `#/runs/${encodeURIComponent(id)}`;
        } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
      });
    } catch { /* progress is a nicety; ignore */ }
  }

  let reloading = false;
  async function loadDoc() {
    try {
      const md = await apiText(`/api/plans/${encodeURIComponent(slug)}`);
      const doc = $('#plan-doc', root);
      if (doc) doc.innerHTML = renderMarkdown(md);
    } catch (err) {
      const doc = $('#plan-doc', root);
      if (doc) doc.innerHTML = `<div class="notice err">Could not load plan: ${esc(err.message)}</div>`;
    }
  }
  loadProgress();
  loadDoc();

  $('#revise-btn', root).addEventListener('click', async () => {
    const textarea = $('#revise-text', root);
    const feedback = textarea.value.trim();
    if (!feedback) { toast('Describe the change first', 'err'); textarea.focus(); return; }
    const btn = $('#revise-btn', root);
    const consoleEl = $('#revise-console', root);
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = '';
    const tracker = createStageTracker();
    $('#revise-stages', root).replaceWith(tracker.el);
    tracker.el.id = 'revise-stages';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> refining…';
    try {
      const last = await streamNdjson(`/api/plans/${encodeURIComponent(slug)}/revise`, { feedback }, (e) => feedPlanEvent(tracker, consoleEl, e));
      tracker.finish(last?.type === 'done' && last.ok);
      if (last?.type === 'done' && last.ok) {
        toast('Plan refined');
        textarea.value = '';
        if (!reloading) { reloading = true; await loadDoc(); reloading = false; }
      } else {
        toast(last?.message || 'Refine failed', 'err');
        if (last?.message) appendConsoleLine(consoleEl, last.message, true);
      }
    } catch (err) {
      tracker.finish(false);
      toast(err.message, 'err');
      appendConsoleLine(consoleEl, err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add & refine';
    }
  });
  return () => {};
}

/* ---------------------------------------------------------------- wizard */

function wizardQuestion(q, answers, { hideLabel = false } = {}) {
  const value = answers[q.id];
  const required = q.required ? ' req' : '';
  let control;

  if (q.type === 'select' || q.type === 'multiselect') {
    const selected = Array.isArray(value) ? value.map(String) : value !== undefined ? [String(value)] : [];
    const opts = q.options.map((o) => `
      <button type="button" class="opt" data-value="${esc(o.value)}" aria-pressed="${selected.includes(o.value) ? 'true' : 'false'}">${esc(o.label)}</button>`).join('');
    const known = new Set(q.options.map((o) => o.value));
    const extras = selected.filter((v) => !known.has(v));
    const custom = q.allowOther
      ? `<div class="custom-input"><input type="text" data-role="custom" value="${esc(extras.join(', '))}" placeholder="${q.type === 'multiselect' ? 'other (comma-separated)…' : 'other…'}"></div>`
      : '';
    control = `<div class="opts">${opts}</div>${custom}`;
  } else if (q.type === 'text') {
    control = `<input type="text" data-role="value" value="${esc(value ?? '')}" placeholder="${esc(q.placeholder)}">`;
  } else {
    control = `<textarea data-role="value" placeholder="${esc(q.placeholder)}">${esc(value ?? '')}</textarea>`;
  }

  return `
    <div class="field${required}" data-qid="${esc(q.id)}" data-type="${esc(q.type)}" ${q.required ? 'data-required="1"' : ''}>
      ${hideLabel ? '' : `<label>${esc(q.label)}</label>`}
      ${q.help ? `<span class="hint">${esc(q.help)}</span>` : ''}
      ${control}
    </div>`;
}

function readWizardField(field) {
  const type = field.dataset.type;
  if (type === 'select' || type === 'multiselect') {
    const values = $$('.opt[aria-pressed="true"]', field).map((b) => b.dataset.value);
    const custom = $('[data-role="custom"]', field);
    if (custom && custom.value.trim()) {
      for (const extra of custom.value.split(',').map((s) => s.trim()).filter(Boolean)) values.push(extra);
    }
    if (!values.length) return undefined;
    return type === 'select' ? values[0] : values;
  }
  const input = $('[data-role="value"]', field);
  const v = input ? input.value.trim() : '';
  return v || undefined;
}

// Wizard answers survive reloads/server restarts via localStorage — people
// invest real thought in these; losing them to a refresh is unacceptable.
const WIZARD_DRAFT_KEY = 'planforge-wizard-draft';
function loadWizardDraft() {
  try {
    const raw = localStorage.getItem(WIZARD_DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function saveWizardDraft(answers) {
  try { localStorage.setItem(WIZARD_DRAFT_KEY, JSON.stringify(answers)); } catch { /* private mode */ }
}
function clearWizardDraft() {
  try { localStorage.removeItem(WIZARD_DRAFT_KEY); } catch { /* private mode */ }
}

function renderWizard(root, ctx) {
  root.innerHTML = '<div class="loading-row"><span class="spinner"></span>loading interview…</div>';
  let destroyed = false;
  const answers = loadWizardDraft(); // restore a draft lost to reload/restart
  let stepIndex = 0;
  let steps = [];
  root.addEventListener('click', onOptClick); // delegated once; survives repaints

  (async () => {
    let questions;
    try {
      questions = await apiGet('/api/questions');
    } catch (err) {
      root.innerHTML = `<div class="notice err">Could not load the interview: ${esc(err.message)}</div>`;
      return;
    }
    if (destroyed) return;
    steps = interviewSteps(questions);
    if (!steps.length) {
      root.innerHTML = `
        <a class="backlink" href="#/plans">&larr; All plans</a>
        <div class="notice warn">planning/questions.json was found but no interview questions could be
        read from it — the plan wizard cannot run. Fix the file or remove it to use the built-in interview.</div>`;
      return;
    }
    paint();
  })();

  const totalSteps = () => steps.length + 1; // + review step

  function collectStep() {
    for (const field of $$('.field[data-qid]', root)) {
      const v = readWizardField(field);
      if (v === undefined) delete answers[field.dataset.qid];
      else answers[field.dataset.qid] = v;
    }
    saveWizardDraft(answers);
  }

  function validateStep() {
    let ok = true;
    for (const field of $$('.field[data-required]', root)) {
      if (readWizardField(field) === undefined) {
        field.classList.remove('field-invalid');
        void field.offsetWidth; // restart the shake animation
        field.classList.add('field-invalid');
        ok = false;
      }
    }
    return ok;
  }

  function paint() {
    if (destroyed) return;
    const onReview = stepIndex === steps.length;
    const pct = Math.round(((stepIndex + 1) / totalSteps()) * 100);
    const step = onReview ? null : steps[stepIndex];

    root.innerHTML = `
      <a class="backlink" href="#/plans">&larr; All plans</a>
      <div class="wizard">
        <div class="page-head"><div><h1>New plan</h1>
          <div class="sub">The plan agent turns these answers (plus your stack preferences) into a
          complete build plan with phases of buildable slices.</div></div></div>
        <div class="wizard-progress">
          <span class="step-label">Step ${stepIndex + 1} of ${totalSteps()}</span>
          <span class="track"><i style="width:${pct}%"></i></span>
        </div>
        <div class="card wizard-step" id="wizard-step">
          ${onReview ? reviewHtml() : `
            <h2>${esc(step.title ?? step.id)}</h2>
            ${(step.questions ?? []).map((q) => wizardQuestion(q, answers, {
              hideLabel: step.questions.length === 1 && (q.label ?? q.id) === (step.title ?? step.id),
            })).join('')}
          `}
          <div class="wizard-nav">
            <button class="btn ghost" id="wz-back" ${stepIndex === 0 ? 'disabled' : ''}>&larr; Back</button>
            ${onReview
              ? '<button class="btn primary" id="wz-forge">Forge plan</button>'
              : '<button class="btn primary" id="wz-next">Next &rarr;</button>'}
          </div>
        </div>
      </div>`;

    $('#wz-back', root)?.addEventListener('click', () => {
      collectStep();
      stepIndex = Math.max(0, stepIndex - 1);
      paint();
    });
    $('#wz-next', root)?.addEventListener('click', () => {
      collectStep();
      if (!validateStep()) return;
      stepIndex += 1;
      paint();
      $('#main')?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
    });
    $('#wz-forge', root)?.addEventListener('click', forge);
  }

  function onOptClick(ev) {
    const btn = ev.target.closest('.opt');
    if (!btn) return;
    const field = btn.closest('.field');
    const pressed = btn.getAttribute('aria-pressed') === 'true';
    if (field.dataset.type === 'select') {
      for (const b of $$('.opt', field)) b.setAttribute('aria-pressed', 'false');
      if (!pressed) btn.setAttribute('aria-pressed', 'true');
    } else {
      btn.setAttribute('aria-pressed', String(!pressed));
    }
  }

  function reviewHtml() {
    const items = [];
    for (const step of steps) {
      for (const q of (step.questions ?? [])) {
        const v = answers[q.id];
        const shown = v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
        items.push(`
          <div class="review-item">
            <div class="q">${esc(q.label ?? q.id)}</div>
            <div class="a${shown ? '' : ' unanswered'}">${shown ? esc(shown) : 'skipped'}</div>
          </div>`);
      }
    }
    return `<h2>Review your answers</h2><div class="review-list">${items.join('')}</div>`;
  }

  async function forge() {
    root.innerHTML = `
      <div class="wizard">
        <div class="card forge-progress">
          <div class="anvil">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 16.5h14M8 16.5v-3l-2.6-3h8.1l3.2-2.6 1 2.6-2.5 3H10.5v3"/>
            </svg>
          </div>
          <h2>Forging your plan</h2>
          <div class="sub">The plan goes through several agent passes — draft, a detail pass, then a
          couple of consistency reviews — so each one takes a few minutes. Leave this open.</div>
          <div class="forge-stages" id="forge-stages"></div>
          <div class="console" id="forge-console"></div>
        </div>
      </div>`;
    const consoleEl = $('#forge-console', root);
    const tracker = createStageTracker();
    $('#forge-stages', root).replaceWith(tracker.el);

    try {
      const last = await streamNdjson('/api/plans', { answers }, (e) => feedPlanEvent(tracker, consoleEl, e));
      tracker.finish(last?.type === 'done' && last.ok);
      if (destroyed) return;
      if (last?.type === 'done' && last.ok) {
        clearWizardDraft();
        toast('Plan forged');
        window.location.hash = last.slug ? `#/plans/${encodeURIComponent(last.slug)}` : '#/plans';
      } else {
        failBack(last?.message || 'The plan agent did not finish cleanly.');
      }
    } catch (err) {
      tracker.finish(false);
      if (!destroyed) failBack(err.message);
    }

    function failBack(message) {
      toast(message, 'err');
      stepIndex = steps.length; // back to review, answers intact
      paint();
      const stepEl = $('#wizard-step', root);
      if (stepEl) stepEl.insertAdjacentHTML('afterbegin', `<div class="notice err">${esc(message)}</div>`);
    }
  }

  return () => { destroyed = true; };
}

/* ----------------------------------------------------------------- entry */

export function renderPlans(root, ctx, params = {}) {
  if (params.mode === 'new') return renderWizard(root, ctx);
  if (params.mode === 'detail') return renderDetail(root, ctx, params.slug);
  return renderList(root, ctx);
}
