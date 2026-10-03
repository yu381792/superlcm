// Exact per-session counts, maintained by SQLite even when an older installed
// capture worker writes the archive. Backfill and trigger installation share
// one write transaction so concurrent ingestion cannot be counted twice.
export function initializeEventCounts(db) {
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_event_counts'").get())return
  db.exec('BEGIN IMMEDIATE')
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_event_counts'").get())db.exec(`
      CREATE TABLE session_event_counts(session TEXT PRIMARY KEY,records INTEGER NOT NULL CHECK(records>=0));
      INSERT INTO session_event_counts SELECT session,COUNT(*) FROM events GROUP BY session;
      CREATE TRIGGER events_count_insert AFTER INSERT ON events BEGIN
        INSERT INTO session_event_counts VALUES(NEW.session,1) ON CONFLICT(session) DO UPDATE SET records=records+1;
      END;
      CREATE TRIGGER events_count_delete AFTER DELETE ON events BEGIN
        UPDATE session_event_counts SET records=records-1 WHERE session=OLD.session;
      END;
      CREATE TRIGGER events_count_move AFTER UPDATE OF session ON events WHEN OLD.session<>NEW.session BEGIN
        UPDATE session_event_counts SET records=records-1 WHERE session=OLD.session;
        INSERT INTO session_event_counts VALUES(NEW.session,1) ON CONFLICT(session) DO UPDATE SET records=records+1;
      END;
    `)
    db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
}
