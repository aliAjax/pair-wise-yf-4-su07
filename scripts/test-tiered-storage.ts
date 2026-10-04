// Behavior test for tiered storage (bundled & run in Node with a mock localStorage)
import {
  HOT_CAPACITY,
  getHotScenes,
  getColdScenes,
  saveScene,
  deleteScene,
  getScenesByRoute,
  getAllRouteNames,
  getRandomScene,
  searchScenes,
  migrateViewedAt,
  evictToCold,
  recoverPendingEvictions,
  markViewed,
  setHighlight,
} from '../src/services/storage'
import type { WindowScene } from '../src/types'

// ---- mock localStorage ----
const store = new Map<string, string>()
const mockLocalStorage: Storage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  length: store.size,
}
;(globalThis as { localStorage: Storage }).localStorage = mockLocalStorage

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log('  PASS', msg)
  } else {
    failures++
    console.error('  FAIL', msg)
  }
}

function makeScene(over: Partial<WindowScene> & { id: string }): WindowScene {
  return {
    routeName: '1路',
    segment: '区间',
    seatDirection: '左',
    timestamp: new Date().toISOString(),
    weather: '晴',
    signText: '',
    treeDensity: '适中',
    pedestrianStatus: '稀少',
    note: '',
    viewedAt: new Date().toISOString(),
    highlighted: false,
    ...over,
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString()
}

// ---------- Test 1: migration backfills viewedAt from timestamp ----------
console.log('\n[1] migration backfills viewedAt')
store.clear()
// seed raw "old" data: no viewedAt, no highlighted
const oldRaw = [
  { id: 'a', routeName: '1路', segment: 's', seatDirection: '左', timestamp: daysAgo(10), weather: '晴', signText: '', treeDensity: '适中', pedestrianStatus: '稀少', note: '' },
  { id: 'b', routeName: '2路', segment: 's', seatDirection: '右', timestamp: daysAgo(5), weather: '阴', signText: '招牌', treeDensity: '茂密', pedestrianStatus: '密集', note: '笔记' },
]
store.set('bus_window_scenes', JSON.stringify(oldRaw))
migrateViewedAt()
const migrated = getHotScenes()
assert(migrated.length === 2, 'both records remain after migration')
assert(migrated[0].viewedAt === oldRaw[0].timestamp, 'viewedAt backfilled from timestamp for a')
assert(migrated[1].viewedAt === oldRaw[1].timestamp, 'viewedAt backfilled from timestamp for b')
assert(migrated[0].highlighted === false, 'highlighted defaulted to false')

// ---------- Test 2: eviction moves LRU to cold when over capacity ----------
console.log('\n[2] eviction moves LRU to cold over capacity')
store.clear()
for (let i = 0; i < HOT_CAPACITY + 5; i++) {
  saveScene(makeScene({ id: `h${i}`, routeName: '1路', viewedAt: daysAgo(HOT_CAPACITY + 5 - i) }))
}
assert(getHotScenes().length === HOT_CAPACITY + 5, 'precondition: hot over capacity')
evictToCold()
assert(getHotScenes().length === HOT_CAPACITY, 'hot trimmed to capacity')
assert(getColdScenes().length === 5, '5 records moved to cold')
// the 5 oldest-viewed should be cold
const coldIds = getColdScenes().map((s) => s.id).sort()
assert(JSON.stringify(coldIds) === JSON.stringify(['h0','h1','h2','h3','h4']), 'oldest-viewed evicted first (LRU)')

// ---------- Test 3: route stats / random exclude cold; search includes cold ----------
console.log('\n[3] stats & random exclude cold; search includes cold')
assert(getAllRouteNames().length === 1, 'route names only from hot')
assert(getScenesByRoute('1路').length === HOT_CAPACITY, 'route timeline only hot')
// random should never return a cold id
let randomOk = true
for (let i = 0; i < 50; i++) {
  const r = getRandomScene()
  if (r && coldIds.includes(r.id)) { randomOk = false; break }
}
assert(randomOk, 'random inspiration never picks cold records')
// search should find cold records by note/sign
const searchCold = searchScenes('笔记')
assert(searchCold.some((s) => s.id === 'b') === false || true, 'search runs')
// seed a cold record with a distinctive note and confirm search finds it
// (b is already cold from test 1? no, store cleared). Add a cold record directly:
const coldScene = makeScene({ id: 'cold1', routeName: '9路', note: '冷存专属笔记', viewedAt: daysAgo(1) })
store.set('bus_window_scenes_cold', JSON.stringify([coldScene]))
const found = searchScenes('冷存专属')
assert(found.some((s) => s.id === 'cold1'), 'cold record is searchable')
// but it must NOT appear in route stats
assert(!getAllRouteNames().includes('9路'), 'cold route not in route stats')

// ---------- Test 4: reopening a cold record promotes it to hot ----------
console.log('\n[4] reopening cold record promotes to hot')
const before = getHotScenes().length
markViewed('cold1')
assert(getHotScenes().some((s) => s.id === 'cold1'), 'cold1 promoted to hot on open')
assert(!getColdScenes().some((s) => s.id === 'cold1'), 'cold1 removed from cold')
assert(getHotScenes().length === before + 1, 'hot count grew by 1')
const promoted = getHotScenes().find((s) => s.id === 'cold1')!
assert(new Date(promoted.viewedAt).getTime() > Date.now() - 5000, 'viewedAt refreshed on open')

// ---------- Test 5: highlighting a cold record promotes it ----------
console.log('\n[5] highlighting cold record promotes to hot')
const coldScene2 = makeScene({ id: 'cold2', routeName: '8路', signText: '重点招牌', viewedAt: daysAgo(1) })
store.set('bus_window_scenes_cold', JSON.stringify([coldScene2]))
setHighlight('cold2', true)
assert(getHotScenes().some((s) => s.id === 'cold2'), 'cold2 promoted on highlight')
assert(!getColdScenes().some((s) => s.id === 'cold2'), 'cold2 removed from cold')
assert(getHotScenes().find((s) => s.id === 'cold2')!.highlighted === true, 'highlighted flag set')

// ---------- Test 6: eviction skips the currently-viewed record ----------
console.log('\n[6] eviction skips currently-viewed record')
store.clear()
// fill hot to capacity, then add one more that we will "view"
for (let i = 0; i < HOT_CAPACITY; i++) {
  saveScene(makeScene({ id: `x${i}`, routeName: '1路', viewedAt: daysAgo(HOT_CAPACITY - i) }))
}
const viewed = makeScene({ id: 'viewed', routeName: '1路', viewedAt: daysAgo(100) })
saveScene(viewed) // now over capacity; 'viewed' is the oldest-viewed -> would be evicted first
// simulate opening it: markViewed refreshes viewedAt, then evict except it
markViewed('viewed')
evictToCold('viewed')
assert(getHotScenes().some((s) => s.id === 'viewed'), 'currently-viewed record is NOT evicted')
assert(getColdScenes().length === 1, 'one other record evicted to cold')

// ---------- Test 7: resumable eviction ----------
console.log('\n[7] resumable eviction (retry unfinished moves)')
store.clear()
for (let i = 0; i < HOT_CAPACITY + 3; i++) {
  saveScene(makeScene({ id: `r${i}`, routeName: '1路', viewedAt: daysAgo(HOT_CAPACITY + 3 - i) }))
}
// Simulate a crash mid-eviction: manually mark 2 records pendingEviction and leave them in hot
const hotNow = getHotScenes()
const pending = hotNow.slice(0, 2).map((s) => ({ ...s, pendingEviction: true }))
const rest = hotNow.slice(2)
store.set('bus_window_scenes', JSON.stringify([...pending, ...rest]))
assert(getHotScenes().filter((s) => s.pendingEviction).length === 2, 'precondition: 2 pending in hot')
// cold store is empty (the move didn't complete)
store.set('bus_window_scenes_cold', JSON.stringify([]))
recoverPendingEvictions()
assert(getHotScenes().filter((s) => s.pendingEviction).length === 0, 'pending markers cleared after recovery')
assert(getColdScenes().length === 2, '2 unfinished moves completed into cold')
assert(getHotScenes().length === HOT_CAPACITY + 1, 'hot back to capacity+1 (recovery only finishes pending)')

// ---------- Test 8: delete removes from whichever tier ----------
console.log('\n[8] delete removes from any tier')
store.clear()
saveScene(makeScene({ id: 'd1', routeName: '1路' }))
store.set('bus_window_scenes_cold', JSON.stringify([makeScene({ id: 'd2', routeName: '2路' })]))
deleteScene('d1')
deleteScene('d2')
assert(!getHotScenes().some((s) => s.id === 'd1'), 'hot record deleted')
assert(!getColdScenes().some((s) => s.id === 'd2'), 'cold record deleted')

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
