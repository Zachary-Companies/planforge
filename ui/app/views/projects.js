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
