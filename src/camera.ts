import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'
import type { Regiment } from './sim/types'

export interface Camera {
  x: number
  y: number
  zoom: number
  /**
   * Set by a view that eases its zoom: the wheel then names a zoom to glide to, keeping the world point (wx, wy)
   * under the screen point (sx, sy) on the way. Without it the wheel changes `zoom` at once.
   */
  glide?: { zoom: number; sx: number; sy: number; wx: number; wy: number } | null
  /** Keyboard pan in progress, metres per second; eased by `easeCamera`. */
  vx?: number
  vy?: number
}

/** How far the camera's centre may leave the map, metres. */
const CAMERA_MARGIN = 30

/**
 * One frame of camera motion: ease the zoom toward its glide target about the pointer, and bring the keyboard pan
 * (`panX`, `panY` in -1..1) up to speed and back to rest smoothly. Pan speed follows the view, so it crosses the
 * screen in the same time at any zoom.
 */
export function easeCamera(camera: Camera, width: number, height: number, seconds: number, panX: number, panY: number): void {
  const glide = camera.glide
  if (glide) {
    const k = 1 - Math.exp(-14 * seconds)
    camera.zoom = Math.abs(glide.zoom - camera.zoom) < glide.zoom * 0.002 ? glide.zoom : camera.zoom * Math.pow(glide.zoom / camera.zoom, k)
    camera.x = glide.wx - (glide.sx - width / 2) / camera.zoom
    camera.y = glide.wy + (glide.sy - height / 2) / camera.zoom
    if (camera.zoom === glide.zoom) camera.glide = null
  }
  const speed = width / camera.zoom * 0.85, k = 1 - Math.exp(-10 * seconds)
  camera.vx = (camera.vx ?? 0) + (panX * speed - (camera.vx ?? 0)) * k
  camera.vy = (camera.vy ?? 0) + (panY * speed - (camera.vy ?? 0)) * k
  if (Math.abs(camera.vx) < 0.01 && !panX) camera.vx = 0
  if (Math.abs(camera.vy) < 0.01 && !panY) camera.vy = 0
  if (camera.vx || camera.vy) {
    camera.x += camera.vx * seconds; camera.y += camera.vy * seconds
    // Panning during a zoom carries the zoom's anchor along instead of fighting it.
    if (camera.glide) { camera.glide.wx += camera.vx * seconds; camera.glide.wy += camera.vy * seconds }
  }
  camera.x = Math.max(-CAMERA_MARGIN, Math.min(MAP_WIDTH + CAMERA_MARGIN, camera.x))
  camera.y = Math.max(-CAMERA_MARGIN, Math.min(MAP_HEIGHT + CAMERA_MARGIN, camera.y))
}

/** Centre on the bodies currently on screen; the formation anchor can be far away. */
export function focusRegiment(camera: Camera, reg: Pick<Regiment,'soldiers'>): boolean {
  let x=0,y=0,count=0
  for(const s of reg.soldiers) if(s.alive) {x+=s.x;y+=s.y;count++}
  if(!count) return false
  camera.x=x/count;camera.y=y/count
  // A zoom still easing would pull the view back to its own anchor.
  if(camera.glide) camera.glide=null
  return true
}

export interface DragPreview {
  kind: 'box' | 'front' | 'place'
  x0: number
  y0: number
  x1: number
  y1: number
  /**
   * Translate / rotate drags: where each selected regiment would stand and face, after every gesture of the drag so far
   * (they compose). For these (x0, y0) is where the active gesture took over, (x1, y1) the pointer.
   */
  places?: { id: number; x: number; y: number; facing: number }[]
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
