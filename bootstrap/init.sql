-- Run as avnadmin in psql, connected to defaultdb.
-- CREATE DATABASE cannot run inside a transaction block.

-- 1. DDL role (created by avnadmin so it keeps admin rights over it)
CREATE ROLE retrieval_ddl WITH LOGIN PASSWORD 'change_me'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- 2. Database (owned by avnadmin)
CREATE DATABASE codex;

-- 3. Only explicitly granted roles may connect
REVOKE ALL ON DATABASE codex FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE codex TO retrieval_ddl;

-- 4. Switch to the new database; schema grants are per-database
\c codex

-- 5. DDL rights in the public schema (schema stays owned by avnadmin)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;   -- already the default on PG 15+
GRANT USAGE, CREATE ON SCHEMA public TO retrieval_ddl;

-- 6. Resolve unqualified names to public
ALTER ROLE retrieval_ddl IN DATABASE codex SET search_path = public;

-- 7. Recovery path: lets avnadmin act as retrieval_ddl and reassign
--    its objects later (needed explicitly on PG 16+)
GRANT retrieval_ddl TO avnadmin WITH INHERIT TRUE, SET TRUE;

-- 8. Application roles
CREATE ROLE retrieval_writer WITH LOGIN PASSWORD 'change_me_writer'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE retrieval_reader WITH LOGIN PASSWORD 'change_me_reader'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

ALTER ROLE retrieval_reader CONNECTION LIMIT 20;

GRANT CONNECT ON DATABASE codex TO retrieval_writer, retrieval_reader;
GRANT USAGE ON SCHEMA public TO retrieval_writer, retrieval_reader;

ALTER ROLE retrieval_reader IN DATABASE codex SET statement_timeout = '5s';

-- 9. Baseline privileges on every table retrieval_ddl creates from now on
ALTER DEFAULT PRIVILEGES FOR ROLE retrieval_ddl IN SCHEMA public
  GRANT SELECT ON TABLES TO retrieval_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE retrieval_ddl IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO retrieval_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE retrieval_ddl IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO retrieval_writer;
