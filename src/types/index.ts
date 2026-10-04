export type SeatDirection = '左' | '右'

export type Weather = '晴' | '多云' | '阴' | '小雨' | '大雨' | '雪' | '雾'

export type TreeDensity = '稀疏' | '适中' | '茂密'

export type PedestrianStatus = '稀少' | '零星' | '密集'

export interface WindowScene {
  id: string
  routeName: string
  segment: string
  seatDirection: SeatDirection
  timestamp: string
  weather: Weather
  signText: string
  treeDensity: TreeDensity
  pedestrianStatus: PedestrianStatus
  note: string
  /** 最近查看时间，决定记录留在手边还是挪入冷存；旧数据缺失，升级时按采样时间补齐 */
  lastViewedAt?: string
  /** 重点标记；加了重点的冷存记录会回到手边，腾位置时最后才被挪走 */
  starred?: boolean
}

export interface RouteStat {
  name: string
  count: number
}

export interface SceneFormData {
  routeName: string
  segment: string
  seatDirection: SeatDirection
  weather: Weather
  signText: string
  treeDensity: TreeDensity
  pedestrianStatus: PedestrianStatus
  note: string
}
