import { create } from 'zustand'
import type { WindowScene, SceneFormData, RouteStat } from '@/types'
import {
  getHotScenes,
  getColdScenes,
  saveScene as storageSaveScene,
  deleteScene as storageDeleteScene,
  touchScene as storageTouchScene,
  toggleStar as storageToggleStar,
  getScenesByRoute,
  getRouteStats,
  getRandomScene,
  searchColdScenes,
  runMigrations,
} from '@/services/storage'

interface SceneState {
  /** 手边（热存）记录 */
  scenes: WindowScene[]
  /** 冷存条数 */
  coldCount: number
  /** 线路统计（仅手边记录计入） */
  routeStats: RouteStat[]
  currentRouteScenes: WindowScene[]
  selectedRoute: string
  randomScene: WindowScene | null
  /** 冷存搜索结果与当前关键词 */
  coldResults: WindowScene[]
  coldKeyword: string

  loadAll: () => void
  saveScene: (data: SceneFormData) => void
  deleteScene: (id: string) => void
  selectRoute: (routeName: string) => void
  refreshRandom: () => void
  touchScene: (id: string) => void
  toggleStar: (id: string) => void
  searchCold: (keyword: string) => void
}

const snapshot = (selectedRoute: string) => ({
  scenes: getHotScenes(),
  coldCount: getColdScenes().length,
  routeStats: getRouteStats(),
  currentRouteScenes: selectedRoute ? getScenesByRoute(selectedRoute) : [],
})

export const useSceneStore = create<SceneState>((set) => ({
  scenes: [],
  coldCount: 0,
  routeStats: [],
  currentRouteScenes: [],
  selectedRoute: '',
  randomScene: null,
  coldResults: [],
  coldKeyword: '',

  loadAll: () => {
    try {
      runMigrations()
    } catch (err) {
      // 搬迁中途失败：已落盘的进度保留，下次打开接着搬没搬完的
      console.warn('[窗景] 数据迁移未完成，下次打开将继续', err)
    }
    set((state) => ({
      ...snapshot(state.selectedRoute),
      coldResults: searchColdScenes(state.coldKeyword),
    }))
  },

  saveScene: (data: SceneFormData) => {
    const now = new Date().toISOString()
    const scene: WindowScene = {
      ...data,
      id: crypto.randomUUID(),
      timestamp: now,
      lastViewedAt: now,
    }
    storageSaveScene(scene)
    set((state) => snapshot(state.selectedRoute))
  },

  deleteScene: (id: string) => {
    storageDeleteScene(id)
    set((state) => ({
      ...snapshot(state.selectedRoute),
      coldResults: searchColdScenes(state.coldKeyword),
    }))
  },

  selectRoute: (routeName: string) => {
    const currentRouteScenes = routeName ? getScenesByRoute(routeName) : []
    set({ selectedRoute: routeName, currentRouteScenes })
  },

  refreshRandom: () => {
    const randomScene = getRandomScene()
    set({ randomScene })
  },

  touchScene: (id: string) => {
    storageTouchScene(id)
    set((state) => ({
      ...snapshot(state.selectedRoute),
      coldResults: searchColdScenes(state.coldKeyword),
    }))
  },

  toggleStar: (id: string) => {
    storageToggleStar(id)
    set((state) => ({
      ...snapshot(state.selectedRoute),
      coldResults: searchColdScenes(state.coldKeyword),
    }))
  },

  searchCold: (keyword: string) => {
    set({ coldKeyword: keyword, coldResults: searchColdScenes(keyword) })
  },
}))
