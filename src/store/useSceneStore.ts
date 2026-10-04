import { create } from 'zustand'
import type { WindowScene, SceneFormData } from '@/types'
import {
  getHotScenes,
  getColdScenes,
  saveScene as storageSaveScene,
  deleteScene as storageDeleteScene,
  getScenesByRoute,
  getAllRouteNames,
  getRandomScene,
  searchScenes,
  migrateViewedAt,
  recoverPendingEvictions,
  evictToCold,
  markViewed,
  setHighlight,
} from '@/services/storage'

interface SceneState {
  /** 手边记录（热存）：时间线、灵感、线路统计都只算这些 */
  scenes: WindowScene[]
  /** 冷存记录：还能搜到，但不进时间线/灵感 */
  coldScenes: WindowScene[]
  routeNames: string[]
  currentRouteScenes: WindowScene[]
  selectedRoute: string
  randomScene: WindowScene | null
  searchResults: WindowScene[]
  searchQuery: string

  loadAll: () => void
  saveScene: (data: SceneFormData) => void
  deleteScene: (id: string) => void
  selectRoute: (routeName: string) => void
  refreshRandom: () => void
  search: (query: string) => void
  openScene: (id: string) => void
  toggleHighlight: (id: string) => void
}

export const useSceneStore = create<SceneState>((set, get) => ({
  scenes: [],
  coldScenes: [],
  routeNames: [],
  currentRouteScenes: [],
  selectedRoute: '',
  randomScene: null,
  searchResults: [],
  searchQuery: '',

  loadAll: () => {
    // 升级：补全旧数据的查看时间
    migrateViewedAt()
    // 恢复：接着重试上次没搬完的
    recoverPendingEvictions()
    // 超出容量就分批挪进冷存
    evictToCold()
    const scenes = getHotScenes()
    const coldScenes = getColdScenes()
    const routeNames = getAllRouteNames()
    set({ scenes, coldScenes, routeNames })
  },

  saveScene: (data: SceneFormData) => {
    const now = new Date().toISOString()
    const scene: WindowScene = {
      ...data,
      id: crypto.randomUUID(),
      timestamp: now,
      viewedAt: now,
      highlighted: false,
    }
    storageSaveScene(scene)
    evictToCold()
    const scenes = getHotScenes()
    const coldScenes = getColdScenes()
    const routeNames = getAllRouteNames()
    set((state) => {
      const currentRouteScenes =
        state.selectedRoute ? getScenesByRoute(state.selectedRoute) : []
      return { scenes, coldScenes, routeNames, currentRouteScenes }
    })
  },

  deleteScene: (id: string) => {
    storageDeleteScene(id)
    const scenes = getHotScenes()
    const coldScenes = getColdScenes()
    const routeNames = getAllRouteNames()
    set((state) => {
      const currentRouteScenes =
        state.selectedRoute ? getScenesByRoute(state.selectedRoute) : []
      return { scenes, coldScenes, routeNames, currentRouteScenes }
    })
  },

  selectRoute: (routeName: string) => {
    const currentRouteScenes = routeName ? getScenesByRoute(routeName) : []
    set({ selectedRoute: routeName, currentRouteScenes })
  },

  refreshRandom: () => {
    const randomScene = getRandomScene()
    set({ randomScene })
  },

  search: (query: string) => {
    set({ searchQuery: query, searchResults: searchScenes(query) })
  },

  openScene: (id: string) => {
    // 重新打开：刷新查看时间，冷存的回到手边
    markViewed(id)
    // 腾位置时绕开正在看的这条
    evictToCold(id)
    const scenes = getHotScenes()
    const coldScenes = getColdScenes()
    set({ scenes, coldScenes })
  },

  toggleHighlight: (id: string) => {
    const scene =
      get().scenes.find((s) => s.id === id) ||
      get().coldScenes.find((s) => s.id === id)
    if (!scene) return
    // 加了重点的冷存记录会回到手边
    setHighlight(id, !scene.highlighted)
    evictToCold(id)
    const scenes = getHotScenes()
    const coldScenes = getColdScenes()
    set({ scenes, coldScenes })
  },
}))
