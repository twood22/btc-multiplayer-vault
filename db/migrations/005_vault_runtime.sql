BEGIN;

-- Immutable snapshots of every mainnet coin the application coordinates. A
-- participant still verifies this data against an independent chain source
-- before signing; this table is coordination state, not a trust oracle.
CREATE TABLE vault_coins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  kind text NOT NULL CHECK (kind IN ('vault', 'final_payout')),
  round_id text CHECK (
    round_id IS NULL OR round_id IN ('alicebobcarol', 'alicebob', 'alicecarol', 'bobcarol')
  ),
  owner_participant_id text CHECK (
    owner_participant_id IS NULL OR owner_participant_id IN ('alice', 'bob', 'carol')
  ),
  txid bytea NOT NULL CHECK (octet_length(txid) = 32),
  vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
  value_sats bigint NOT NULL CHECK (value_sats > 0 AND value_sats <= 2100000000000000),
  script_pubkey bytea NOT NULL CHECK (
    octet_length(script_pubkey) = 34
    AND get_byte(script_pubkey, 0) = 81
    AND get_byte(script_pubkey, 1) = 32
  ),
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'spent', 'orphaned')),
  confirmed_height bigint CHECK (confirmed_height IS NULL OR confirmed_height > 0),
  spent_by_txid bytea CHECK (spent_by_txid IS NULL OR octet_length(spent_by_txid) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (txid, vout),
  UNIQUE (id, vault_id),
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  CHECK (
    (kind = 'vault' AND round_id IS NOT NULL AND owner_participant_id IS NULL)
    OR (kind = 'final_payout' AND round_id IS NULL AND owner_participant_id IS NOT NULL)
  ),
  CHECK (
    (status = 'spent' AND spent_by_txid IS NOT NULL)
    OR (status <> 'spent' AND spent_by_txid IS NULL)
  )
);

CREATE UNIQUE INDEX vault_coins_one_current_idx
  ON vault_coins (vault_id) WHERE status = 'current';
CREATE INDEX vault_coins_lookup_idx ON vault_coins (vault_id, status, created_at DESC);

-- A participant's signed claim that an independently queried chain source
-- matched the complete coin snapshot. Proposal readiness requires the relevant
-- signers to have observations for the exact current coin.
CREATE TABLE vault_coin_observations (
  coin_id uuid NOT NULL,
  vault_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  credential_id text NOT NULL,
  snapshot_digest bytea NOT NULL CHECK (octet_length(snapshot_digest) = 32),
  source_origin text NOT NULL CHECK (char_length(source_origin) BETWEEN 1 AND 255),
  confirmations integer NOT NULL CHECK (confirmations >= 0),
  observed_unspent boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coin_id, participant_id),
  FOREIGN KEY (coin_id, vault_id)
    REFERENCES vault_coins(id, vault_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id)
);

CREATE INDEX vault_coin_observations_vault_idx
  ON vault_coin_observations (vault_id, coin_id);

CREATE TABLE vault_coin_observation_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id uuid NOT NULL,
  vault_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  credential_id text NOT NULL,
  challenge text NOT NULL,
  snapshot_digest bytea NOT NULL CHECK (octet_length(snapshot_digest) = 32),
  source_origin text NOT NULL CHECK (char_length(source_origin) BETWEEN 1 AND 255),
  confirmations integer NOT NULL CHECK (confirmations > 0),
  observed_unspent boolean NOT NULL CHECK (observed_unspent = true),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (coin_id, vault_id)
    REFERENCES vault_coins(id, vault_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id)
);

CREATE INDEX vault_coin_observation_challenges_expiry_idx
  ON vault_coin_observation_challenges (expires_at);

CREATE TABLE vault_transaction_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  input_coin_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('solo', 'cooperative', 'recovery', 'final_sweep')),
  round_id text CHECK (
    round_id IS NULL OR round_id IN ('alicebobcarol', 'alicebob', 'alicecarol', 'bobcarol')
  ),
  actor_participant_id text CHECK (
    actor_participant_id IS NULL OR actor_participant_id IN ('alice', 'bob', 'carol')
  ),
  proposer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  psbt_base64 text NOT NULL CHECK (char_length(psbt_base64) BETWEEN 20 AND 100000),
  unsigned_txid bytea NOT NULL CHECK (octet_length(unsigned_txid) = 32),
  proposal_digest bytea NOT NULL UNIQUE CHECK (octet_length(proposal_digest) = 32),
  status text NOT NULL DEFAULT 'collecting' CHECK (
    status IN ('collecting', 'finalized', 'broadcast', 'confirmed', 'rejected', 'stale')
  ),
  finalized_tx_hex text CHECK (
    finalized_tx_hex IS NULL
    OR (char_length(finalized_tx_hex) BETWEEN 20 AND 400000 AND finalized_tx_hex ~ '^[0-9a-f]+$')
  ),
  final_txid bytea CHECK (final_txid IS NULL OR octet_length(final_txid) = 32),
  rejection_reason text CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, vault_id),
  UNIQUE (id, vault_id, proposal_digest),
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  FOREIGN KEY (input_coin_id, vault_id)
    REFERENCES vault_coins(id, vault_id) ON DELETE RESTRICT,
  FOREIGN KEY (vault_id, proposer_user_id)
    REFERENCES vault_members(vault_id, user_id),
  CHECK (
    (kind IN ('solo', 'recovery') AND round_id IS NOT NULL AND actor_participant_id IS NOT NULL)
    OR (kind = 'cooperative' AND round_id IS NOT NULL AND actor_participant_id IS NULL)
    OR (kind = 'final_sweep' AND round_id IS NULL AND actor_participant_id IS NOT NULL)
  ),
  CHECK (
    (status IN ('finalized', 'broadcast', 'confirmed')
      AND finalized_tx_hex IS NOT NULL AND final_txid IS NOT NULL)
    OR (status NOT IN ('finalized', 'broadcast', 'confirmed'))
  ),
  CHECK (
    (status IN ('rejected', 'stale') AND rejection_reason IS NOT NULL)
    OR (status NOT IN ('rejected', 'stale') AND rejection_reason IS NULL)
  )
);

CREATE UNIQUE INDEX vault_transaction_proposals_one_live_spend_idx
  ON vault_transaction_proposals (input_coin_id)
  WHERE status IN ('collecting', 'finalized', 'broadcast');
CREATE INDEX vault_transaction_proposals_vault_idx
  ON vault_transaction_proposals (vault_id, created_at DESC);

-- Public protocol material only. Secret MuSig2 nonces never belong here; they
-- stay in the participant's browser until consumed by a partial signature.
CREATE TABLE vault_proposal_contributions (
  proposal_id uuid NOT NULL,
  vault_id uuid NOT NULL,
  proposal_digest bytea NOT NULL CHECK (octet_length(proposal_digest) = 32),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  kind text NOT NULL CHECK (
    kind IN ('passkey_approval', 'musig_pubnonce', 'musig_partial', 'recovery_share')
  ),
  payload_json jsonb NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, participant_id, kind),
  FOREIGN KEY (proposal_id, vault_id, proposal_digest)
    REFERENCES vault_transaction_proposals(id, vault_id, proposal_digest) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE
);

CREATE INDEX vault_proposal_contributions_vault_idx
  ON vault_proposal_contributions (vault_id, proposal_id);

INSERT INTO schema_migrations (version) VALUES ('005_vault_runtime');

COMMIT;
