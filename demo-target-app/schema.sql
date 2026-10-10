CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password text NOT NULL,
  full_name text NOT NULL,
  date_of_birth date,
  ssn text,
  phone text,
  role text NOT NULL DEFAULT 'patient',
  marketing_emails boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id serial PRIMARY KEY,
  user_id integer REFERENCES users (id),
  full_name text NOT NULL,
  ssn text,
  diagnosis text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE visit_notes (
  id serial PRIMARY KEY,
  patient_id integer REFERENCES patients (id),
  author_id integer REFERENCES users (id),
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appointments (
  id serial PRIMARY KEY,
  user_id integer REFERENCES users (id),
  starts_at timestamptz NOT NULL,
  reminded boolean NOT NULL DEFAULT false
);

CREATE TABLE security_incidents (
  id serial PRIMARY KEY,
  summary text NOT NULL,
  affected_records integer,
  detected_at timestamptz NOT NULL
);
