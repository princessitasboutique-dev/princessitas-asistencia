import React, { useCallback, useEffect, useState } from 'react';
import { api, getPin, setPin } from './api.js';

const REST_DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const INCIDENT_REASONS = ['enfermedad', 'incapacidad IMSS', 'permiso personal', 'falta injustificada', 'otro'];

function fmtTime(t) { return t ? String(t).slice(0, 5) : ''; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthISO() { return new Date().toISOString().slice(0, 7); }

function downloadCSV(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- Tablero público ----------------
function Board({ onAdmin }) {
  const [board, setBoard] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try { setBoard(await api('/api/board')); } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function register(employeeId, kind) {
    setBusy(`${kind}-${employeeId}`);
    setMsg(null);
    try {
      const data = await api(kind === 'in' ? '/api/checkin' : '/api/checkout', { method: 'POST', body: { employeeId } });
      if (kind === 'in') {
        if (data.alreadyExists) setMsg({ kind: 'info', text: `Entrada ya registrada hoy (${data.status === 'late' ? `tarde ${data.lateMinutes} min` : 'a tiempo'}).` });
        else if (data.status === 'late') setMsg({ kind: 'err', text: `Entrada registrada: tarde ${data.lateMinutes} min.` });
        else setMsg({ kind: 'ok', text: 'Entrada registrada: a tiempo. ¡Buen día!' });
      } else {
        setMsg({ kind: 'ok', text: 'Salida registrada. ¡Hasta mañana!' });
      }
      await load();
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
    setBusy(null);
  }

  if (!board) return <p>Cargando tablero…</p>;
  return (
    <div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      <p className="muted">Hoy: {board.date} · Toca tu nombre para registrar. No se muestran vacaciones ni historial aquí.</p>
      {board.branches.map((b) => (
        <section className="branch" key={b.id}>
          <h2>{b.name}</h2>
          <p className="hours">
            Lun–sáb {fmtTime(b.mon_sat_start)}–{fmtTime(b.mon_sat_end)} · Dom {fmtTime(b.sun_start)}–{fmtTime(b.sun_end)} · Tolerancia {b.tolerance_minutes} min
          </p>
          {board.employees.filter((e) => e.branch_id === b.id).map((e) => (
            <div className="emp" key={e.id}>
              <div>
                <div className="name">{e.name}</div>
                <div className="status">
                  {e.today ? (
                    <>
                      Entrada {fmtTime(e.today.check_in.slice(11, 16))} ·{' '}
                      {e.today.status === 'late' ? <span className="badge late">Tarde {e.today.late_minutes} min</span> : <span className="badge ok">A tiempo</span>}
                      {e.today.check_out ? ` · Salida ${fmtTime(e.today.check_out.slice(11, 16))}` : ' · Sin salida'}
                    </>
                  ) : 'Sin entrada hoy'}
                </div>
              </div>
              <div className="btnrow">
                <button disabled={!!busy || !!e.today} onClick={() => register(e.id, 'in')}>Registrar entrada</button>
                <button className="secondary" disabled={!!busy || !e.today || !!e.today.check_out} onClick={() => register(e.id, 'out')}>Registrar salida</button>
              </div>
            </div>
          ))}
        </section>
      ))}
      <p><button className="secondary small" onClick={onAdmin}>Administración</button></p>
    </div>
  );
}

// ---------------- Administración ----------------
function Admin({ onBack }) {
  const [pinInput, setPinInput] = useState('');
  const [authed, setAuthed] = useState(!!getPin());
  const [pinSet, setPinSet] = useState(null); // null = sin saber
  const [msg, setMsg] = useState(null);
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('asistencia');
  const [month, setMonth] = useState(monthISO());
  const [report, setReport] = useState(null);
  const [reportText, setReportText] = useState('');
  const [newPin, setNewPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');

  const loadState = useCallback(async () => {
    const s = await api('/api/admin/state');
    setState(s);
    return s;
  }, []);

  useEffect(() => {
    if (!authed) return;
    loadState().catch((e) => { setMsg({ kind: 'err', text: e.message }); setAuthed(false); setPin(''); });
  }, [authed, loadState]);

  async function login(e) {
    e.preventDefault();
    setMsg(null);
    try {
      if (pinSet === false) {
        // Primer uso: crear el PIN.
        await api('/api/admin/pin', { method: 'POST', body: { pin: pinInput } });
        setPin(pinInput);
        setAuthed(true);
        setMsg({ kind: 'ok', text: 'PIN creado. Guárdalo bien: es el acceso de Ulises y Yareli.' });
      } else {
        const r = await api('/api/admin/verify-pin', { method: 'POST', body: { pin: pinInput } });
        if (r.pinSet === false) { setPinSet(false); setMsg({ kind: 'info', text: 'Aún no hay PIN. Crea uno para entrar a Administración.' }); return; }
        if (!r.ok) { setMsg({ kind: 'err', text: 'PIN incorrecto.' }); return; }
        setPin(pinInput);
        setAuthed(true);
      }
    } catch (err) { setMsg({ kind: 'err', text: err.message }); }
  }

  function logout() { setPin(''); setAuthed(false); setPinInput(''); setState(null); }

  async function refresh(promiseMsg) {
    try { await loadState(); if (promiseMsg) setMsg({ kind: 'ok', text: promiseMsg }); }
    catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }

  async function loadReport() {
    try {
      setReport(await api(`/api/admin/report?month=${month}`));
      setReportText(await api(`/api/admin/report-text?month=${month}`, { text: true }));
      setMsg(null);
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }

  if (!authed) {
    return (
      <div>
        <h2>Administración</h2>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        <form className="card" onSubmit={login}>
          <label>PIN de administración (Ulises y Yareli)</label>
          <input type="password" inputMode="numeric" value={pinInput} onChange={(e) => setPinInput(e.target.value)} placeholder="4 a 8 dígitos" autoComplete="off" />
          <button type="submit">{pinSet === false ? 'Crear PIN y entrar' : 'Entrar'}</button>
          <p className="muted">La primera vez que entres, crea el PIN aquí. Nadie más lo conoce: se guarda cifrado y no viene predefinido.</p>
        </form>
        <p><button className="secondary small" onClick={onBack}>← Volver al tablero</button></p>
      </div>
    );
  }
  if (!state) return <p>Cargando administración…</p>;

  const tabs = [
    ['asistencia', 'Asistencia'], ['vacaciones', 'Vacaciones'], ['incidentes', 'Permisos y faltas'],
    ['overtime', 'Horas extra'], ['festivos', 'Festivos'], ['empleadas', 'Empleadas'],
    ['reporte', 'Reporte'], ['ajustes', 'Ajustes'],
  ];

  return (
    <div>
      <div className="btnrow">
        <button className="secondary small" onClick={onBack}>← Tablero</button>
        <button className="secondary small" onClick={logout}>Salir</button>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {state.upcomingBirthdays?.length > 0 && (
        <div className="banner">
          🎂 <strong>Cumpleaños próximos:</strong>{' '}
          {state.upcomingBirthdays.map((e) => `${e.name} (${e.birthdayDate}${e.inDays === 0 ? ', hoy' : e.inDays === 1 ? ', mañana' : `, en ${e.inDays} días`})`).join(' · ')}
        </div>
      )}
      <div className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'asistencia' && <AsistenciaTab state={state} refresh={refresh} />}
      {tab === 'vacaciones' && <VacacionesTab state={state} refresh={refresh} />}
      {tab === 'incidentes' && <IncidentesTab state={state} refresh={refresh} />}
      {tab === 'overtime' && <OvertimeTab state={state} refresh={refresh} />}
      {tab === 'festivos' && <FestivosTab state={state} refresh={refresh} />}
      {tab === 'empleadas' && <EmpleadasTab state={state} refresh={refresh} />}
      {tab === 'ajustes' && <AjustesTab state={state} refresh={refresh} newPin={newPin} setNewPin={setNewPin} currentPin={currentPin} setCurrentPin={setCurrentPin} />}
      {tab === 'reporte' && (
        <div>
          <h2>Reporte mensual</h2>
          <div className="card">
            <label>Mes</label>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            <div className="btnrow"><button onClick={loadReport}>Ver reporte</button></div>
          </div>
          {report && (
            <>
              <table>
                <thead><tr><th>Empleada</th><th>Trabajados</th><th>A tiempo</th><th>Tardes (min)</th><th>Faltas</th><th>Permisos</th><th>H. extra</th><th>Vacac. mes</th></tr></thead>
                <tbody>
                  {report.employees.map((r) => (
                    <tr key={r.employeeId}>
                      <td>{r.name}<br /><span className="muted">{r.branch}</span></td>
                      <td>{r.daysWorked}</td><td>{r.onTime}</td><td>{r.late} ({r.lateMinutes} min)</td>
                      <td>{Object.entries(r.absences).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}</td>
                      <td>{r.permisos}</td><td>{r.overtimeHours} h</td><td>{r.vacationDays}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="btnrow" style={{ marginTop: 12 }}>
                <button className="secondary" onClick={() => {
                  const head = 'Empleada,Sucursal,Dias trabajados,A tiempo,Tardes,Minutos tarde,Faltas,Permisos,Horas extra,Vacaciones mes\n';
                  const rows = report.employees.map((r) => [
                    `"${r.name}"`, `"${r.branch}"`, r.daysWorked, r.onTime, r.late, r.lateMinutes,
                    `"${Object.entries(r.absences).map(([k, v]) => `${k}: ${v}`).join('; ')}"`, r.permisos, r.overtimeHours, r.vacationDays,
                  ].join(',')).join('\n');
                  downloadCSV(`reporte-${report.month}.csv`, head + rows);
                }}>Exportar CSV</button>
                <button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(reportText); setMsg({ kind: 'ok', text: 'Texto del reporte copiado. Pégalo en el chat.' }); } catch { setMsg({ kind: 'err', text: 'No se pudo copiar; copia el texto de abajo.' }); } }}>Copiar texto para chat</button>
              </div>
              <pre className="card" style={{ whiteSpace: 'pre-wrap' }}>{reportText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AsistenciaTab({ state, refresh }) {
  const [form, setForm] = useState({ employeeId: '', date: todayISO(), checkIn: '', checkOut: '', lateMinutes: 0, status: 'on_time' });
  async function save(e) {
    e.preventDefault();
    try {
      await api('/api/admin/attendance', { method: 'POST', body: { ...form, employeeId: parseInt(form.employeeId, 10), checkIn: form.checkIn ? `${form.date}T${form.checkIn}:00` : undefined, checkOut: form.checkOut ? `${form.date}T${form.checkOut}:00` : null } });
      await refresh('Asistencia guardada.');
    } catch (err) { alert(err.message); }
  }
  return (
    <div>
      <h2>Asistencia de hoy ({state.date})</h2>
      <table>
        <thead><tr><th>Empleada</th><th>Entrada</th><th>Salida</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          {state.attendanceToday.map((a) => (
            <tr key={a.id}>
              <td>{a.employee_name}</td>
              <td>{a.check_in ? a.check_in.slice(11, 16) : '—'}</td>
              <td>{a.check_out ? a.check_out.slice(11, 16) : '—'}</td>
              <td>{a.status === 'late' ? <span className="badge late">Tarde {a.late_minutes} min</span> : <span className="badge ok">A tiempo</span>}</td>
              <td><button className="secondary small" onClick={async () => { if (confirm('¿Eliminar este registro?')) { await api(`/api/admin/attendance/${a.id}`, { method: 'DELETE' }); await refresh('Registro eliminado.'); } }}>Eliminar</button></td>
            </tr>
          ))}
          {state.attendanceToday.length === 0 && <tr><td colSpan="5">Sin registros hoy.</td></tr>}
        </tbody>
      </table>
      <h3>Corrección manual</h3>
      <form className="card" onSubmit={save}>
        <div className="grid2">
          <div><label>Empleada</label>
            <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>
              <option value="">Elige…</option>
              {state.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></div>
          <div><label>Fecha</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></div>
          <div><label>Entrada (hora)</label><input type="time" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} /></div>
          <div><label>Salida (hora)</label><input type="time" value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} /></div>
          <div><label>Minutos tarde</label><input type="number" min="0" value={form.lateMinutes} onChange={(e) => setForm({ ...form, lateMinutes: e.target.value })} /></div>
          <div><label>Estado</label>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="on_time">A tiempo</option><option value="late">Tarde</option>
            </select></div>
        </div>
        <button>Guardar corrección</button>
      </form>
      <h3>Historial reciente</h3>
      <table>
        <thead><tr><th>Fecha</th><th>Empleada</th><th>Entrada</th><th>Salida</th><th>Estado</th></tr></thead>
        <tbody>
          {state.attendanceHistory.slice(0, 60).map((a) => (
            <tr key={a.id}><td>{a.date}</td><td>{a.employee_name}</td><td>{a.check_in?.slice(11, 16)}</td><td>{a.check_out?.slice(11, 16) || '—'}</td><td>{a.status === 'late' ? `Tarde ${a.late_minutes} min` : 'A tiempo'}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VacacionesTab({ state, refresh }) {
  const [form, setForm] = useState({ employeeId: '', start_date: '', end_date: '', note: '' });
  async function create(e) {
    e.preventDefault();
    try {
      await api('/api/admin/vacations', { method: 'POST', body: { ...form, employeeId: parseInt(form.employeeId, 10) } });
      await refresh('Solicitud de vacaciones registrada.');
    } catch (err) { alert(err.message); }
  }
  async function setStatus(v, status) {
    await api(`/api/admin/vacations/${v.id}`, { method: 'PATCH', body: { status } });
    await refresh(`Vacación ${status === 'approved' ? 'aprobada' : status === 'rejected' ? 'rechazada' : 'marcada como tomada'}.`);
  }
  return (
    <div>
      <h2>Vacaciones</h2>
      <h3>Saldos ({state.year})</h3>
      <table>
        <thead><tr><th>Empleada</th><th>Derecho</th><th>Usados</th><th>Saldo</th></tr></thead>
        <tbody>
          {state.employees.map((e) => (
            <tr key={e.id}><td>{e.name}</td><td>{e.vacation.entitlement ?? 'Sin definir'}</td><td>{e.vacation.used}</td><td>{e.vacation.balance ?? '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted">El saldo es el derecho anual (por antigüedad, Ley Federal del Trabajo, o los días anuales definidos en Empleadas) menos los días aprobados/tomados del año. Los días cuentan solo días laborables: no cuentan el descanso semanal ni los festivos.</p>
      <h3>Nueva solicitud</h3>
      <form className="card" onSubmit={create}>
        <div className="grid2">
          <div><label>Empleada</label>
            <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>
              <option value="">Elige…</option>
              {state.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></div>
          <div><label>Nota</label><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Opcional" /></div>
          <div><label>Inicio</label><input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} required /></div>
          <div><label>Fin</label><input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} required /></div>
        </div>
        <button>Registrar solicitud</button>
      </form>
      <h3>Solicitudes</h3>
      <table>
        <thead><tr><th>Empleada</th><th>Rango</th><th>Días</th><th>Estado</th><th>Acciones</th></tr></thead>
        <tbody>
          {state.vacations.map((v) => (
            <tr key={v.id}>
              <td>{v.employee_name}</td><td>{v.start_date} → {v.end_date}</td><td>{v.days_count}</td>
              <td><span className={`badge ${v.status === 'approved' || v.status === 'taken' ? 'ok' : v.status === 'pending' ? 'pending' : 'late'}`}>{v.status}</span></td>
              <td><div className="btnrow">
                <button className="small" onClick={() => setStatus(v, 'approved')}>Aprobar</button>
                <button className="secondary small" onClick={() => setStatus(v, 'rejected')}>Rechazar</button>
                <button className="secondary small" onClick={() => setStatus(v, 'taken')}>Marcar tomadas</button>
                <button className="secondary small" onClick={async () => { if (confirm('¿Eliminar esta solicitud?')) { await api(`/api/admin/vacations/${v.id}`, { method: 'DELETE' }); await refresh('Solicitud eliminada.'); } }}>Eliminar</button>
              </div></td>
            </tr>
          ))}
          {state.vacations.length === 0 && <tr><td colSpan="5">Sin solicitudes.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function IncidentesTab({ state, refresh }) {
  const [form, setForm] = useState({ employeeId: '', date: todayISO(), type: 'falta', reason: 'falta injustificada', note: '' });
  async function create(e) {
    e.preventDefault();
    try {
      await api('/api/admin/incidents', { method: 'POST', body: { ...form, employeeId: parseInt(form.employeeId, 10) } });
      await refresh('Registro guardado.');
    } catch (err) { alert(err.message); }
  }
  return (
    <div>
      <h2>Permisos y faltas</h2>
      <form className="card" onSubmit={create}>
        <div className="grid2">
          <div><label>Empleada</label>
            <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>
              <option value="">Elige…</option>
              {state.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></div>
          <div><label>Fecha</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></div>
          <div><label>Tipo</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="falta">Falta</option><option value="permiso">Permiso</option>
            </select></div>
          <div><label>Motivo</label>
            <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {INCIDENT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select></div>
        </div>
        <label>Nota / justificante</label>
        <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Motivo, folio IMSS, etc." />
        <button>Guardar</button>
      </form>
      <table>
        <thead><tr><th>Fecha</th><th>Empleada</th><th>Tipo</th><th>Motivo</th><th>Nota</th><th></th></tr></thead>
        <tbody>
          {state.incidents.map((i) => (
            <tr key={i.id}><td>{i.date}</td><td>{i.employee_name}</td><td>{i.type}</td><td>{i.reason}</td><td>{i.note || '—'}</td>
              <td><button className="secondary small" onClick={async () => { await api(`/api/admin/incidents/${i.id}`, { method: 'DELETE' }); await refresh('Registro eliminado.'); }}>Eliminar</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OvertimeTab({ state, refresh }) {
  const [form, setForm] = useState({ employeeId: '', date: todayISO(), minutes: 60, note: '' });
  async function create(e) {
    e.preventDefault();
    try {
      await api('/api/admin/overtime', { method: 'POST', body: { ...form, employeeId: parseInt(form.employeeId, 10), minutes: parseInt(form.minutes, 10) } });
      await refresh('Horas extra guardadas.');
    } catch (err) { alert(err.message); }
  }
  return (
    <div>
      <h2>Horas extra</h2>
      <form className="card" onSubmit={create}>
        <div className="grid2">
          <div><label>Empleada</label>
            <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>
              <option value="">Elige…</option>
              {state.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></div>
          <div><label>Fecha</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></div>
          <div><label>Minutos</label><input type="number" min="1" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} required /></div>
          <div><label>Nota</label><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
        </div>
        <button>Guardar</button>
      </form>
      <table>
        <thead><tr><th>Fecha</th><th>Empleada</th><th>Minutos</th><th>Nota</th><th></th></tr></thead>
        <tbody>
          {state.overtime.map((o) => (
            <tr key={o.id}><td>{o.date}</td><td>{o.employee_name}</td><td>{o.minutes}</td><td>{o.note || '—'}</td>
              <td><button className="secondary small" onClick={async () => { await api(`/api/admin/overtime/${o.id}`, { method: 'DELETE' }); await refresh('Registro eliminado.'); }}>Eliminar</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FestivosTab({ state, refresh }) {
  const [form, setForm] = useState({ date: '', name: '' });
  async function create(e) {
    e.preventDefault();
    try {
      await api('/api/admin/holidays', { method: 'POST', body: form });
      await refresh('Festivo agregado.');
    } catch (err) { alert(err.message); }
  }
  return (
    <div>
      <h2>Festivos</h2>
      <p className="muted">Los festivos oficiales de México 2026 y 2027 ya vienen precargados. Aquí puedes agregar festivos propios o eliminar los que no apliquen.</p>
      <form className="card" onSubmit={create}>
        <div className="grid2">
          <div><label>Fecha</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></div>
          <div><label>Nombre</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        </div>
        <button>Agregar festivo</button>
      </form>
      <table>
        <thead><tr><th>Fecha</th><th>Nombre</th><th></th></tr></thead>
        <tbody>
          {state.holidays.map((h) => (
            <tr key={h.id}><td>{h.date}</td><td>{h.name}</td>
              <td><button className="secondary small" onClick={async () => { await api(`/api/admin/holidays/${h.id}`, { method: 'DELETE' }); await refresh('Festivo eliminado.'); }}>Eliminar</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmpleadasTab({ state, refresh }) {
  const empty = { branch_id: '', name: '', active: true, hire_date: '', birthday: '', rest_day: 'domingo', phone: '', emergency_contact: '', nss: '', rfc: '', annual_vacation_days: '' };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  function edit(e) {
    setEditingId(e.id);
    setForm({ branch_id: e.branch_id, name: e.name, active: e.active, hire_date: e.hire_date || '', birthday: e.birthday || '', rest_day: e.rest_day || 'domingo', phone: e.phone || '', emergency_contact: e.emergency_contact || '', nss: e.nss || '', rfc: e.rfc || '', annual_vacation_days: e.annual_vacation_days ?? '' });
    window.scrollTo(0, 0);
  }
  async function save(e) {
    e.preventDefault();
    try {
      const body = { ...form, branch_id: parseInt(form.branch_id, 10), annual_vacation_days: form.annual_vacation_days === '' ? null : parseInt(form.annual_vacation_days, 10) };
      if (editingId) await api(`/api/admin/employees/${editingId}`, { method: 'PATCH', body });
      else await api('/api/admin/employees', { method: 'POST', body });
      setForm(empty); setEditingId(null);
      await refresh(editingId ? 'Empleada actualizada.' : 'Empleada dada de alta.');
    } catch (err) { alert(err.message); }
  }
  return (
    <div>
      <h2>{editingId ? 'Editar empleada' : 'Alta de empleada'}</h2>
      <form className="card" onSubmit={save}>
        <div className="grid2">
          <div><label>Nombre completo</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label>Sucursal</label>
            <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} required>
              <option value="">Elige…</option>
              {state.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          <div><label>Fecha de ingreso</label><input type="date" value={form.hire_date} onChange={(e) => setForm({ ...form, hire_date: e.target.value })} /></div>
          <div><label>Cumpleaños</label><input type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} /></div>
          <div><label>Día de descanso semanal</label>
            <select value={form.rest_day} onChange={(e) => setForm({ ...form, rest_day: e.target.value })}>
              {REST_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select></div>
          <div><label>Días de vacaciones anuales (vacío = por antigüedad LFT)</label><input type="number" min="0" value={form.annual_vacation_days} onChange={(e) => setForm({ ...form, annual_vacation_days: e.target.value })} /></div>
          <div><label>Teléfono</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div><label>Contacto de emergencia</label><input value={form.emergency_contact} onChange={(e) => setForm({ ...form, emergency_contact: e.target.value })} /></div>
          <div><label>NSS</label><input value={form.nss} onChange={(e) => setForm({ ...form, nss: e.target.value })} /></div>
          <div><label>RFC</label><input value={form.rfc} onChange={(e) => setForm({ ...form, rfc: e.target.value })} /></div>
        </div>
        <label><input type="checkbox" style={{ width: 'auto' }} checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Activa</label>
        <div className="btnrow"><button>{editingId ? 'Guardar cambios' : 'Dar de alta'}</button>
          {editingId && <button type="button" className="secondary" onClick={() => { setEditingId(null); setForm(empty); }}>Cancelar</button>}</div>
      </form>
      <table>
        <thead><tr><th>Empleada</th><th>Sucursal</th><th>Descanso</th><th>Ingreso</th><th>Cumpleaños</th><th></th></tr></thead>
        <tbody>
          {state.employees.map((e) => (
            <tr key={e.id}>
              <td>{e.name}{!e.active ? ' (inactiva)' : ''}</td>
              <td>{state.branches.find((b) => b.id === e.branch_id)?.name}</td>
              <td>{e.rest_day || '—'}</td><td>{e.hire_date || '—'}</td><td>{e.birthday || '—'}</td>
              <td><button className="secondary small" onClick={() => edit(e)}>Editar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AjustesTab({ state, refresh, newPin, setNewPin, currentPin, setCurrentPin }) {
  const [sched, setSched] = useState({});
  const [newBranch, setNewBranch] = useState({ name: '', mon_sat_start: '10:00', mon_sat_end: '19:00', sun_start: '10:00', sun_end: '15:30', tolerance_minutes: 10 });

  async function saveSchedule(b) {
    const patch = sched[b.id] || {};
    try {
      await api('/api/admin/branch-schedule', { method: 'POST', body: { branchId: b.id, ...patch } });
      await refresh(`Horario de ${b.name} actualizado.`);
    } catch (err) { alert(err.message); }
  }
  function field(b, key, value) {
    setSched((s) => ({ ...s, [b.id]: { ...(s[b.id] || {}), [key]: value } }));
  }
  function val(b, key) { return (sched[b.id] && sched[b.id][key] !== undefined) ? sched[b.id][key] : b[key]; }

  async function createBranch(e) {
    e.preventDefault();
    try {
      await api('/api/admin/branches', { method: 'POST', body: { ...newBranch, tolerance_minutes: parseInt(newBranch.tolerance_minutes, 10) } });
      setNewBranch({ name: '', mon_sat_start: '10:00', mon_sat_end: '19:00', sun_start: '10:00', sun_end: '15:30', tolerance_minutes: 10 });
      await refresh('Sucursal agregada. Ya puedes asignarle empleadas en la pestaña Empleadas.');
    } catch (err) { alert(err.message); }
  }

  async function changePin(e) {
    e.preventDefault();
    try {
      await api('/api/admin/pin', { method: 'POST', body: { pin: newPin, currentPin } });
      setPin(newPin); setNewPin(''); setCurrentPin('');
      await refresh('PIN actualizado.');
    } catch (err) { alert(err.message); }
  }

  return (
    <div>
      <h2>Ajustes</h2>
      <h3>Horarios por sucursal</h3>
      {state.branches.map((b) => (
        <form className="card" key={b.id} onSubmit={(e) => { e.preventDefault(); saveSchedule(b); }}>
          <strong>{b.name}</strong>
          <div className="grid2">
            <div><label>Lun–sáb entrada</label><input type="time" value={fmtTime(val(b, 'mon_sat_start'))} onChange={(e) => field(b, 'mon_sat_start', e.target.value)} /></div>
            <div><label>Lun–sáb salida</label><input type="time" value={fmtTime(val(b, 'mon_sat_end'))} onChange={(e) => field(b, 'mon_sat_end', e.target.value)} /></div>
            <div><label>Domingo entrada</label><input type="time" value={fmtTime(val(b, 'sun_start'))} onChange={(e) => field(b, 'sun_start', e.target.value)} /></div>
            <div><label>Domingo salida</label><input type="time" value={fmtTime(val(b, 'sun_end'))} onChange={(e) => field(b, 'sun_end', e.target.value)} /></div>
            <div><label>Tolerancia (min)</label><input type="number" min="0" max="120" value={val(b, 'tolerance_minutes')} onChange={(e) => field(b, 'tolerance_minutes', e.target.value)} /></div>
          </div>
          <button>Guardar horario</button>
        </form>
      ))}

      <h3>Agregar sucursal</h3>
      <form className="card" onSubmit={createBranch}>
        <p className="muted">Para abrir una sucursal nueva sin tocar código: créala aquí y luego asígnale empleadas en la pestaña Empleadas.</p>
        <div className="grid2">
          <div><label>Nombre de la sucursal</label><input value={newBranch.name} onChange={(e) => setNewBranch({ ...newBranch, name: e.target.value })} placeholder="Ej. Medrano 62" required /></div>
          <div><label>Tolerancia (min)</label><input type="number" min="0" max="120" value={newBranch.tolerance_minutes} onChange={(e) => setNewBranch({ ...newBranch, tolerance_minutes: e.target.value })} /></div>
          <div><label>Lun–sáb entrada</label><input type="time" value={newBranch.mon_sat_start} onChange={(e) => setNewBranch({ ...newBranch, mon_sat_start: e.target.value })} required /></div>
          <div><label>Lun–sáb salida</label><input type="time" value={newBranch.mon_sat_end} onChange={(e) => setNewBranch({ ...newBranch, mon_sat_end: e.target.value })} required /></div>
          <div><label>Domingo entrada</label><input type="time" value={newBranch.sun_start} onChange={(e) => setNewBranch({ ...newBranch, sun_start: e.target.value })} required /></div>
          <div><label>Domingo salida</label><input type="time" value={newBranch.sun_end} onChange={(e) => setNewBranch({ ...newBranch, sun_end: e.target.value })} required /></div>
        </div>
        <button>Agregar sucursal</button>
      </form>

      <h3>Cambiar PIN de administración</h3>
      <form className="card" onSubmit={changePin}>
        <label>PIN actual</label>
        <input type="password" inputMode="numeric" value={currentPin} onChange={(e) => setCurrentPin(e.target.value)} required />
        <label>PIN nuevo (4 a 8 dígitos)</label>
        <input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} required />
        <button>Cambiar PIN</button>
      </form>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('board');
  return (
    <div className="app">
      <header>
        <h1>Princessitas Ceremonias</h1>
        <span className="muted">Control de asistencia y vacaciones</span>
      </header>
      {view === 'board' ? <Board onAdmin={() => setView('admin')} /> : <Admin onBack={() => setView('board')} />}
      <footer>Princessitas Ceremonias · Horarios en hora de México (America/Mexico_City)</footer>
    </div>
  );
}
