import type { WindowScene, RouteStat } from '@/types'

/**
 * 分层存储：
 * - 热存（手边）：容量受限，时间线 / 灵感抽取 / 线路统计只读这里
 * - 冷存：超出容量上限时分批挪入，仍可搜索；重新打开或加重点会回到手边
 */
const HOT_KEY = 'bus_window_scenes'
const COLD_KEY = 'bus_window_scenes_cold'
const SCHEMA_VERSION_KEY = 'bus_window_scenes_schema_version'
const CURRENT_SCHEMA_VERSION = 2

/** 手边容量上限，超出后分批挪入冷存 */
export const HOT_CAPACITY = 100
/** 每批挪入冷存的条数 */
export const EVICT_BATCH_SIZE = 20

// ---------- 底层读写 ----------

function readList(key: string): WindowScene[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as WindowScene[]) : []
  } catch {
    return []
  }
}

function writeList(key: string, scenes: WindowScene[]): void {
  localStorage.setItem(key, JSON.stringify(scenes))
}

function dedupeById(scenes: WindowScene[]): WindowScene[] {
  const seen = new Set<string>()
  return scenes.filter((s) => {
    if (seen.has(s.id)) return false
    seen.add(s.id)
    return true
  })
}

function viewedAt(scene: WindowScene): number {
  return new Date(scene.lastViewedAt ?? scene.timestamp).getTime()
}

// ---------- 读取（热存优先去重：搬迁中断可能留下两边都有的记录） ----------

/** 手边（热存）记录 */
export function getHotScenes(): WindowScene[] {
  return dedupeById(readList(HOT_KEY))
}

/** 冷存记录；与热存重复时以热存为准 */
export function getColdScenes(): WindowScene[] {
  const hotIds = new Set(readList(HOT_KEY).map((s) => s.id))
  return dedupeById(readList(COLD_KEY)).filter((s) => !hotIds.has(s.id))
}

// ---------- 容量维护：超出上限分批挪入冷存 ----------

/**
 * 挑出一批该挪走的记录：未加重点的优先，同等情况下最久没看的先走；
 * excludeId（正在看的那条）始终绕开。
 */
function pickEvictionBatch(hot: WindowScene[], size: number, excludeId?: string): WindowScene[] {
  return hot
    .filter((s) => s.id !== excludeId)
    .sort((a, b) => {
      if (!!a.starred !== !!b.starred) return a.starred ? 1 : -1
      return viewedAt(a) - viewedAt(b)
    })
    .slice(0, size)
}

/**
 * 手边超出容量上限时，分批挪入冷存。
 * 每批先写冷存再删热存并立即落盘：中途失败时记录可能两边都有（读取时按 id 去重，
 * 不会丢数据），已挪完的批次不会回滚，重试时只接着搬没搬完的。
 */
export function enforceHotCapacity(excludeId?: string): void {
  let hot = dedupeById(readList(HOT_KEY))
  while (hot.length > HOT_CAPACITY) {
    const batch = pickEvictionBatch(hot, EVICT_BATCH_SIZE, excludeId)
    if (batch.length === 0) break
    const batchIds = new Set(batch.map((s) => s.id))
    const cold = dedupeById(readList(COLD_KEY))
    const coldIds = new Set(cold.map((s) => s.id))
    writeList(COLD_KEY, [...cold, ...batch.filter((s) => !coldIds.has(s.id))])
    hot = hot.filter((s) => !batchIds.has(s.id))
    writeList(HOT_KEY, hot)
  }
}

// ---------- 数据迁移（幂等，失败后可接着重试） ----------

/**
 * v1 -> v2：旧数据没有查看时间，按采样时间补齐；再按容量把最旧的分批挪入冷存。
 * 版本号全部完成后才写入，中途失败下次打开会从未完成的部分继续。
 */
export function runMigrations(): void {
  const version = Number(localStorage.getItem(SCHEMA_VERSION_KEY) ?? '1')
  if (version >= CURRENT_SCHEMA_VERSION) return

  for (const key of [HOT_KEY, COLD_KEY]) {
    const list = readList(key)
    if (list.some((s) => !s.lastViewedAt)) {
      writeList(key, list.map((s) => (s.lastViewedAt ? s : { ...s, lastViewedAt: s.timestamp })))
    }
  }

  enforceHotCapacity()

  localStorage.setItem(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION))
}

// ---------- 写入与状态流转 ----------

export function saveScene(scene: WindowScene): void {
  const hot = getHotScenes()
  hot.push({ ...scene, lastViewedAt: scene.lastViewedAt ?? scene.timestamp })
  writeList(HOT_KEY, hot)
  enforceHotCapacity()
}

export function deleteScene(id: string): void {
  writeList(HOT_KEY, readList(HOT_KEY).filter((s) => s.id !== id))
  writeList(COLD_KEY, readList(COLD_KEY).filter((s) => s.id !== id))
}

/** 冷存记录回到手边；腾位置时绕开它自己（正在看的那条） */
function promoteToHot(scene: WindowScene): void {
  writeList(HOT_KEY, [...getHotScenes(), scene])
  writeList(COLD_KEY, readList(COLD_KEY).filter((s) => s.id !== scene.id))
  enforceHotCapacity(scene.id)
}

/** 查看记录：刷新查看时间；冷存记录重新打开后回到手边 */
export function touchScene(id: string): void {
  const now = new Date().toISOString()
  const hot = readList(HOT_KEY)
  const hotIdx = hot.findIndex((s) => s.id === id)
  if (hotIdx >= 0) {
    hot[hotIdx] = { ...hot[hotIdx], lastViewedAt: now }
    writeList(HOT_KEY, hot)
    return
  }
  const cold = readList(COLD_KEY)
  const target = cold.find((s) => s.id === id)
  if (!target) return
  promoteToHot({ ...target, lastViewedAt: now })
}

/** 切换重点标记；给冷存记录加重点会把它带回手边（取消重点不触发） */
export function toggleStar(id: string): void {
  const hot = readList(HOT_KEY)
  const hotIdx = hot.findIndex((s) => s.id === id)
  if (hotIdx >= 0) {
    hot[hotIdx] = { ...hot[hotIdx], starred: !hot[hotIdx].starred }
    writeList(HOT_KEY, hot)
    return
  }
  const cold = readList(COLD_KEY)
  const coldIdx = cold.findIndex((s) => s.id === id)
  if (coldIdx < 0) return
  const next = { ...cold[coldIdx], starred: !cold[coldIdx].starred }
  if (!next.starred) {
    cold[coldIdx] = next
    writeList(COLD_KEY, cold)
    return
  }
  promoteToHot(next)
}

// ---------- 查询（时间线 / 灵感 / 线路统计只读手边；冷存仅搜索可见） ----------

export function getScenesByRoute(routeName: string): WindowScene[] {
  return getHotScenes()
    .filter((s) => s.routeName === routeName)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

/** 线路统计：只计入手边的记录 */
export function getRouteStats(): RouteStat[] {
  const counts = new Map<string, number>()
  for (const s of getHotScenes()) {
    counts.set(s.routeName, (counts.get(s.routeName) ?? 0) + 1)
  }
  return Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}

export function getRandomScene(): WindowScene | null {
  const scenes = getHotScenes()
  if (scenes.length === 0) return null
  return scenes[Math.floor(Math.random() * scenes.length)]
}

/** 冷存搜索：按线路 / 区间 / 招牌 / 笔记匹配 */
export function searchColdScenes(keyword: string): WindowScene[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return []
  return getColdScenes()
    .filter((s) =>
      [s.routeName, s.segment, s.signText, s.note].some((f) => f.toLowerCase().includes(kw))
    )
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}
