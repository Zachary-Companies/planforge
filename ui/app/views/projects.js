// Projects view — the scaffolded projects a run built, with Start / Build /
// Publish buttons and a live log panel. Actions and their commands come from
// the server (detected from each project's package.json + deploy config).
import { apiGet, apiPost, openProjectLog } from '../api.js';
import { $, esc, h, shortRepo, toast } from '../util.js';

const ACTION_META = {
  start: { icon: '▶', hint: 'Run the project locally (a dev server).' },
  build: { icon: '⚙', hint: 'Make a production build.' },
  publish: { icon: '⇧', hint: 'Deploy it to its host.' },
};

// Pull a localhost URL out of dev-server output so we can offer an Open link.
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"]*)/i;

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
        </div>
        <div class="project-actions"></div>
      </div>
      <div class="project-log-wrap" hidden>
        <div class="project-log-bar"><span class="project-log-title"></span>
          <a class="project-open" target="_blank" rel="noopener" hidden>Open ↗</a>
          <button class="btn small project-stop" hidden>Stop</button></div>
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
      stream = openProjectLog(p.name, logId, (line) => {
        const exit = line.match(/^@exit\s+(.+)$/);
        if (exit) {
          const ok = exit[1] === '0';
          appendLog(logEl, ok ? `\n✔ ${action} finished` : `\n✖ ${action} exited (${exit[1]})`, !ok);
          return;
        }
        appendLog(logEl, line);
        if (!sawUrl) {
          const m = line.match(URL_RE);
          if (m) { sawUrl = true; openLink.href = m[1]; openLink.textContent = `Open ${m[1]} ↗`; openLink.hidden = false; }
        }
      }, () => {
        stopBtn.hidden = true;
        card.querySelectorAll('.project-actions button').forEach((b) => { b.disabled = false; });
        refresh();
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
