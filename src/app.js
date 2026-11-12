// src/app.js — API Express de Princessitas Ceremonias.
// Un solo servicio: /api/* + frontend React (build servido desde server.js).
// Zona horaria de referencia: America/Mexico_City (horarios de tienda).
// Puntualidad: "Tarde X min" = minutos después de (hora de entrada + tolerancia).
// Llegar dentro de la tolerancia (10 min) es "A tiempo" con late_minutes = 0.
const express = require('express');
const bcrypt = require('bcrypt');

const TZ = 'America/Mexico_City';
const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// Normaliza un valor DATE de pg (Date o 'YYYY-MM-DD...') a 'YYYY-MM-DD'.
function toISODate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function toISODateTime(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function parseTimeMinutes(t) {
  if (!t) return null;
  const parts = String(t).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function minutesToHHMM(m) {
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}`;
}

// Fecha/hora actuales en México.
function mexicoNow() {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const dateStr = dateFmt.format(now); // YYYY-MM-DD
  const timeStr = timeFmt.format(now); // HH:MM
  const weekday = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return { dateStr, timeStr, minutes: parseTimeMinutes(timeStr), weekday, now };
}

function addDaysISO(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function iterDates(startStr, endStr) {
  const out = [];
  let cur = startStr;
  while (cur <= endStr) {
    out.push(cur);
    cur = addDaysISO(cur, 1);
  }
  return out;
}

// Derecho anual de vacaciones por antigüedad (LFT, reforma 2023):
// 1 año=12, 2=14, 3=16, 4=18, 5=20, y +2 días por cada 5 años después
// (6-10 años=22, 11-15=24, 16-20=26, ...). Menos de 1 año = 0.
function vacationEntitlement(yearsCompleted) {
  if (!yearsCompleted || yearsCompleted < 1) return 0;
  if (yearsCompleted <= 5) return 10 + yearsCompleted * 2;
  return 20 + 2 * Math.ceil((yearsCompleted - 5) / 5);
}

function completedYears(hireDateStr, asOfStr) {
  if (!hireDateStr) return 0;
  const h = new Date(`${hireDateStr}T12:00:00Z`);
  const a = new Date(`${asOfStr}T12:00:00Z`);
  let years = a.getUTCFullYear() - h.getUTCFullYear();
  const anniversaryThisYear = new Date(Date.UTC(a.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
  if (a < anniversaryThisYear) years -= 1;
  return Math.max(0, years);
}

// Días laborables de un rango: no cuentan el descanso semanal ni festivos.
function countWorkingDays(startStr, endStr, restDay, holidaySet) {
  if (!startStr || !endStr || startStr > endStr) return 0;
  let n = 0;
  for (const d of iterDates(startStr, endStr)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (restDay && stripAccents(WEEKDAYS_ES[wd]) === stripAccents(restDay)) continue;
    if (holidaySet && holidaySet.has(d)) continue;
    n += 1;
  }
  return n;
}

function isValidTime(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
}
function isValidMonth(v) {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

function createApp(pool) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---- Normalizadores de filas ----
  const normEmployee = (r) => ({
    ...r,
    hire_date: toISODate(r.hire_date),
    birthday: toISODate(r.birthday),
  });
  const normAttendance = (r) => ({
    ...r,
    date: toISODate(r.date),
    check_in: toISODateTime(r.check_in),
    check_out: toISODateTime(r.check_out),
  });
  const normVacation = (r) => ({ ...r, start_date: toISODate(r.start_date), end_date: toISODate(r.end_date) });
  const normIncident = (r) => ({ ...r, date: toISODate(r.date) });
  const normOvertime = (r) => ({ ...r, date: toISODate(r.date) });
  const normHoliday = (r) => ({ ...r, date: toISODate(r.date) });

  async function getHolidaysSet() {
    const r = await pool.query('SELECT date FROM holidays');
    return new Set(r.rows.map((x) => toISODate(x.date)));
  }
  async function getEmployee(id) {
    const r = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    return r.rows[0] ? normEmployee(r.rows[0]) : null;
  }
  async function getBranch(id) {
    const r = await pool.query('SELECT * FROM branches WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  // Saldo de vacaciones de una empleada para un año dado.
  async function vacationBalance(employee, year) {
    const r = await pool.query(
      `SELECT COALESCE(SUM(days_count),0)::int AS used FROM vacations
       WHERE employee_id = $1 AND status IN ('approved','taken')
       AND EXTRACT(YEAR FROM start_date) = $2`,
      [employee.id, year]
    );
    const used = r.rows[0].used || 0;
    let entitlement;
    if (employee.annual_vacation_days != null) {
      entitlement = employee.annual_vacation_days;
    } else if (employee.hire_date) {
      entitlement = vacationEntitlement(completedYears(employee.hire_date, `${year}-12-31`));
    } else {
      entitlement = null; // sin fecha de ingreso: sin definir
    }
    return {
      entitlement,
      used,
      balance: entitlement == null ? null : entitlement - used,
      yearsCompleted: employee.hire_date ? completedYears(employee.hire_date, `${year}-12-31`) : null,
    };
  }

  // ---- PIN de administración ----
  async function getPinHash() {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'admin_pin_hash'");
    return r.rows[0] ? r.rows[0].value : null;
  }
  async function setPinHash(hash) {
    await pool.query("DELETE FROM settings WHERE key = 'admin_pin_hash'");
    await pool.query("INSERT INTO settings (key, value) VALUES ('admin_pin_hash', $1)", [hash]);
  }
  function pinFromRequest(req) {
    return req.headers['x-admin-pin'] || req.query.pin || (req.body && req.body.pin) || null;
  }
  async function requireAdmin(req, res, next) {
    try {
      const hash = await getPinHash();
      if (!hash) return res.status(401).json({ ok: false, error: 'PIN de administración no configurado todavía.' });
      const pin = pinFromRequest(req);
      if (!pin) return res.status(401).json({ ok: false, error: 'Falta el PIN de administración.' });
      const ok = await bcrypt.compare(String(pin), hash);
      if (!ok) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
      return next();
    } catch (err) {
      return next(err);
    }
  }

  // ================= Salud y tablero público =================
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Tablero público: NUNCA incluye vacaciones ni historial.
  app.get('/api/board', async (req, res, next) => {
    try {
      const { dateStr } = mexicoNow();
      const branches = await pool.query('SELECT * FROM branches ORDER BY id');
      const emps = await pool.query(
        'SELECT * FROM employees WHERE active = TRUE ORDER BY branch_id, name'
      );
      const att = await pool.query('SELECT * FROM attendance WHERE date = $1', [dateStr]);
      const attByEmp = new Map(att.rows.map((a) => [a.employee_id, normAttendance(a)]));
      res.json({
        ok: true,
        date: dateStr,
        branches: branches.rows,
        employees: emps.rows.map((e) => ({
          ...normEmployee(e),
          today: attByEmp.get(e.id) || null,
        })),
      });
    } catch (err) { next(err); }
  });

  // ================= Registro de entrada / salida =================
  app.post('/api/checkin', async (req, res, next) => {
    try {
      const employeeId = parseInt(req.body && req.body.employeeId, 10);
      if (!employeeId) return res.status(400).json({ ok: false, error: 'Falta employeeId.' });
      const employee = await getEmployee(employeeId);
      if (!employee) return res.status(404).json({ ok: false, error: 'Empleada no encontrada.' });
      if (!employee.active) return res.status(400).json({ ok: false, error: 'La empleada no está activa.' });
      const branch = await getBranch(employee.branch_id);
      if (!branch) return res.status(400).json({ ok: false, error: 'Sucursal no encontrada.' });

      const { dateStr, minutes, weekday, now } = mexicoNow();
      const existing = await pool.query(
        'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [employeeId, dateStr]
      );
      if (existing.rows[0]) {
        const rec = normAttendance(existing.rows[0]);
        return res.json({ ok: true, alreadyExists: true, record: rec, status: rec.status, lateMinutes: rec.late_minutes });
      }
      const isSunday = weekday === 0;
      const startMinutes = parseTimeMinutes(isSunday ? branch.sun_start : branch.mon_sat_start);
      const tolerance = branch.tolerance_minutes || 0;
      const lateMinutes = Math.max(0, minutes - (startMinutes + tolerance));
      const status = lateMinutes > 0 ? 'late' : 'on_time';
      const inserted = await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, late_minutes, status)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [employeeId, dateStr, now.toISOString(), lateMinutes, status]
      );
      const rec = normAttendance(inserted.rows[0]);
      return res.json({
        ok: true, alreadyExists: false, record: rec, status, lateMinutes,
        message: status === 'late'
          ? `Tarde ${lateMinutes} min (entrada ${minutesToHHMM(startMinutes)}, tolerancia ${tolerance} min).`
          : 'A tiempo. ¡Buen día!',
      });
    } catch (err) { next(err); }
  });

  app.post('/api/checkout', async (req, res, next) => {
    try {
      const employeeId = parseInt(req.body && req.body.employeeId, 10);
      if (!employeeId) return res.status(400).json({ ok: false, error: 'Falta employeeId.' });
      const { dateStr, now } = mexicoNow();
      const existing = await pool.query(
        'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [employeeId, dateStr]
      );
      if (!existing.rows[0]) {
        return res.status(400).json({ ok: false, error: 'No hay entrada registrada hoy. Primero registra la entrada.' });
      }
      if (existing.rows[0].check_out) {
        return res.status(400).json({ ok: false, error: 'La salida de hoy ya estaba registrada.', record: normAttendance(existing.rows[0]) });
      }
      const updated = await pool.query(
        'UPDATE attendance SET check_out = $1 WHERE id = $2 RETURNING *',
        [now.toISOString(), existing.rows[0].id]
      );
      return res.json({ ok: true, record: normAttendance(updated.rows[0]) });
    } catch (err) { next(err); }
  });

  // ================= PIN =================
  app.post('/api/admin/pin', async (req, res, next) => {
    try {
      const pin = String((req.body && req.body.pin) || '');
      const currentPin = req.body && req.body.currentPin ? String(req.body.currentPin) : null;
      if (!/^\d{4,8}$/.test(pin)) {
        return res.status(400).json({ ok: false, error: 'El PIN debe tener entre 4 y 8 dígitos.' });
      }
      const hash = await getPinHash();
      if (hash) {
        if (!currentPin) return res.status(403).json({ ok: false, error: 'Para cambiar el PIN envía el PIN actual (currentPin).' });
        const ok = await bcrypt.compare(currentPin, hash);
        if (!ok) return res.status(403).json({ ok: false, error: 'El PIN actual es incorrecto.' });
        await setPinHash(await bcrypt.hash(pin, 10));
        return res.json({ ok: true, created: false, message: 'PIN actualizado.' });
      }
      await setPinHash(await bcrypt.hash(pin, 10));
      return res.json({ ok: true, created: true, message: 'PIN creado. Guárdalo bien: es el acceso de Ulises y Yareli a Administración.' });
    } catch (err) { next(err); }
  });

  app.post('/api/admin/verify-pin', async (req, res, next) => {
    try {
      const pin = String((req.body && req.body.pin) || '');
      const hash = await getPinHash();
      // Se responde siempre ok:true con HTTP 200: el cliente (api.js) lanza
      // "Error <status>" cuando data.ok es false, y este endpoint usa
      // pinSet/verified como resultado, no como error. Antes devolvía
      // ok:false con 200 y el primer uso mostraba "Error 200" sin poder
      // crear el PIN.
      if (!hash) return res.json({ ok: true, pinSet: false, verified: false });
      if (!pin) return res.json({ ok: true, pinSet: true, verified: false });
      const verified = await bcrypt.compare(pin, hash);
      return res.json({ ok: true, pinSet: true, verified });
    } catch (err) { next(err); }
  });

  // ================= Administración =================
  app.get('/api/admin/state', requireAdmin, async (req, res, next) => {
    try {
      const { dateStr } = mexicoNow();
      const year = parseInt(dateStr.slice(0, 4), 10);
      const branches = await pool.query('SELECT * FROM branches ORDER BY id');
      const emps = await pool.query('SELECT * FROM employees ORDER BY branch_id, name');
      const employees = emps.rows.map(normEmployee);
      const balances = {};
      for (const e of employees) balances[e.id] = await vacationBalance(e, year);
      const attToday = await pool.query(
        `SELECT a.*, e.name AS employee_name, e.branch_id FROM attendance a
         JOIN employees e ON e.id = a.employee_id WHERE a.date = $1 ORDER BY e.name`,
        [dateStr]
      );
      const history = await pool.query(
        `SELECT a.*, e.name AS employee_name, e.branch_id FROM attendance a
         JOIN employees e ON e.id = a.employee_id ORDER BY a.date DESC, e.name LIMIT 300`
      );
      const vacs = await pool.query(
        `SELECT v.*, e.name AS employee_name FROM vacations v
         JOIN employees e ON e.id = v.employee_id ORDER BY v.start_date DESC`
      );
      const incidents = await pool.query(
        `SELECT i.*, e.name AS employee_name FROM incidents i
         JOIN employees e ON e.id = i.employee_id ORDER BY i.date DESC LIMIT 300`
      );
      const overtimeRows = await pool.query(
        `SELECT o.*, e.name AS employee_name FROM overtime o
         JOIN employees e ON e.id = o.employee_id ORDER BY o.date DESC LIMIT 300`
      );
      const holidays = await pool.query('SELECT * FROM holidays ORDER BY date');
      // Cumpleaños próximos: hoy + próximos 3 días (con vuelta de año).
      const upcomingBirthdays = [];
      for (const e of employees) {
        if (!e.birthday) continue;
        const [, m, d] = e.birthday.split('-').map(Number);
        for (let offset = 0; offset <= 3; offset += 1) {
          const cand = addDaysISO(dateStr, offset);
          const [, cm, cd] = cand.split('-').map(Number);
          if (cm === m && cd === d) {
            upcomingBirthdays.push({ ...e, birthdayDate: cand, inDays: offset });
            break;
          }
        }
      }
      res.json({
        ok: true, date: dateStr, year,
        branches: branches.rows,
        employees: employees.map((e) => ({ ...e, vacation: balances[e.id] })),
        attendanceToday: attToday.rows.map(normAttendance),
        attendanceHistory: history.rows.map(normAttendance),
        vacations: vacs.rows.map(normVacation),
        incidents: incidents.rows.map(normIncident),
        overtime: overtimeRows.rows.map(normOvertime),
        holidays: holidays.rows.map(normHoliday),
        upcomingBirthdays,
      });
    } catch (err) { next(err); }
  });

  // ---- Empleadas ----
  const EMP_FIELDS = ['branch_id', 'name', 'active', 'hire_date', 'birthday', 'rest_day', 'phone', 'emergency_contact', 'nss', 'rfc', 'annual_vacation_days'];
  app.post('/api/admin/employees', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.branch_id) return res.status(400).json({ ok: false, error: 'Faltan nombre y sucursal.' });
      const branch = await getBranch(parseInt(b.branch_id, 10));
      if (!branch) return res.status(400).json({ ok: false, error: 'Sucursal no válida.' });
      const r = await pool.query(
        `INSERT INTO employees (branch_id, name, active, hire_date, birthday, rest_day, phone, emergency_contact, nss, rfc, annual_vacation_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [parseInt(b.branch_id, 10), b.name, b.active !== false, b.hire_date || null, b.birthday || null,
          b.rest_day || null, b.phone || null, b.emergency_contact || null, b.nss || null, b.rfc || null,
          b.annual_vacation_days != null && b.annual_vacation_days !== '' ? parseInt(b.annual_vacation_days, 10) : null]
      );
      return res.status(201).json({ ok: true, employee: normEmployee(r.rows[0]) });
    } catch (err) { next(err); }
  });

  app.patch('/api/admin/employees/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await getEmployee(id);
      if (!existing) return res.status(404).json({ ok: false, error: 'Empleada no encontrada.' });
      const b = req.body || {};
      const sets = []; const vals = []; let i = 1;
      for (const f of EMP_FIELDS) {
        if (b[f] === undefined) continue;
        let v = b[f];
        if (f === 'branch_id' || f === 'annual_vacation_days') v = (v === null || v === '') ? null : parseInt(v, 10);
        if (f === 'active') v = !!v;
        if (['hire_date', 'birthday', 'rest_day', 'phone', 'emergency_contact', 'nss', 'rfc', 'name'].includes(f) && v === '') v = null;
        sets.push(`${f} = $${i}`); vals.push(v); i += 1;
      }
      if (!sets.length) return res.json({ ok: true, employee: existing });
      vals.push(id);
      const r = await pool.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      return res.json({ ok: true, employee: normEmployee(r.rows[0]) });
    } catch (err) { next(err); }
  });

  // ---- Sucursales ----
  app.post('/api/admin/branches', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!b.name || String(b.name).trim() === '') {
        return res.status(400).json({ ok: false, error: 'Falta el nombre de la sucursal.' });
      }
      for (const f of ['mon_sat_start', 'mon_sat_end', 'sun_start', 'sun_end']) {
        if (!isValidTime(b[f])) return res.status(400).json({ ok: false, error: `Horario inválido: ${f} (usa HH:MM).` });
      }
      const tolerance = b.tolerance_minutes != null ? parseInt(b.tolerance_minutes, 10) : 10;
      if (Number.isNaN(tolerance) || tolerance < 0 || tolerance > 120) {
        return res.status(400).json({ ok: false, error: 'Tolerancia inválida (0–120 minutos).' });
      }
      const r = await pool.query(
        `INSERT INTO branches (name, mon_sat_start, mon_sat_end, sun_start, sun_end, tolerance_minutes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [String(b.name).trim(), b.mon_sat_start, b.mon_sat_end, b.sun_start, b.sun_end, tolerance]
      );
      return res.status(201).json({ ok: true, branch: r.rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ ok: false, error: 'Ya existe una sucursal con ese nombre.' });
      return next(err);
    }
  });

  // Actualizar horarios de una sucursal existente.
  app.post('/api/admin/branch-schedule', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const id = parseInt(b.branchId || b.branch_id || b.id, 10);
      if (!id) return res.status(400).json({ ok: false, error: 'Falta branchId.' });
      const branch = await getBranch(id);
      if (!branch) return res.status(404).json({ ok: false, error: 'Sucursal no encontrada.' });
      const sets = []; const vals = []; let i = 1;
      for (const f of ['name', 'mon_sat_start', 'mon_sat_end', 'sun_start', 'sun_end', 'tolerance_minutes']) {
        if (b[f] === undefined) continue;
        if (f.includes('start') || f.includes('end')) {
          if (!isValidTime(b[f])) return res.status(400).json({ ok: false, error: `Horario inválido: ${f}.` });
        }
        if (f === 'tolerance_minutes') {
          const t = parseInt(b[f], 10);
          if (Number.isNaN(t) || t < 0 || t > 120) return res.status(400).json({ ok: false, error: 'Tolerancia inválida.' });
          sets.push(`${f} = $${i}`); vals.push(t); i += 1;
        } else {
          sets.push(`${f} = $${i}`); vals.push(b[f]); i += 1;
        }
      }
      if (!sets.length) return res.json({ ok: true, branch });
      vals.push(id);
      const r = await pool.query(`UPDATE branches SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      return res.json({ ok: true, branch: r.rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ ok: false, error: 'Ya existe una sucursal con ese nombre.' });
      return next(err);
    }
  });

  // ---- Vacaciones ----
  app.post('/api/admin/vacations', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const employee = await getEmployee(parseInt(b.employeeId || b.employee_id, 10));
      if (!employee) return res.status(404).json({ ok: false, error: 'Empleada no encontrada.' });
      const start = toISODate(b.start_date || b.startDate);
      const end = toISODate(b.end_date || b.endDate);
      if (!start || !end || start > end) return res.status(400).json({ ok: false, error: 'Rango de fechas inválido.' });
      const status = ['pending', 'approved', 'rejected', 'taken'].includes(b.status) ? b.status : 'pending';
      const holidays = await getHolidaysSet();
      const days = countWorkingDays(start, end, employee.rest_day, holidays);
      const r = await pool.query(
        `INSERT INTO vacations (employee_id, start_date, end_date, status, note, days_count)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [employee.id, start, end, status, b.note || null, days]
      );
      return res.status(201).json({ ok: true, vacation: normVacation(r.rows[0]) });
    } catch (err) { next(err); }
  });

  app.patch('/api/admin/vacations/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const cur = await pool.query('SELECT * FROM vacations WHERE id = $1', [id]);
      if (!cur.rows[0]) return res.status(404).json({ ok: false, error: 'Vacación no encontrada.' });
      const b = req.body || {};
      const start = b.start_date ? toISODate(b.start_date) : toISODate(cur.rows[0].start_date);
      const end = b.end_date ? toISODate(b.end_date) : toISODate(cur.rows[0].end_date);
      if (start > end) return res.status(400).json({ ok: false, error: 'Rango de fechas inválido.' });
      let days = cur.rows[0].days_count;
      if (b.start_date || b.end_date) {
        const employee = await getEmployee(cur.rows[0].employee_id);
        const holidays = await getHolidaysSet();
        days = countWorkingDays(start, end, employee ? employee.rest_day : null, holidays);
      }
      const status = b.status && ['pending', 'approved', 'rejected', 'taken'].includes(b.status)
        ? b.status : cur.rows[0].status;
      const r = await pool.query(
        `UPDATE vacations SET start_date=$1, end_date=$2, status=$3, note=$4, days_count=$5 WHERE id=$6 RETURNING *`,
        [start, end, status, b.note !== undefined ? b.note : cur.rows[0].note, days, id]
      );
      return res.json({ ok: true, vacation: normVacation(r.rows[0]) });
    } catch (err) { next(err); }
  });

  app.delete('/api/admin/vacations/:id', requireAdmin, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM vacations WHERE id = $1', [parseInt(req.params.id, 10)]);
      return res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---- Permisos y faltas ----
  app.post('/api/admin/incidents', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const employee = await getEmployee(parseInt(b.employeeId || b.employee_id, 10));
      if (!employee) return res.status(404).json({ ok: false, error: 'Empleada no encontrada.' });
      if (!['permiso', 'falta'].includes(b.type)) return res.status(400).json({ ok: false, error: 'type debe ser permiso o falta.' });
      const reasons = ['enfermedad', 'incapacidad IMSS', 'permiso personal', 'falta injustificada', 'otro'];
      if (!reasons.includes(b.reason)) return res.status(400).json({ ok: false, error: 'reason no válido.' });
      const r = await pool.query(
        `INSERT INTO incidents (employee_id, date, type, reason, note, voucher_url)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [employee.id, toISODate(b.date), b.type, b.reason, b.note || null, b.voucher_url || b.voucherUrl || null]
      );
      return res.status(201).json({ ok: true, incident: normIncident(r.rows[0]) });
    } catch (err) { next(err); }
  });

  app.delete('/api/admin/incidents/:id', requireAdmin, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM incidents WHERE id = $1', [parseInt(req.params.id, 10)]);
      return res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---- Horas extra ----
  app.post('/api/admin/overtime', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const employee = await getEmployee(parseInt(b.employeeId || b.employee_id, 10));
      if (!employee) return res.status(404).json({ ok: false, error: 'Empleada no encontrada.' });
      const minutes = parseInt(b.minutes, 10);
      if (Number.isNaN(minutes) || minutes <= 0) return res.status(400).json({ ok: false, error: 'minutes debe ser mayor a 0.' });
      const r = await pool.query(
        'INSERT INTO overtime (employee_id, date, minutes, note) VALUES ($1,$2,$3,$4) RETURNING *',
        [employee.id, toISODate(b.date), minutes, b.note || null]
      );
      return res.status(201).json({ ok: true, overtime: normOvertime(r.rows[0]) });
    } catch (err) { next(err); }
  });

  app.delete('/api/admin/overtime/:id', requireAdmin, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM overtime WHERE id = $1', [parseInt(req.params.id, 10)]);
      return res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---- Festivos ----
  app.post('/api/admin/holidays', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!b.date || !b.name) return res.status(400).json({ ok: false, error: 'Faltan fecha y nombre.' });
      const r = await pool.query(
        'INSERT INTO holidays (date, name, custom) VALUES ($1,$2,$3) RETURNING *',
        [toISODate(b.date), b.name, b.custom !== false]
      );
      return res.status(201).json({ ok: true, holiday: normHoliday(r.rows[0]) });
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ ok: false, error: 'Ya existe un festivo en esa fecha.' });
      return next(err);
    }
  });

  app.delete('/api/admin/holidays/:id', requireAdmin, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM holidays WHERE id = $1', [parseInt(req.params.id, 10)]);
      return res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---- Corrección manual de asistencia ----
  app.post('/api/admin/attendance', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const employee = await getEmployee(parseInt(b.employeeId || b.employee_id, 10));
      if (!employee) return res.status(404).json({ ok: false, error: 'Empleada no encontrada.' });
      const date = toISODate(b.date);
      if (!date) return res.status(400).json({ ok: false, error: 'Falta date.' });
      const status = b.status && ['on_time', 'late'].includes(b.status) ? b.status : 'on_time';
      const lateMinutes = b.late_minutes != null ? parseInt(b.late_minutes, 10)
        : (b.lateMinutes != null ? parseInt(b.lateMinutes, 10) : 0);
      const checkIn = b.check_in || b.checkIn || `${date}T12:00:00.000Z`;
      const checkOut = b.check_out || b.checkOut || null;
      const existing = await pool.query(
        'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [employee.id, date]
      );
      let row;
      if (existing.rows[0]) {
        row = await pool.query(
          `UPDATE attendance SET check_in=$1, check_out=$2, late_minutes=$3, status=$4 WHERE id=$5 RETURNING *`,
          [checkIn, checkOut, lateMinutes, status, existing.rows[0].id]
        );
      } else {
        row = await pool.query(
          `INSERT INTO attendance (employee_id, date, check_in, check_out, late_minutes, status)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [employee.id, date, checkIn, checkOut, lateMinutes, status]
        );
      }
      return res.json({ ok: true, attendance: normAttendance(row.rows[0]) });
    } catch (err) { next(err); }
  });

  app.delete('/api/admin/attendance/:id', requireAdmin, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM attendance WHERE id = $1', [parseInt(req.params.id, 10)]);
      return res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ================= Reporte mensual =================
  async function buildReport(month) {
    const [y, m] = month.split('-').map(Number);
    const start = `${month}-01`;
    const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const lastDay = addDaysISO(end, -1);
    const branches = await pool.query('SELECT * FROM branches ORDER BY id');
    const branchById = new Map(branches.rows.map((b) => [b.id, b]));
    const emps = await pool.query('SELECT * FROM employees ORDER BY branch_id, name');
    const employees = emps.rows.map(normEmployee);
    const holidays = await getHolidaysSet();

    const att = await pool.query(
      'SELECT * FROM attendance WHERE date >= $1 AND date < $2', [start, end]
    );
    const inc = await pool.query(
      'SELECT * FROM incidents WHERE date >= $1 AND date < $2', [start, end]
    );
    const ot = await pool.query(
      'SELECT * FROM overtime WHERE date >= $1 AND date < $2', [start, end]
    );
    const vacs = await pool.query('SELECT * FROM vacations WHERE status IN ($1,$2)', ['approved', 'taken'])
      .catch(async () => pool.query("SELECT * FROM vacations WHERE status IN ('approved','taken')"));
    // Nota: la consulta anterior con $1/$2 en IN funciona en pg; pg-mem la
    // acepta también. El catch es solo un respaldo defensivo.

    const rows = employees.map((e) => {
      const myAtt = att.rows.filter((a) => a.employee_id === e.id);
      const myInc = inc.rows.filter((a) => a.employee_id === e.id);
      const myOt = ot.rows.filter((a) => a.employee_id === e.id);
      const absences = {};
      let permisos = 0;
      for (const i of myInc) {
        if (i.type === 'falta') absences[i.reason] = (absences[i.reason] || 0) + 1;
        else permisos += 1;
      }
      let vacationDays = 0;
      for (const v of vacs.rows.filter((v) => v.employee_id === e.id)) {
        const vs = toISODate(v.start_date); const ve = toISODate(v.end_date);
        const s = vs < start ? start : vs;
        const en = ve > lastDay ? lastDay : ve;
        if (s <= en) vacationDays += countWorkingDays(s, en, e.rest_day, holidays);
      }
      const overtimeMinutes = myOt.reduce((s, o) => s + (o.minutes || 0), 0);
      return {
        employeeId: e.id,
        name: e.name,
        branch: branchById.get(e.branch_id)?.name || '',
        daysWorked: myAtt.length,
        onTime: myAtt.filter((a) => a.status === 'on_time').length,
        late: myAtt.filter((a) => a.status === 'late').length,
        lateMinutes: myAtt.reduce((s, a) => s + (a.late_minutes || 0), 0),
        absences,
        permisos,
        overtimeMinutes,
        overtimeHours: Math.round((overtimeMinutes / 60) * 100) / 100,
        vacationDays,
      };
    });
    return { month, employees: rows };
  }

  function reportToText(report) {
    const [y, m] = report.month.split('-');
    const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const lines = [`*Reporte Princessitas — ${monthNames[parseInt(m, 10)]} ${y}*`, ''];
    for (const e of report.employees) {
      const faltas = Object.entries(e.absences).map(([k, v]) => `${k}: ${v}`).join(', ') || 'ninguna';
      lines.push(
        `• ${e.name} (${e.branch})`,
        `  Trabajados: ${e.daysWorked} · A tiempo: ${e.onTime} · Tardes: ${e.late} (${e.lateMinutes} min)`,
        `  Faltas: ${faltas} · Permisos: ${e.permisos}`,
        `  Horas extra: ${e.overtimeHours} h · Vacaciones en el mes: ${e.vacationDays} días`,
        ''
      );
    }
    return lines.join('\n').trim() + '\n';
  }

  app.get('/api/admin/report', requireAdmin, async (req, res, next) => {
    try {
      const month = req.query.month;
      if (!isValidMonth(month)) return res.status(400).json({ ok: false, error: 'month debe ser YYYY-MM.' });
      const report = await buildReport(month);
      return res.json({ ok: true, ...report });
    } catch (err) { next(err); }
  });

  app.get('/api/admin/report-text', requireAdmin, async (req, res, next) => {
    try {
      const month = req.query.month;
      if (!isValidMonth(month)) return res.status(400).json({ ok: false, error: 'month debe ser YYYY-MM.' });
      const report = await buildReport(month);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(reportToText(report));
    } catch (err) { next(err); }
  });

  // ---- Manejo de errores ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('API error:', err.message);
    res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  });

  return app;
}

module.exports = { createApp, countWorkingDays, vacationEntitlement, completedYears, mexicoNow };
