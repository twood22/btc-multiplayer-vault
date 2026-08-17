BEGIN;

-- Fixed-window counters for sensitive HTTP ceremonies. Subjects are stored as
-- SHA-256 digests, never as invite tokens, credential IDs, or session values.
-- The atomic upsert is safe across horizontally scaled application workers.
CREATE TABLE security_rate_limits (
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{2,63}$'),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
  window_started timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, subject_hash)
);

CREATE INDEX security_rate_limits_cleanup_idx
  ON security_rate_limits (window_started);

INSERT INTO schema_migrations (version) VALUES ('008_security_rate_limits');

COMMIT;
