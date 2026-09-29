// server.js - the web server and API for the shift tracker.
require('dotenv').config();
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static('public'));   // serves index.html, app.js, style.css

const LEAD_PIN = process.env.LEAD_PIN || '1234';

// ---------- helpers ----------
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Scheduled hours = shift length minus break. End <= start means the shift crosses midnight.
function expectedHours(shift) {
  let mins = toMin(shift.end_time) - toMin(shift.start_time);
  if (mins <= 0) mins += 24 * 60;
  return Math.max(0, (mins - shift.break_minutes) / 60);
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

// Settings changes need the lead PIN, sent in the "x-lead-pin" header.
function requireLead(req, res, next) {
  if (req.get('x-lead-pin') !== LEAD_PIN) return res.status(403).json({ error: 'Lead PIN is incorrect.' });
  next();
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { teamName: s.teamName || 'My Team', targetPct: Number(s.targetPct) || 85 };
}

// ---------- config (everything the screens need to draw) ----------
app.get('/api/config', (req, res) => {
  res.json({
    ...getSettings(),
    shifts: db.prepare('SELECT * FROM shifts WHERE active = 1 ORDER BY start_time').all()
      .map(s => ({ ...s, expected_hours: expectedHours(s) })),
    members: db.prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY name').all(),
    categories: db.prepare('SELECT id, name FROM categories WHERE active = 1 ORDER BY name').all(),
  });
});

app.post('/api/lead/check', (req, res) => {
  res.json({ ok: req.body && req.body.pin === LEAD_PIN });
});

// ---------- settings (lead only) ----------
app.put('/api/settings', requireLead, (req, res) => {
  const { teamName, targetPct } = req.body;
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (teamName) upsert.run('teamName', String(teamName).slice(0, 60));
  const t = Number(targetPct);
  if (t >= 1 && t <= 100) upsert.run('targetPct', String(t));
  res.json(getSettings());
});

function validShift(b) {
  return b.name && isTime(b.start_time) && isTime(b.end_time) && Number(b.break_minutes) >= 0;
}
app.post('/api/shifts', requireLead, (req, res) => {
  if (!validShift(req.body)) return res.status(400).json({ error: 'Shift needs a name, start and end times (HH:MM), and a break in minutes.' });
  const { name, start_time, end_time, break_minutes } = req.body;
  const r = db.prepare('INSERT INTO shifts (name, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?)')
    .run(name.trim(), start_time, end_time, Number(break_minutes));
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/shifts/:id', requireLead, (req, res) => {
  if (!validShift(req.body)) return res.status(400).json({ error: 'Shift needs a name, start and end times (HH:MM), and a break in minutes.' });
  const { name, start_time, end_time, break_minutes } = req.body;
  db.prepare('UPDATE shifts SET name = ?, start_time = ?, end_time = ?, break_minutes = ? WHERE id = ?')
    .run(name.trim(), start_time, end_time, Number(break_minutes), req.params.id);
  res.json({ ok: true });
});
// "Delete" hides the shift but keeps old entries that point to it.
app.delete('/api/shifts/:id', requireLead, (req, res) => {
  db.prepare('UPDATE shifts SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/members', requireLead, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a name.' });
  db.prepare('INSERT INTO members (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1').run(name);
  res.json({ ok: true });
});
app.delete('/api/members/:id', requireLead, (req, res) => {
  db.prepare('UPDATE members SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/categories', requireLead, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a category name.' });
  db.prepare('INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1').run(name);
  res.json({ ok: true });
});
app.delete('/api/categories/:id', requireLead, (req, res) => {
  db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- time entries ----------
app.get('/api/entries', (req, res) => {
  const { member_id, date, shift_id } = req.query;
  res.json(db.prepare(`SELECT id, category, task, hours FROM entries
    WHERE member_id = ? AND shift_date = ? AND shift_id = ? ORDER BY id`).all(member_id, date, shift_id));
});

app.get('/api/entries/recent', (req, res) => {
  res.json(db.prepare(`
    SELECT e.shift_date, e.shift_id, s.name AS shift_name,
           SUM(e.hours) AS logged, MAX(e.expected_hours) AS expected
    FROM entries e JOIN shifts s ON s.id = e.shift_id
    WHERE e.member_id = ?
    GROUP BY e.shift_date, e.shift_id
    ORDER BY e.shift_date DESC LIMIT 10`).all(req.query.member_id));
});

app.post('/api/entries', (req, res) => {
  const { member_id, shift_date, shift_id, category, task } = req.body;
  const hours = Math.round(Number(req.body.hours) * 100) / 100;
  const member = db.prepare('SELECT id FROM members WHERE id = ? AND active = 1').get(member_id);
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift_id);
  if (!member || !shift || !isDate(shift_date)) return res.status(400).json({ error: 'Pick your name, a shift date, and a shift.' });
  if (!(hours > 0 && hours <= 24)) return res.status(400).json({ error: 'Hours must be between 0 and 24.' });

  const already = db.prepare('SELECT COALESCE(SUM(hours), 0) AS h FROM entries WHERE member_id = ? AND shift_date = ? AND shift_id = ?')
    .get(member_id, shift_date, shift_id).h;
  if (already + hours > 24) return res.status(400).json({ error: `That would make ${already + hours} hours for one shift. The maximum is 24.` });

  db.prepare(`INSERT INTO entries (member_id, shift_date, shift_id, category, task, hours, expected_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(member_id, shift_date, shift_id, category || '', String(task || '').slice(0, 200), hours, expectedHours(shift));
  res.json({ ok: true });
});

app.delete('/api/entries/:id', (req, res) => {
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- dashboard ----------
// A "person-shift" is one person working one shift on one date. Scheduled
// hours are counted once per person-shift, however many tasks they logged.
function report(from, to, shiftId) {
  const params = [from, to];
  let filter = '';
  if (shiftId && shiftId !== 'all') { filter = 'AND e.shift_id = ?'; params.push(shiftId); }

  const personShifts = db.prepare(`
    SELECT e.member_id, m.name AS member, e.shift_date, e.shift_id, s.name AS shift,
           SUM(e.hours) AS logged, MAX(e.expected_hours) AS expected
    FROM entries e
    JOIN members m ON m.id = e.member_id
    JOIN shifts  s ON s.id = e.shift_id
    WHERE e.shift_date BETWEEN ? AND ? ${filter}
    GROUP BY e.member_id, e.shift_date, e.shift_id
    ORDER BY e.shift_date DESC, s.start_time`).all(...params);

  const details = db.prepare(`
    SELECT e.shift_date, s.name AS shift, m.name AS member, e.category, e.task, e.hours
    FROM entries e JOIN members m ON m.id = e.member_id JOIN shifts s ON s.id = e.shift_id
    WHERE e.shift_date BETWEEN ? AND ? ${filter}
    ORDER BY e.shift_date, s.start_time, m.name`).all(...params);

  const groupBy = keyFn => {
    const map = new Map();
    for (const r of personShifts) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, { key: k, count: 0, logged: 0, expected: 0 });
      const g = map.get(k); g.count++; g.logged += r.logged; g.expected += r.expected;
    }
    return [...map.values()];
  };

  const categories = new Map();
  details.forEach(d => categories.set(d.category || 'Uncategorised', (categories.get(d.category || 'Uncategorised') || 0) + d.hours));

  const logged = personShifts.reduce((a, r) => a + r.logged, 0);
  const expected = personShifts.reduce((a, r) => a + r.expected, 0);
  return {
    from, to, ...getSettings(),
    totals: { logged, expected, people: new Set(personShifts.map(r => r.member_id)).size, personShifts: personShifts.length },
    byShift: groupBy(r => r.shift),
    byDayShift: groupBy(r => r.shift_date + '|' + r.shift).map(g => {
      const [date, shift] = g.key.split('|'); return { ...g, date, shift };
    }),
    byPerson: groupBy(r => r.member).sort((a, b) => b.logged / (b.expected || 1) - a.logged / (a.expected || 1)),
    byCategory: [...categories.entries()].map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours),
    details,
  };
}

function readRange(req, res) {
  const { from, to, shift_id } = req.query;
  if (!isDate(from) || !isDate(to)) { res.status(400).json({ error: 'from and to must be dates (YYYY-MM-DD).' }); return null; }
  return report(from, to, shift_id);
}

app.get('/api/dashboard', (req, res) => {
  const r = readRange(req, res); if (!r) return;
  delete r.details;
  res.json(r);
});

// ---------- downloads ----------
app.get('/api/export.csv', (req, res) => {
  const r = readRange(req, res); if (!r) return;
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Date', 'Shift', 'Person', 'Category', 'Task', 'Hours'].join(',')]
    .concat(r.details.map(d => [d.shift_date, d.shift, d.member, d.category, d.task, d.hours].map(q).join(',')));
  res.attachment(`shift-report-${r.from}_to_${r.to}.csv`).type('text/csv').send(lines.join('\n'));
});

app.get('/api/export.xlsx', async (req, res) => {
  const r = readRange(req, res); if (!r) return;
  const wb = new ExcelJS.Workbook();
  const pct = (l, e) => (e ? l / e : 0);

  const addSheet = (name, columns, rows, pctKey) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4E6B' } };
    if (pctKey) ws.getColumn(pctKey).numFmt = '0%';
    return ws;
  };

  addSheet('Summary', [
    { header: 'Shift', key: 'shift', width: 22 }, { header: 'Person-shifts', key: 'count', width: 14 },
    { header: 'Hours logged', key: 'logged', width: 14 }, { header: 'Scheduled hours', key: 'expected', width: 16 },
    { header: 'Utilization', key: 'util', width: 12 },
  ], [...r.byShift.map(g => ({ shift: g.key, count: g.count, logged: g.logged, expected: g.expected, util: pct(g.logged, g.expected) })),
      { shift: 'Total', count: r.totals.personShifts, logged: r.totals.logged, expected: r.totals.expected, util: pct(r.totals.logged, r.totals.expected) }],
  'util').lastRow.font = { bold: true };

  addSheet('By shift', [
    { header: 'Date', key: 'date', width: 12 }, { header: 'Shift', key: 'shift', width: 18 }, { header: 'People', key: 'count', width: 8 },
    { header: 'Hours logged', key: 'logged', width: 14 }, { header: 'Scheduled hours', key: 'expected', width: 16 }, { header: 'Utilization', key: 'util', width: 12 },
  ], r.byDayShift.map(g => ({ ...g, util: pct(g.logged, g.expected) })), 'util');

  addSheet('By person', [
    { header: 'Person', key: 'key', width: 24 }, { header: 'Shifts', key: 'count', width: 8 },
    { header: 'Hours logged', key: 'logged', width: 14 }, { header: 'Scheduled hours', key: 'expected', width: 16 }, { header: 'Utilization', key: 'util', width: 12 },
  ], r.byPerson.map(g => ({ ...g, util: pct(g.logged, g.expected) })), 'util');

  addSheet('Details', [
    { header: 'Date', key: 'shift_date', width: 12 }, { header: 'Shift', key: 'shift', width: 18 }, { header: 'Person', key: 'member', width: 24 },
    { header: 'Category', key: 'category', width: 18 }, { header: 'Task', key: 'task', width: 48 }, { header: 'Hours', key: 'hours', width: 8 },
  ], r.details);

  res.attachment(`shift-report-${r.from}_to_${r.to}.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Shift tracker running at http://localhost:${PORT}`));

// Close the database cleanly when Docker (or Ctrl+C) stops the app.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
