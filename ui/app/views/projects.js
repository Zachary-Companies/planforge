// Projects view — the scaffolded projects a run built, with Start / Build /
// Publish buttons and a live log panel. Actions and their commands come from
// the server (detected from each project's package.json + deploy config).
import { apiGet, apiPost, openProjectLog } from '../api.js';
import { $, esc, h, shortRepo, toast } from '../util.js';

const ACTION_META = {
  start: { icon: '▶', hint: 'Run the project locally (a dev server).' },
  build: { icon: '⚙', hint: 'Make a production build.' },
  provision: { icon: '☁', hint: 'Set up the databases, storage, and other resources the app needs.' },
  publish: { icon: '⇧', hint: 'Deploy it to its host.' },
  sync: { icon: '↻', hint: 'Pull the latest built code from GitHub.' },
};

// Pull a localhost URL out of dev-server output so we can offer an Open link.
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"]*)/i;

// Some cloud resources need a one-time setup in the provider's console the
// first time (a region/billing choice PlanForge can't make for you). When a
// failed action's log says so, we surface the console link as a next step
// instead of a raw error.
const SETUP_PHRASES = /has ?n['’]?t been set up|has not been set up|get started|not been enabled|must enable|requires billing|blaze plan|upgrade your project|enable .*in the .*console|permission denied|not authenticated|please (log|sign) ?in|run ['"`]?firebase login/i;
function detectSetupHint(logText) {
  if (!SETUP_PHRASES.test(logText)) return null;
  const urls = logText.match(/https?:\/\/[^\s'"()]+/g) || [];
  // Prefer a console/setup URL over any other.
  const url = urls.find((u) => /console\.(firebase|cloud)\.google|dashboard|vercel\.com|supabase\.com|netlify/.test(u)) || urls[0] || null;
  const auth = /not authenticated|please (log|sign) ?in|run ['"`]?firebase login/i.test(logText);
  const message = auth
    ? "You need to sign in to your cloud provider first. Run the login command it names in a terminal (e.g. firebase login), then press the button again."
    : "This resource needs a one-time setup in your cloud console — pick a region / enable it (and billing if asked). Do that once, then press the button again and PlanForge finishes the rest.";
  return { url, message };
}

export function renderProjects(root, ctx) {
  let stream = null;
  const destroy = () => { if (stream) { stream.close(); stream = null; } };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Projects</h1>
        <div class="sub">The apps your plans built. Run one locally, make a production build, or publish it —
        PlanForge uses the commands from each project's own package.json and deploy config.</div>
      </div>
    </div>
    <div id="project-list" class="loading-row"><span class="spinner"></span>finding projects…</div>`;
  const listEl = $('#project-list', root);

  async function refresh() {
    let projects;
    try {
      ({ projects } = await apiGet('/api/projects'));
    } catch (err) {
      listEl.className = '';
      listEl.innerHTML = `<div class="notice err">Could not list projects: ${esc(err.message)}</div>`;
      return;
    }
    listEl.className = '';
    if (!projects.length) {
      listEl.innerHTML = `<div class="empty-hero">
        <h2>No projects yet</h2>
        <p>Create a plan — PlanForge scaffolds a project folder for it — then run the build pool. Your app shows up here.</p>
        <a class="btn primary" href="#/plans/new">Start a plan</a></div>`;
      return;
    }
    listEl.innerHTML = '';
    for (const p of projects) listEl.appendChild(renderCard(p));
  }

  function renderCard(p) {
    const card = h(`<section class="card project-card">
      <div class="project-head">
        <div>
          <h2>${esc(p.name)}</h2>
          <div class="dim">${p.repo ? `<code>${esc(shortRepo(p.repo))}</code> · ` : ''}${p.exists ? esc(p.kind) + (p.packageManager ? ` · ${esc(p.packageManager)}` : '') : 'not checked out locally yet'}</div>
          ${(p.resources && p.resources.length) ? `<div class="project-resources dim">Needs: ${p.resources.map((r) => esc(r.name)).join(' · ')}</div>` : ''}
        </div>
        <div class="project-actions"></div>
      </div>
      <div class="project-log-wrap" hidden>
        <div class="project-log-bar"><span class="project-log-title"></span>
          <a class="project-open" target="_blank" rel="noopener" hidden>Open ↗</a>
          <button class="btn small project-stop" hidden>Stop</button></div>
        <div class="project-setup-hint" hidden></div>
        <div class="console project-log"></div>
      </div>
    </section>`);
    const actionsEl = card.querySelector('.project-actions');
    const logWrap = card.querySelector('.project-log-wrap');
    const logEl = card.querySelector('.project-log');
    const logTitle = card.querySelector('.project-log-title');
    const openLink = card.querySelector('.project-open');
    const stopBtn = card.querySelector('.project-stop');

    if (!p.exists) {
      actionsEl.innerHTML = '<span class="dim">nothing to run until the pool builds it</span>';
      return card;
    }

    // Insert a banner + Update button when the local folder is behind the
    // remote (the pool merges to GitHub; the built code isn't pulled in yet).
    if (p.syncable || p.hint) {
      const banner = h(`<div class="project-note${p.syncable ? ' project-note-action' : ''}">
        <span>${esc(p.hint || `${p.git.behind} update(s) available on GitHub.`)}</span>
        ${p.syncable ? '<button class="btn small project-update">Update from GitHub</button>' : ''}
      </div>`);
      card.querySelector('.project-head').insertAdjacentElement('afterend', banner);
      banner.querySelector('.project-update')?.addEventListener('click', () => runAction('sync'));
    }

    // Known publish landmines (from detection) — shown before anyone clicks
    // Publish, since the deploy log's own error for these is misleading.
    for (const b of p.publishBlockers || []) {
      const note = h(`<div class="project-note project-note-warn"><span>⚠ Publish will fail: ${esc(b.message)}</span></div>`);
      card.querySelector('.project-head').insertAdjacentElement('afterend', note);
    }

    const runAction = async (action, { existingLogId = null } = {}) => {
      const meta = ACTION_META[action];
      logWrap.hidden = false;
      logEl.textContent = '';
      openLink.hidden = true;
      logTitle.textContent = `${meta.icon} ${action}`;
      destroy();

      let logId = existingLogId;
      if (!logId) {
        if (action === 'publish' && !window.confirm(`Publish ${p.name}? This deploys it to its live host.`)) return;
        card.querySelectorAll('.project-actions button').forEach((b) => { b.disabled = true; });
        try {
          const r = await apiPost(`/api/projects/${encodeURIComponent(p.name)}/action`, { action });
          logId = r.logId;
          if (r.longRunning) stopBtn.hidden = false;
        } catch (err) {
          toast(err.message, 'err');
          card.querySelectorAll('.project-actions button').forEach((b) => { b.disabled = false; });
          return;
        }
      } else {
        stopBtn.hidden = false;
      }

      let sawUrl = false;
      let logText = '';
      let exitOk = true;
      const hintEl = card.querySelector('.project-setup-hint');
      hintEl.hidden = true;
      stream = openProjectLog(p.name, logId, (line) => {
        const exit = line.match(/^@exit\s+(.+)$/);
        if (exit) {
          const ok = exit[1] === '0';
          exitOk = ok;
          stopBtn.hidden = true;
          appendLog(logEl, ok ? `\n✔ ${action} finished` : `\n✖ ${action} exited (${exit[1]})`, !ok);
          if (!ok) {
            const hint = detectSetupHint(logText);
            if (hint) {
              hintEl.innerHTML = `<div class="setup-hint-msg">${esc(hint.message)}</div>${hint.url ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(hint.url)}">Open console ↗</a>` : ''}<button class="btn small setup-retry">Try again</button>`;
              hintEl.querySelector('.setup-retry').addEventListener('click', () => { hintEl.hidden = true; runAction(action); });
              hintEl.hidden = false;
            } else if (action !== 'sync') {
              // Not a console/auth gate — looks like a code or dependency bug.
              // Offer to let the build pool diagnose, repair, and re-verify it.
              hintEl.innerHTML = `<div class="setup-hint-msg">The ${esc(action)} failed on what looks like a code or dependency problem — not something you did. The build pool can fix it: it diagnoses the failure, repairs it, and re-checks that the build and tests pass.</div><button class="btn small primary fix-with-pool">Fix with the build pool ▶</button><button class="btn small setup-retry">Try again</button>`;
              hintEl.querySelector('.setup-retry').addEventListener('click', () => { hintEl.hidden = true; runAction(action); });
              hintEl.querySelector('.fix-with-pool').addEventListener('click', async (e) => {
                e.target.disabled = true;
                try {
                  // Focused repair: verify + fix this one project, not a full plan run.
                  const { id } = await apiPost('/api/runs', { verifyOnly: true, ...(p.repo ? { repo: p.repo } : {}) });
                  toast('Build pool started — it will fix and re-verify');
                  window.location.hash = `#/runs/${encodeURIComponent(id)}`;
                } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
              });
              hintEl.hidden = false;
            }
          }
          return;
        }
        appendLog(logEl, line);
        logText += `${line}\n`;
        if (!sawUrl) {
          const m = line.match(URL_RE);
          if (m) { sawUrl = true; openLink.href = m[1]; openLink.textContent = `Open ${m[1]} ↗`; openLink.hidden = false; }
        }
      }, () => {
        stopBtn.hidden = true;
        card.querySelectorAll('.project-actions button').forEach((b) => { b.disabled = false; });
        // Re-detect on success (state changed: synced, provisioned, built).
        // On failure, keep the card as-is so the setup callout + log survive.
        if (exitOk) refresh();
      });
    };

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try { await apiPost(`/api/projects/${encodeURIComponent(p.name)}/stop`, {}); } catch (err) { toast(err.message, 'err'); }
      stopBtn.disabled = false;
    });

    for (const a of p.actions) {
      const meta = ACTION_META[a.id] ?? { icon: '' };
      const btn = h(`<button class="btn project-btn${a.id === 'publish' ? ' project-publish' : ''}" ${a.available ? '' : 'disabled'}
        title="${esc(a.available ? (a.command || meta.hint) : a.reason)}">${meta.icon} ${esc(a.label)}</button>`);
      if (a.available) btn.addEventListener('click', () => runAction(a.id));
      actionsEl.appendChild(btn);
    }

    // Report a problem — describe what's wrong, drop/paste screenshots, and
    // the build pool gets the report (text + image paths) to fix it.
    const reportToggle = h('<button class="btn project-btn project-report-toggle" title="Report a bug or ask for a feature. Describe it (attach screenshots for bugs) and send it to the build pool — you can add to a run that is already going.">⚑ Report / add a feature</button>');
    actionsEl.appendChild(reportToggle);
    const panel = h(`<div class="project-report" hidden>
      <textarea class="report-text" rows="3" maxlength="2500"
        placeholder="Describe a bug OR a feature to add. For a bug: what you did, what happened, what you expected (paste any error text). For a feature: what it should do."></textarea>
      <div class="report-drop" tabindex="0">Drop screenshots here, paste from the clipboard, or click to choose
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></div>
      <div class="report-thumbs"></div>
      <div class="report-foot">
        <span class="dim report-hint">Screenshots help the pool see exactly what you see (up to 6).</span>
        <button class="btn small report-add-live" hidden>＋ Add to the running build ▶</button>
        <button class="btn small primary report-send">Send to the build pool ▶</button>
      </div>
    </div>`);
    card.querySelector('.project-log-wrap').insertAdjacentElement('beforebegin', panel);
    reportToggle.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) panel.querySelector('.report-text').focus(); });

    // If a run is already going for this repo, offer to add the request to it
    // (built this run, no waiting) instead of only starting a fresh run.
    const addLiveBtn = panel.querySelector('.report-add-live');
    let liveRunId = null;
    const findLiveRun = async () => {
      if (!p.repo) return;
      try {
        const runs = await apiGet('/api/runs');
        const live = (runs || []).find((r) => (r.status === 'running' || r.pidAlive) && (r.runStart?.repos || []).includes(p.repo));
        liveRunId = live ? live.id : null;
        addLiveBtn.hidden = !liveRunId;
      } catch { /* leave the add-to-live button hidden */ }
    };
    reportToggle.addEventListener('click', () => { if (!panel.hidden) void findLiveRun(); });

    const shots = []; // { name, dataBase64, url }
    const thumbsEl = panel.querySelector('.report-thumbs');
    const renderThumbs = () => {
      thumbsEl.innerHTML = '';
      shots.forEach((s, i) => {
        const t = h(`<span class="report-thumb"><img src="${s.url}" alt="${esc(s.name)}"><button title="Remove">×</button></span>`);
        t.querySelector('button').addEventListener('click', () => { shots.splice(i, 1); renderThumbs(); });
        thumbsEl.appendChild(t);
      });
    };
    const addFiles = (files) => {
      for (const f of files) {
        if (!f || !/^image\//.test(f.type)) continue;
        if (shots.length >= 6) { toast('Up to 6 screenshots per report', 'err'); break; }
        if (f.size > 8_000_000) { toast(`${f.name || 'image'} is over 8 MB — skip or shrink it`, 'err'); continue; }
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result);
          shots.push({ name: f.name || 'screenshot.png', dataBase64: url.split(',')[1] || '', url });
          renderThumbs();
        };
        reader.readAsDataURL(f);
      }
    };
    const drop = panel.querySelector('.report-drop');
    const fileInput = drop.querySelector('input[type=file]');
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...(e.dataTransfer?.files || [])]); });
    panel.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });

    panel.querySelector('.report-send').addEventListener('click', async (e) => {
      const text = panel.querySelector('.report-text').value.trim();
      if (!text) { toast('Describe the problem first — the pool needs your words too', 'err'); return; }
      e.target.disabled = true;
      try {
        const { id } = await apiPost(`/api/projects/${encodeURIComponent(p.name)}/report`, {
          text,
          ...(p.repo ? { repo: p.repo } : {}),
          images: shots.map((s) => ({ name: s.name, dataBase64: s.dataBase64 })),
        });
        toast('Report sent — the build pool is on it');
        window.location.hash = `#/runs/${encodeURIComponent(id)}`;
      } catch (err) {
        toast(err.message, 'err');
        e.target.disabled = false;
      }
    });

    addLiveBtn.addEventListener('click', async (e) => {
      const text = panel.querySelector('.report-text').value.trim();
      if (!text) { toast('Describe the feature/fix to add first', 'err'); return; }
      if (!liveRunId) { toast('No run is active anymore — use "Send to the build pool"', 'err'); await findLiveRun(); return; }
      e.target.disabled = true;
      try {
        // The inbox path is text-only; screenshots go through a fresh report run.
        if (shots.length) toast('Screenshots are only sent with a new run — adding your text to the running build', 'warn');
        await apiPost(`/api/runs/${encodeURIComponent(liveRunId)}/requests`, { text, ...(p.repo ? { repo: p.repo } : {}) });
        toast('Added to the running build — it will plan and build this without a restart');
        window.location.hash = `#/runs/${encodeURIComponent(liveRunId)}`;
      } catch (err) {
        toast(err.message, 'err');
        e.target.disabled = false;
        void findLiveRun(); // the run may have just finished
      }
    });

    // Reconnect to an action already running (e.g. a dev server) after a reload.
    if (p.running) {
      runAction(p.running.action, { existingLogId: p.running.logId });
    }
    return card;
  }

  function appendLog(el, line, isErr = false) {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const div = document.createElement('div');
    if (isErr) div.className = 'log-err';
    div.textContent = line;
    el.appendChild(div);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  refresh();
  return destroy; // the router calls this when navigating away
}
