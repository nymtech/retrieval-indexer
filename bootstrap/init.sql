-- CREATE DATABASE cannot run inside a transaction block.

-- 1. Roles (created by avnadmin so it keeps admin rights over them)
CREATE ROLE retrieval_ddl WITH LOGIN PASSWORD 'change_me_ddl'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE retrieval_writer WITH LOGIN PASSWORD 'change_me_writer'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE retrieval_reader WITH LOGIN PASSWORD 'change_me_reader'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  CONNECTION LIMIT 20;

-- 2. Database (owned by avnadmin)
CREATE DATABASE codex;

-- 3. Only explicitly granted roles may connect
REVOKE ALL ON DATABASE codex FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE codex TO retrieval_ddl;
GRANT CONNECT ON DATABASE codex TO retrieval_writer, retrieval_reader;

-- 4. Per-role settings
ALTER ROLE retrieval_ddl    IN DATABASE codex SET search_path = public;
ALTER ROLE retrieval_reader IN DATABASE codex SET statement_timeout = '5s';

-- 5. Recovery path: lets avnadmin act as retrieval_ddl and reassign
--    its objects later (also required for step 8)
GRANT retrieval_ddl TO avnadmin WITH INHERIT TRUE, SET TRUE;

-- Optional: stop the application roles connecting to defaultdb by mistake.
-- Check first that nothing else relies on connecting to it.
-- REVOKE CONNECT ON DATABASE defaultdb FROM PUBLIC;
