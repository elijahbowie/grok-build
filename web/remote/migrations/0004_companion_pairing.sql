ALTER TABLE companion_pairs ADD COLUMN pairing_code_hash TEXT;
ALTER TABLE companion_pairs ADD COLUMN pairing_expires_at TEXT;

CREATE UNIQUE INDEX companion_pairing_code ON companion_pairs(pairing_code_hash);
