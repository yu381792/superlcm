import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeEventCounts} from '../src/event-counts.js'

test('message counts remain exact when an already connected legacy worker inserts, ignores, moves, deletes or rolls back records',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'superlcm-counts-')),'counts.sqlite'),db=new DatabaseSync(file)
  db.exec('CREATE TABLE events(session TEXT,ordinal INTEGER,PRIMARY KEY(session,ordinal));INSERT INTO events VALUES(\'a\',0),(\'a\',1),(\'b\',0)')
  const legacy=new DatabaseSync(file),insert=legacy.prepare('INSERT OR IGNORE INTO events VALUES(?,?)')
  const exact=()=>{
    const actual=db.prepare('SELECT session,COUNT(*) AS records FROM events GROUP BY session ORDER BY session').all()
    const counted=db.prepare('SELECT session,records FROM session_event_counts WHERE records>0 ORDER BY session').all()
    assert.deepEqual(counted,actual)
  }
  try {
    initializeEventCounts(db);exact()
    insert.run('a',2);insert.run('a',2);exact()
    legacy.exec("UPDATE events SET session='b',ordinal=1 WHERE session='a' AND ordinal=2");exact()
    legacy.exec("BEGIN;INSERT INTO events VALUES('a',2);ROLLBACK");exact()
    legacy.exec("DELETE FROM events WHERE session='a'");exact()
    insert.run('a',0);exact()
    initializeEventCounts(db);exact()
  }finally{legacy.close();db.close()}
})
