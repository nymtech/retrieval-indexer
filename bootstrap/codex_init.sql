BEGIN;

-- 6. Guard: abort everything below if this is not the codex database
DO $$
BEGIN
  IF current_database() <> 'codex' THEN
    RAISE EXCEPTION 'Connected to %, expected codex', current_database();
  END IF;
END $$;

-- 7. Schema privileges (schema stays owned by avnadmin)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;   -- already the default on PG 15+
GRANT USAGE, CREATE ON SCHEMA public TO retrieval_ddl;
GRANT USAGE ON SCHEMA public TO retrieval_writer, retrieval_reader;

-- 8. Baseline privileges on everything retrieval_ddl creates from now on
ALTER DEFAULT PRIVILEGES FOR ROLE retrieval_ddl IN SCHEMA public
  GRANT SELECT ON TABLES TO retrieval_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE retrieval_ddl IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO retrieval_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE retrieval_ddl IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO retrieval_writer;

COMMIT;
