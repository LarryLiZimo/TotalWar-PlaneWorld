import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'

export interface Camera {
  x: number
  y: number
  zoom: number
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
