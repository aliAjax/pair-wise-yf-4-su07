import type { WindowScene } from '@/types'

/** 手边（热存）容量上限：超出就分批挪进冷存 */
export const HOT_CAPACITY = 50

const HOT_KEY = 'bus_window_scenes'
const COLD_KEY = 'bus_window_scenes_cold'

function read(key: string): WindowScene[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as WindowScene[]) : []
  } catch {
    return []
  }
}

function write(key: string, scenes: WindowScene[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(scenes))
    return true
  } catch {
    return false
  }
}

/** 手边记录（常看的） */
export function getHotScenes(): WindowScene[] {
  return read(HOT_KEY)
}

/** 冷存记录（还能搜到，但不进时间线/灵感/线路统计） */
export function getColdScenes(): WindowScene[] {
  return read(COLD_KEY)
}

/** 全部记录（手边 + 冷存），用于跨层搜索 */
export function getAllScenes(): WindowScene[] {
  return [...getHotScenes(), ...getColdScenes()]
}

export function saveScene(scene: WindowScene): void {
  const hot = getHotScenes()
  hot.push(scene)
  write(HOT_KEY, hot)
}

export function deleteScene(id: string): void {
  write(HOT_KEY, getHotScenes().filter((s) => s.id !== id))
  write(COLD_KEY, getColdScenes().filter((s) => s.id !== id))
}

/** 线路统计只算手边的 */
export function getScenesByRoute(routeName: string): WindowScene[] {
  return getHotScenes()
    .filter((s) => s.routeName === routeName)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

/** 线路名统计只算手边的 */
export function getAllRouteNames(): string[] {
  const scenes = getHotScenes()
  const routeSet = new Set(scenes.map((s) => s.routeName))
  return Array.from(routeSet).sort()
}

/** 灵感抽取只从手边抽 */
export function getRandomScene(): WindowScene | null {
  const scenes = getHotScenes()
  if (scenes.length === 0) return null
  return scenes[Math.floor(Math.random() * scenes.length)]
}

/** 跨层搜索：冷存的也能搜到 */
export function searchScenes(query: string): WindowScene[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return getAllScenes()
    .filter((s) =>
      [s.routeName, s.segment, s.signText, s.note, s.weather, s.seatDirection]
        .some((field) => field.toLowerCase().includes(q))
    )
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

/**
 * 升级迁移：旧数据没有查看时间，按采样时间（timestamp）补上；
 * 顺手补齐 highlighted 字段。幂等，可重复执行。
 */
export function migrateViewedAt(): void {
  let changed = false
  const backfill = (scenes: WindowScene[]) => {
    for (const s of scenes) {
      if (!s.viewedAt) {
        s.viewedAt = s.timestamp
        changed = true
      }
      if (s.highlighted === undefined) {
        s.highlighted = false
        changed = true
      }
    }
  }
  const hot = getHotScenes()
  const cold = getColdScenes()
  backfill(hot)
  backfill(cold)
  if (changed) {
    write(HOT_KEY, hot)
    write(COLD_KEY, cold)
  }
}

/**
 * 搬迁：手边超出容量上限时，按“最久没看”分批挪进冷存。
 * 腾位置时绕开 exceptId（正在看的那条）。
 * 每条记录先打 pendingEviction 标记并落盘，再写冷存、最后从热存移除；
 * 任一步失败都会留下标记，由 recoverPendingEvictions 接着重试。
 */
export function evictToCold(exceptId?: string): number {
  const hot = getHotScenes()
  if (hot.length <= HOT_CAPACITY) return 0

  const moveCount = hot.length - HOT_CAPACITY
  const victims = hot
    .filter((s) => s.id !== exceptId)
    .sort(
      (a, b) =>
        new Date(a.viewedAt || a.timestamp).getTime() -
        new Date(b.viewedAt || b.timestamp).getTime()
    )
    .slice(0, moveCount)

  let moved = 0
  for (const victim of victims) {
    // 1. 打待搬迁标记并落盘，记录搬迁进度
    const marked: WindowScene = { ...victim, pendingEviction: true }
    if (!write(HOT_KEY, getHotScenes().map((s) => (s.id === victim.id ? marked : s)))) break

    // 2. 挪进冷存
    const cold = getColdScenes().filter((s) => s.id !== victim.id)
    cold.push({ ...victim, pendingEviction: false })
    if (!write(COLD_KEY, cold)) break

    // 3. 从手边移除
    if (!write(HOT_KEY, getHotScenes().filter((s) => s.id !== victim.id))) break
    moved++
  }
  return moved
}

/**
 * 恢复：把上次没搬完（带 pendingEviction 标记）的记录接着搬完。
 * 冷存写失败就停手，等下次再试，不丢数据。
 */
export function recoverPendingEvictions(): void {
  const hot = getHotScenes()
  const pending = hot.filter((s) => s.pendingEviction)
  if (pending.length === 0) return

  const cold = getColdScenes()
  for (const p of pending) {
    if (!cold.some((s) => s.id === p.id)) {
      cold.push({ ...p, pendingEviction: false })
    }
  }
  if (!write(COLD_KEY, cold)) return
  write(HOT_KEY, hot.filter((s) => !s.pendingEviction))
}

/** 把冷存记录提升回手边 */
export function promoteScene(id: string): void {
  const cold = getColdScenes()
  const idx = cold.findIndex((s) => s.id === id)
  if (idx === -1) return
  const [scene] = cold.splice(idx, 1)
  write(COLD_KEY, cold)
  const hot = getHotScenes().filter((s) => s.id !== id)
  hot.push({ ...scene, pendingEviction: false })
  write(HOT_KEY, hot)
}

/** 记录被重新打开：刷新查看时间；冷存的回到手边 */
export function markViewed(id: string): void {
  const now = new Date().toISOString()
  const hot = getHotScenes()
  if (hot.some((s) => s.id === id)) {
    write(HOT_KEY, hot.map((s) => (s.id === id ? { ...s, viewedAt: now } : s)))
    return
  }
  if (getColdScenes().some((s) => s.id === id)) {
    promoteScene(id)
    const hotAfter = getHotScenes()
    write(HOT_KEY, hotAfter.map((s) => (s.id === id ? { ...s, viewedAt: now } : s)))
  }
}

/** 加/取消重点：冷存记录加了重点会回到手边 */
export function setHighlight(id: string, highlighted: boolean): void {
  const hot = getHotScenes()
  if (hot.some((s) => s.id === id)) {
    write(HOT_KEY, hot.map((s) => (s.id === id ? { ...s, highlighted } : s)))
    return
  }
  if (getColdScenes().some((s) => s.id === id)) {
    promoteScene(id)
    const hotAfter = getHotScenes()
    write(HOT_KEY, hotAfter.map((s) => (s.id === id ? { ...s, highlighted } : s)))
  }
}
