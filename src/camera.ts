import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'
import type { Regiment } from './sim/types'

export interface Camera {
  x: number
  y: number
  zoom: number
}

/** Centre on the bodies currently on screen; the formation anchor can be far away. */
export function focusRegiment(camera: Camera, reg: Pick<Regiment,'soldiers'>): boolean {
  let x=0,y=0,count=0
  for(const s of reg.soldiers) if(s.alive) {x+=s.x;y+=s.y;count++}
  if(!count) return false
  camera.x=x/count;camera.y=y/count
  return true
}

export interface DragPreview {
  kind: 'box' | 'front'
  x0: number
  y0: number
  x1: number
  y1: number
}

export function fitCamera(camera: Camera, width: number, height: number): void {
  camera.zoom = Math.min(width / MAP_WIDTH, height / MAP_HEIGHT) * 0.88
  camera.x = MAP_WIDTH / 2
  camera.y = MAP_HEIGHT / 2
}

export function worldToScreen(
  camera: Camera,
  width: number,
  height: number,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: width / 2 + (x - camera.x) * camera.zoom,
    y: height / 2 - (y - camera.y) * camera.zoom,
  }
}

export function screenToWorld(
  camera: Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: camera.x + (sx - width / 2) / camera.zoom,
    y: camera.y - (sy - height / 2) / camera.zoom,
  }
}
