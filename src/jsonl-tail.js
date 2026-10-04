import { openSync, readSync, closeSync } from 'node:fs'

// Read complete records without loading a large mirror into memory. Recovery
// never truncates a damaged tail or treats incomplete bytes as committed data.
export function* jsonlTail(file, from = 0) {
  const fd = openSync(file, 'r'), buffer = Buffer.alloc(65536)
  let pending = Buffer.alloc(0), offset = from
  try {
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, offset + pending.length)); ) {
      pending = Buffer.concat([pending, buffer.subarray(0, count)])
      let end
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end)
        offset += end + 1; pending = pending.subarray(end + 1)
        if (!line.length) throw Error('Mirror recovery found an empty record')
        yield { record: JSON.parse(line.toString('utf8')), end: offset }
      }
      if (pending.length > 32e6) throw Error('Mirror recovery record exceeds 32 MB')
    }
    if (pending.length) throw Error('Mirror has a partial tail; capture paused')
  } finally { closeSync(fd) }
}
