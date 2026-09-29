// app.js - runs in the browser. Talks to the server's /api endpoints.
const $ = sel => document.querySelector(sel);
const state = { config: null, memberId: localStorage.getItem('memberId') || '', pin: sessionStorage.getItem('leadPin') || '' };

// ---------- small helpers ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hrs = h => (Math.round(h * 100) / 100).toString();
const pct = (l, e) => (e > 0 ? Math.round((l / e) * 100) : 0);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function status(p) { const t = state.config.targetPct; return p >= t ? 'good' : p >= t - 15 ? 'warn' : 'bad'; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t.timer); t.timer = setTimeout(() => t.classList.remove('show'), 2400); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-lead-pin': state.pin, ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function bar(label, logged, expected) {
  const p = pct(logged, expected), t = state.config.targetPct;
  return `<div>
    <div class="bar-head"><span>${label}</span>
      <span>${hrs(logged)} / ${hrs(expected)} h <span class="pill ${status(p)}">${p}%</span></span></div>
    <div class="bar"><span class="${status(p)}" style="width:${Math.min(100, p)}%"></span><i style="left:${Math.min(100, t)}%"></i></div>
  </div>`;
}

// ---------- start-up ----------
async function loadConfig() {
  state.config = await api('/api/config');
  const c = state.config;
  $('#teamName').textContent = c.teamName;
  document.title = `${c.teamName} · Shift Tracker`;

  $('#whoSelect').innerHTML = '<option value="">Select your name</option>' +
    c.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  if (!c.members.some(m => String(m.id) === state.memberId)) state.memberId = '';
  $('#whoSelect').value = state.memberId;

  const shiftOpts = c.shifts.map(s => `<option value="${s.id}">${esc(s.name)} (${s.start_time}–${s.end_time})</option>`).join('');
  const keep = $('#logShift').value;
  $('#logShift').innerHTML = shiftOpts;
  if (keep && c.shifts.some(s => String(s.id) === keep)) $('#logShift').value = keep;
  $('#dashShift').innerHTML = '<option value="all">All shifts</option>' + shiftOpts;
  $('#addCategory').innerHTML = c.categories.map(k => `<option>${esc(k.name)}</option>`).join('');
}

// Pick the shift that's running right now. A night shift after midnight belongs to yesterday's date.
function guessCurrentShift() {
  const now = new Date(), m = now.getHours() * 60 + now.getMinutes(), today = iso(now);
  for (const s of state.config.shifts) {
    const a = toMin(s.start_time), b = toMin(s.end_time);
    if (b > a && m >= a && m < b) return { date: today, id: s.id };
    if (b <= a && m >= a) return { date: today, id: s.id };
    if (b <= a && m < b) return { date: addDays(today, -1), id: s.id };
  }
  return { date: today, id: state.config.shifts[0]?.id };
}

// ---------- LOG TIME ----------
function currentShift() { return state.config.shifts.find(s => String(s.id) === $('#logShift').value); }

async function renderLog() {
  const shift = currentShift();
  $('#overnightHint').hidden = !shift || toMin(shift.end_time) > toMin(shift.start_time);
  const body = $('#logTable tbody');
  if (!state.memberId) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Select your name at the top to log hours.</td></tr>';
    $('#logProgress').innerHTML = ''; $('#recent').innerHTML = ''; return;
  }
  if (!shift) { body.innerHTML = '<tr><td colspan="4" class="empty">No shifts yet. A team lead can add them in Settings.</td></tr>'; return; }

  const q = new URLSearchParams({ member_id: state.memberId, date: $('#logDate').value, shift_id: shift.id });
  const entries = await api('/api/entries?' + q);
  body.innerHTML = entries.length ? entries.map(e => `<tr>
      <td>${esc(e.category)}</td><td>${esc(e.task)}</td><td class="r">${hrs(e.hours)}</td>
      <td class="r"><button class="btn small" data-del="${e.id}" aria-label="Delete this entry">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No hours logged for this shift yet. Add your first task below.</td></tr>';

  const logged = entries.reduce((a, e) => a + e.hours, 0);
  $('#logProgress').innerHTML = bar(`Logged vs. scheduled <span class="hint">(${shift.break_minutes} min break excluded)</span>`, logged, shift.expected_hours);

  const recent = await api('/api/entries/recent?member_id=' + state.memberId);
  $('#recent').innerHTML = recent.length ? `<div class="scroll"><table class="tbl">
    <thead><tr><th>Date</th><th>Shift</th><th class="r">Logged</th><th class="r">Scheduled</th><th class="r">Utilization</th></tr></thead>
    <tbody>${recent.map(r => { const p = pct(r.logged, r.expected); return `<tr>
      <td>${r.shift_date}</td><td>${esc(r.shift_name)}</td><td class="r">${hrs(r.logged)} h</td><td class="r">${hrs(r.expected)} h</td>
      <td class="r"><span class="pill ${status(p)}">${p}%</span></td></tr>`; }).join('')}</tbody></table></div>`
    : '<p class="empty">Nothing logged yet.</p>';
}

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!state.memberId) return toast('Select your name first');
  try {
    await api('/api/entries', { method: 'POST', body: {
      member_id: Number(state.memberId), shift_date: $('#logDate').value, shift_id: Number($('#logShift').value),
      hours: Number($('#addHours').value), category: $('#addCategory').value, task: $('#addTask').value,
    } });
    $('#addHours').value = ''; $('#addTask').value = '';
    toast('Hours added'); renderLog();
  } catch (err) { toast(err.message); }
});

$('#logTable').addEventListener('click', async e => {
  const id = e.target.dataset.del; if (!id) return;
  if (!confirm('Delete this entry?')) return;
  await api('/api/entries/' + id, { method: 'DELETE' });
  toast('Entry deleted'); renderLog();
});

$('#whoSelect').addEventListener('change', e => { state.memberId = e.target.value; localStorage.setItem('memberId', state.memberId); renderLog(); });
$('#logDate').addEventListener('change', renderLog);
$('#logShift').addEventListener('change', renderLog);

// ---------- DASHBOARD ----------
function dashRange() {
  const today = iso(new Date()), d = new Date(), monday = addDays(today, -((d.getDay() + 6) % 7));
  switch ($('#dashPreset').value) {
    case 'today': return [today, today];
    case 'yesterday': return [addDays(today, -1), addDays(today, -1)];
    case 'week': return [monday, today];
    case 'last7': return [addDays(today, -6), today];
    case 'month': return [today.slice(0, 8) + '01', today];
    case 'lastmonth': return [iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), iso(new Date(d.getFullYear(), d.getMonth(), 0))];
    default: return [$('#dashFrom').value || today, $('#dashTo').value || today];
  }
}

async function renderDash() {
  const [from, to] = dashRange();
  const q = new URLSearchParams({ from, to, shift_id: $('#dashShift').value });
  $('#csvLink').href = '/api/export.csv?' + q;
  $('#xlsxLink').href = '/api/export.xlsx?' + q;
  const r = await api('/api/dashboard?' + q);
  const P = pct(r.totals.logged, r.totals.expected);
  const period = from === to ? from : `${from} to ${to}`;

  if (!r.totals.personShifts) {
    $('#dashBody').innerHTML = `<div class="card empty">No hours logged for ${period}. Try a longer period.</div>`; return;
  }
  const catMax = Math.max(...r.byCategory.map(c => c.hours));
  $('#dashBody').innerHTML = `
  <div class="kpis">
    <div class="kpi"><div class="l">Utilization (target ${r.targetPct}%)</div><div class="v t-${status(P)}">${P}%</div></div>
    <div class="kpi"><div class="l">Hours logged</div><div class="v">${hrs(r.totals.logged)}</div></div>
    <div class="kpi"><div class="l">Scheduled hours</div><div class="v">${hrs(r.totals.expected)}</div></div>
    <div class="kpi"><div class="l">People on shift</div><div class="v">${r.totals.people}</div></div>
  </div>
  <div class="card"><h2>By shift, ${period}</h2><div class="bars">
    ${r.byShift.map(g => bar(`${esc(g.key)} <span class="hint">${g.count} person-shift${g.count === 1 ? '' : 's'}</span>`, g.logged, g.expected)).join('')}
  </div></div>
  <div class="card"><h2>Shift by shift</h2><div class="scroll"><table class="tbl">
    <thead><tr><th>Date</th><th>Shift</th><th class="r">People</th><th class="r">Logged</th><th class="r">Scheduled</th><th class="r">Utilization</th></tr></thead>
    <tbody>${r.byDayShift.map(g => { const p = pct(g.logged, g.expected); return `<tr><td>${g.date}</td><td>${esc(g.shift)}</td>
      <td class="r">${g.count}</td><td class="r">${hrs(g.logged)} h</td><td class="r">${hrs(g.expected)} h</td>
      <td class="r"><span class="pill ${status(p)}">${p}%</span></td></tr>`; }).join('')}</tbody></table></div></div>
  <div class="card"><h2>By person</h2><div class="scroll"><table class="tbl">
    <thead><tr><th>Person</th><th class="r">Shifts</th><th class="r">Logged</th><th class="r">Scheduled</th><th class="r">Utilization</th></tr></thead>
    <tbody>${r.byPerson.map(g => { const p = pct(g.logged, g.expected); return `<tr><td>${esc(g.key)}</td><td class="r">${g.count}</td>
      <td class="r">${hrs(g.logged)} h</td><td class="r">${hrs(g.expected)} h</td>
      <td class="r"><span class="pill ${status(p)}">${p}%</span></td></tr>`; }).join('')}</tbody></table></div></div>
  <div class="card"><h2>Where the time went</h2><div class="bars">
    ${r.byCategory.map(c => `<div><div class="bar-head"><span>${esc(c.name)}</span><span>${hrs(c.hours)} h, ${pct(c.hours, r.totals.logged)}%</span></div>
      <div class="bar"><span style="width:${(c.hours / catMax) * 100}%;background:var(--brand)"></span></div></div>`).join('')}
  </div></div>`;
}

$('#dashPreset').addEventListener('change', () => {
  const custom = $('#dashPreset').value === 'custom';
  document.querySelectorAll('.filters .custom').forEach(el => (el.hidden = !custom));
  if (custom) { const t = iso(new Date()); $('#dashFrom').value ||= addDays(t, -6); $('#dashTo').value ||= t; }
  renderDash();
});
['#dashFrom', '#dashTo', '#dashShift'].forEach(s => $(s).addEventListener('change', renderDash));

// ---------- SETTINGS (team leads) ----------
$('#pinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const { ok } = await api('/api/lead/check', { method: 'POST', body: { pin: $('#pinInput').value } });
  if (!ok) return toast('That PIN is incorrect');
  state.pin = $('#pinInput').value; sessionStorage.setItem('leadPin', state.pin);
  renderSettings();
});

function renderSettings() {
  const unlocked = !!state.pin;
  $('#pinCard').hidden = unlocked; $('#settingsBody').hidden = !unlocked;
  if (!unlocked) return;
  const c = state.config;
  $('#settingsBody').innerHTML = `
  <div class="card"><h2>Team</h2>
    <form class="row" id="teamForm">
      <label class="grow">Team name <input id="setName" value="${esc(c.teamName)}" maxlength="60" required></label>
      <label>Target utilization % <input id="setTarget" type="number" min="1" max="100" value="${c.targetPct}" required></label>
      <button class="btn primary">Save team settings</button>
    </form></div>

  <div class="card"><h2>Shifts</h2>
    <p class="hint">Scheduled hours = shift length minus break. If a shift ends at or before its start time, it's treated as overnight.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Start</th><th>End</th><th>Break (min)</th><th class="r">Scheduled</th><th></th></tr></thead>
    <tbody>${c.shifts.map(s => `<tr data-shift="${s.id}">
      <td><input data-f="name" value="${esc(s.name)}" maxlength="40"></td>
      <td><input data-f="start_time" type="time" value="${s.start_time}"></td>
      <td><input data-f="end_time" type="time" value="${s.end_time}"></td>
      <td><input data-f="break_minutes" type="number" min="0" max="240" value="${s.break_minutes}" style="width:90px"></td>
      <td class="r">${hrs(s.expected_hours)} h</td>
      <td class="r"><button class="btn small" data-save-shift>Save</button> <button class="btn small" data-remove-shift>Remove</button></td>
    </tr>`).join('')}</tbody></table></div>
    <form class="row add" id="shiftForm">
      <label class="grow">New shift name <input id="nsName" required maxlength="40"></label>
      <label>Start <input id="nsStart" type="time" required></label>
      <label>End <input id="nsEnd" type="time" required></label>
      <label>Break (min) <input id="nsBreak" type="number" min="0" value="60" required></label>
      <button class="btn primary">Add shift</button>
    </form></div>

  <div class="card"><h2>Team members</h2>
    <div class="list">${c.members.map(m => `<span class="chip">${esc(m.name)}<button data-remove-member="${m.id}" aria-label="Remove ${esc(m.name)}">×</button></span>`).join('') || '<span class="empty">No members yet. Add your team below.</span>'}</div>
    <form class="row" id="memberForm"><label class="grow">Name <input id="nmName" required maxlength="60"></label><button class="btn primary">Add member</button></form></div>

  <div class="card"><h2>Task categories</h2>
    <div class="list">${c.categories.map(k => `<span class="chip">${esc(k.name)}<button data-remove-cat="${k.id}" aria-label="Remove ${esc(k.name)}">×</button></span>`).join('')}</div>
    <form class="row" id="catForm"><label class="grow">Category <input id="ncName" required maxlength="40"></label><button class="btn primary">Add category</button></form></div>

  <p><button class="btn" id="lockBtn">Lock settings</button></p>`;
}

// One click handler for everything inside Settings, so re-rendering doesn't lose listeners.
async function settingsAction(fn, okMsg) {
  try { await fn(); await loadConfig(); renderSettings(); toast(okMsg); }
  catch (err) { toast(err.message); if (/PIN/.test(err.message)) { state.pin = ''; sessionStorage.removeItem('leadPin'); renderSettings(); } }
}
$('#settingsBody').addEventListener('submit', e => {
  e.preventDefault();
  const id = e.target.id;
  if (id === 'teamForm') settingsAction(() => api('/api/settings', { method: 'PUT', body: { teamName: $('#setName').value, targetPct: $('#setTarget').value } }), 'Team settings saved');
  if (id === 'shiftForm') settingsAction(() => api('/api/shifts', { method: 'POST', body: { name: $('#nsName').value, start_time: $('#nsStart').value, end_time: $('#nsEnd').value, break_minutes: $('#nsBreak').value } }), 'Shift added');
  if (id === 'memberForm') settingsAction(() => api('/api/members', { method: 'POST', body: { name: $('#nmName').value } }), 'Member added');
  if (id === 'catForm') settingsAction(() => api('/api/categories', { method: 'POST', body: { name: $('#ncName').value } }), 'Category added');
});
$('#settingsBody').addEventListener('click', e => {
  const t = e.target, row = t.closest('[data-shift]');
  if (t.matches('[data-save-shift]')) {
    const body = {}; row.querySelectorAll('[data-f]').forEach(i => (body[i.dataset.f] = i.value));
    settingsAction(() => api('/api/shifts/' + row.dataset.shift, { method: 'PUT', body }), 'Shift saved');
  }
  if (t.matches('[data-remove-shift]') && confirm('Remove this shift? Hours already logged against it are kept.'))
    settingsAction(() => api('/api/shifts/' + row.dataset.shift, { method: 'DELETE' }), 'Shift removed');
  if (t.dataset.removeMember && confirm('Remove this member? Their logged hours are kept.'))
    settingsAction(() => api('/api/members/' + t.dataset.removeMember, { method: 'DELETE' }), 'Member removed');
  if (t.dataset.removeCat) settingsAction(() => api('/api/categories/' + t.dataset.removeCat, { method: 'DELETE' }), 'Category removed');
  if (t.id === 'lockBtn') { state.pin = ''; sessionStorage.removeItem('leadPin'); renderSettings(); }
});

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b === btn));
  ['log', 'dash', 'settings'].forEach(t => ($('#tab-' + t).hidden = t !== btn.dataset.tab));
  if (btn.dataset.tab === 'log') renderLog();
  if (btn.dataset.tab === 'dash') renderDash();
  if (btn.dataset.tab === 'settings') renderSettings();
}));

(async () => {
  try {
    await loadConfig();
    const g = guessCurrentShift();
    $('#logDate').value = g.date;
    if (g.id) $('#logShift').value = g.id;
    renderLog();
  } catch (err) { toast('Could not reach the server. Is it running?'); }
})();
