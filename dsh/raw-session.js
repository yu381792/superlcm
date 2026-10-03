// Query preparations add synthetic closers to an interrupted cold log. Those
// closers are a view, not persisted originals, and must never be archived.
export async function readRawDshSession(ctx, id) {
  const observed = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
  if (observed.source === 'live') return {
    header: observed.header, events: observed.events,
    inheritedEventCount: observed.inheritedEventCount,
    close: () => observed[Symbol.dispose](),
  }
  observed[Symbol.dispose]()
  const persistence = ctx.get?.('sessionPersistence') || ctx.sessionPersistence
  if (!persistence) throw Error('DSH raw persistence is unavailable; refusing to archive synthetic cold events')
  const handle = await persistence.open(id, 'read')
  try {
    const { events } = await handle.read(0)
    return { header: handle.header, events, inheritedEventCount: handle.inheritedEventCount, close: () => handle.close() }
  } catch (error) { await handle.close(); throw error }
}
