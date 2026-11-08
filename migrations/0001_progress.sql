-- One row per account. An account is known only by Google's ID for it (sub), never an email or name.
CREATE TABLE progress (
  sub TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Short-lived records of deleted accounts, so an older session can't recreate one. They hold a
-- keyed hash, not the sub, and go away once every session issued before them has expired.
CREATE TABLE deletion_markers (
  sub_hash TEXT PRIMARY KEY NOT NULL,
  deleted_at INTEGER NOT NULL
) STRICT;

CREATE INDEX deletion_markers_by_time ON deletion_markers (deleted_at);
