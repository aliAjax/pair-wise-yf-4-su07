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
  /** 查看时间（ISO），冷存淘汰时按它判断谁“常看”；旧数据升级时按采样时间补上 */
  viewedAt: string
  /** 是否加了重点；重点记录被重新打开/加星后会回到手边 */
  highlighted: boolean
  /** 待搬迁标记：挪进冷存失败时留下，下次启动接着重试没搬完的 */
  pendingEviction?: boolean
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
