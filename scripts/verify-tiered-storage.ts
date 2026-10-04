// 分层存储验证脚本：npx esbuild 打包后用 node 运行
//   npx esbuild scripts/verify-tiered-storage.ts --bundle --platform=node --format=esm --outfile=/tmp/verify.mjs && node /tmp/verify.mjs
import assert from 'node:assert'
import type { WindowScene } from '../src/types'

// ---- localStorage shim（可注入失败） ----
let failOnSetCall = -1 // 第 N 次 setItem 抛错，-1 不失败
let setCalls = 0
const store = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    setCalls++
    if (setCalls === failOnSetCall) throw new Error('模拟写入失败（配额等）')
    store.set(k, String(v))
  },
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageShim })

const storage = await import('../src/services/storage.ts')
const {
  HOT_CAPACITY,
  saveScene,
  getHotScenes,
  getColdScenes,
  getScenesByRoute,
  getRouteStats,
  getRandomScene,
  searchColdScenes,
  touchScene,
  toggleStar,
  deleteScene,
  runMigrations,
} = storage

function makeScene(id: string, tsOffsetMin: number, extra: Partial<WindowScene> = {}): WindowScene {
  return {
    id,
    routeName: `${id}路`,
    segment: `区间${id}`,
    seatDirection: '左',
    timestamp: new Date(Date.UTC(2026, 0, 1, 8, tsOffsetMin)).toISOString(),
    weather: '晴',
    signText: '',
    treeDensity: '适中',
    pedestrianStatus: '稀少',
    note: `笔记${id}`,
    ...extra,
  }
}

function reset() {
  store.clear()
  failOnSetCall = -1
  setCalls = 0
}

// ---- 1. 旧数据升级：没有查看时间，按采样时间补齐 ----
reset()
const old1 = makeScene('a', 10)
const old2 = makeScene('b', 20)
delete old1.lastViewedAt
store.set('bus_window_scenes', JSON.stringify([old1, old2]))
runMigrations()
let hot = getHotScenes()
assert.strictEqual(hot.length, 2)
assert.strictEqual(hot[0].lastViewedAt, hot[0].timestamp, '旧数据应按采样时间补上查看时间')
assert.strictEqual(hot[1].lastViewedAt, hot[1].timestamp)
assert.strictEqual(store.get('bus_window_scenes_schema_version'), '2')
console.log('✓ 1. 旧数据升级补齐查看时间')

// ---- 2. 超出容量上限分批挪入冷存（最旧的先走） ----
reset()
for (let i = 0; i < HOT_CAPACITY + 30; i++) {
  saveScene(makeScene(`r${String(i).padStart(3, '0')}`, i))
}
hot = getHotScenes()
let cold = getColdScenes()
// 分批水位线：手边到上限+1 时挪走一批，最终应 ≤ 上限且不丢记录
assert.ok(hot.length <= HOT_CAPACITY, '手边不应超过容量上限')
assert.strictEqual(hot.length + cold.length, HOT_CAPACITY + 30, '记录总数不变')
// 最旧的那些应在冷存，手边留下的都是较新的
const coldIds = new Set(cold.map((s) => s.id))
for (let i = 0; i < cold.length; i++) {
  const id = `r${String(i).padStart(3, '0')}`
  assert.ok(coldIds.has(id), `最旧的 ${id} 应被挪入冷存`)
}
console.log('✓ 2. 超出容量分批挪冷存，最久未看的先走')

// ---- 3. 手边才计入线路统计；时间线/灵感不带冷存；冷存可搜 ----
reset()
saveScene(makeScene('h1', 1, { routeName: '42路', note: '热存笔记' }))
saveScene(makeScene('h2', 2, { routeName: '42路' }))
// 手动塞两条冷存
store.set('bus_window_scenes_cold', JSON.stringify([
  { ...makeScene('c1', 3, { routeName: '42路', note: '冷存里的桂花' }), lastViewedAt: new Date(0).toISOString() },
  { ...makeScene('c2', 4, { routeName: '7路', signText: '冷存招牌' }), lastViewedAt: new Date(0).toISOString() },
]))
const stats = getRouteStats()
assert.deepStrictEqual(stats, [{ name: '42路', count: 2 }], '线路统计只算手边')
assert.strictEqual(getScenesByRoute('42路').length, 2, '时间线只读手边')
assert.strictEqual(getScenesByRoute('7路').length, 0, '冷存线路不进时间线')
for (let i = 0; i < 20; i++) {
  const r = getRandomScene()
  assert.ok(r && !r.id.startsWith('c'), '灵感抽取不带冷存')
}
const found = searchColdScenes('桂花')
assert.strictEqual(found.length, 1)
assert.strictEqual(found[0].id, 'c1', '冷存还能搜到')
assert.strictEqual(searchColdScenes('冷存招牌').length, 1)
assert.strictEqual(searchColdScenes('热存笔记').length, 0, '搜索冷存不该返回热存')
console.log('✓ 3. 统计/时间线/灵感只算手边，冷存可搜')

// ---- 4. 重新打开冷存记录回到手边；腾位置绕开正在看的 ----
reset()
// 填满手边
for (let i = 0; i < HOT_CAPACITY; i++) {
  saveScene(makeScene(`f${String(i).padStart(3, '0')}`, i))
}
store.set('bus_window_scenes_cold', JSON.stringify([
  { ...makeScene('cold-x', 999, { routeName: '冷线' }), lastViewedAt: new Date(0).toISOString() },
]))
touchScene('cold-x')
hot = getHotScenes()
cold = getColdScenes()
assert.ok(hot.some((s) => s.id === 'cold-x'), '重新打开的冷存记录应回到手边')
assert.strictEqual(cold.length, 20, '腾出的一批应进冷存（EVICT_BATCH_SIZE）')
assert.ok(!cold.some((s) => s.id === 'cold-x'), '腾位置要绕开正在看的那条')
assert.strictEqual(hot.length, HOT_CAPACITY + 1 - 20, '手边 = 上限 + 1 - 一批')
console.log('✓ 4. 重新打开回到手边，腾位置绕开正在看的')

// ---- 5. 加重点的冷存记录回到手边；重点记录最后被挪走 ----
reset()
store.set('bus_window_scenes_cold', JSON.stringify([
  { ...makeScene('star-me', 1), lastViewedAt: new Date(0).toISOString() },
]))
toggleStar('star-me')
hot = getHotScenes()
assert.strictEqual(hot.length, 1)
assert.strictEqual(hot[0].starred, true, '加重点的冷存记录应回到手边')
assert.strictEqual(getColdScenes().length, 0)
// 重点保护：填满手边，star-me 查看时间最旧但加了重点，不该先被挪走
for (let i = 0; i < HOT_CAPACITY; i++) {
  saveScene(makeScene(`n${String(i).padStart(3, '0')}`, i + 10))
}
// 此时手边 101 > 100，触发驱逐；star-me 的 lastViewedAt 最旧但 starred
hot = getHotScenes()
assert.ok(hot.some((s) => s.id === 'star-me'), '重点记录应最后被挪走')
assert.ok(hot.length <= HOT_CAPACITY)
// 取消重点（在热存中）不挪走，只是去掉标记
toggleStar('star-me')
assert.ok(getHotScenes().some((s) => s.id === 'star-me'))
assert.ok(!getHotScenes().find((s) => s.id === 'star-me')!.starred)
console.log('✓ 5. 加重点回手边，重点记录最后才被挪走')

// ---- 6. 搬迁失败后能接着重试没搬完的 ----
reset()
// 造 250 条旧数据（无查看时间），超过容量，需要分批搬迁
const legacy: WindowScene[] = []
for (let i = 0; i < 250; i++) {
  const s = makeScene(`L${String(i).padStart(3, '0')}`, i)
  delete s.lastViewedAt
  legacy.push(s)
}
store.set('bus_window_scenes', JSON.stringify(legacy))
// 第一次迁移：第 3 次 setItem 时失败（补齐落盘后，第一批搬到一半）
failOnSetCall = 3
try {
  runMigrations()
  assert.fail('应当抛错')
} catch (e) {
  assert.ok(e instanceof Error && e.message.includes('模拟写入失败'))
}
assert.notStrictEqual(store.get('bus_window_scenes_schema_version'), '2', '失败时不应标记迁移完成')
// 第一批已写入冷存（热存还没来得及删，读取时按热存优先去重，不会双份可见）
const rawCold = JSON.parse(store.get('bus_window_scenes_cold') ?? '[]') as WindowScene[]
assert.strictEqual(rawCold.length, 20, '失败前已搬完的批次应保留在冷存')
assert.strictEqual(
  new Set([...getHotScenes(), ...getColdScenes()].map((s) => s.id)).size,
  250,
  '中途失败不丢记录'
)
// 重试：不再失败，应接着搬完
failOnSetCall = -1
runMigrations()
assert.strictEqual(store.get('bus_window_scenes_schema_version'), '2')
hot = getHotScenes()
cold = getColdScenes()
assert.ok(hot.length <= HOT_CAPACITY)
assert.strictEqual(hot.length + cold.length, 250, '续搬完成后总数不变')
const allIds = new Set([...hot, ...cold].map((s) => s.id))
assert.strictEqual(allIds.size, 250, '搬迁后不丢不重')
assert.ok([...hot, ...cold].every((s) => s.lastViewedAt === s.timestamp), '全部补齐查看时间')
console.log('✓ 6. 搬迁失败后可接着重试，不丢不重')

// ---- 7. 删除对两层都生效 ----
reset()
saveScene(makeScene('d1', 1))
store.set('bus_window_scenes_cold', JSON.stringify([
  { ...makeScene('d2', 2), lastViewedAt: new Date(0).toISOString() },
]))
deleteScene('d1')
deleteScene('d2')
assert.strictEqual(getHotScenes().length, 0)
assert.strictEqual(getColdScenes().length, 0)
console.log('✓ 7. 删除对热存/冷存都生效')

console.log('\n全部通过 ✔')
