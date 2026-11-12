-- Princessitas Ceremonias — esquema PostgreSQL
-- Se aplica de forma idempotente (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mon_sat_start TIME NOT NULL,
  mon_sat_end TIME NOT NULL,
  sun_start TIME NOT NULL,
  sun_end TIME NOT NULL,
  tolerance_minutes INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  hire_date DATE,
  birthday DATE,
  rest_day TEXT,
  phone TEXT,
  emergency_contact TEXT,
  nss TEXT,
  rfc TEXT,
  annual_vacation_days INTEGER
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  date DATE NOT NULL,
  check_in TIMESTAMPTZ NOT NULL,
  check_out TIMESTAMPTZ,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'on_time' CHECK (status IN ('on_time', 'late')),
  UNIQUE (employee_id, date)
);

CREATE TABLE IF NOT EXISTS vacations (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'taken')),
  note TEXT,
  days_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS incidents (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('permiso', 'falta')),
  reason TEXT NOT NULL CHECK (reason IN ('enfermedad', 'incapacidad IMSS', 'permiso personal', 'falta injustificada', 'otro')),
  note TEXT,
  voucher_url TEXT
);

CREATE TABLE IF NOT EXISTS overtime (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  date DATE NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  custom BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_vacations_employee ON vacations(employee_id);
CREATE INDEX IF NOT EXISTS idx_incidents_employee_date ON incidents(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_overtime_employee_date ON overtime(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
