import type { Side, UnitType } from '../sim/types'

/** Face for the few words painted on the field itself. */
export const TITLE_FONT = '"STZhongsong", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif'

/** The single character each regiment flies, so a unit can be read off its flag from across the field. */
export const UNIT_GLYPH: Record<UnitType, string> = {
  spear: '矛', sword: '剑', greatsword: '巨', heavyCavalry: '骑', lightCavalry: '轻', archer: '弓', musket: '铳', chariot: '车',
  general: '帅', inquisitor: '审', shieldCavalry: '盾', halberd: '戟', crossbow: '弩', horseArcher: '射', ogre: '魔', armoredOgre: '铁',
  monster: '兽', behemoth: '犀', militia: '民', shieldSpear: '卫', flagellant: '鞭', huntsmen: '猎', freeCompany: '佣', ironsides: '甲',
  longRifle: '狙', reiksguard: '禁', blackRose: '玫', pistolier: '骠', outrider: '驱', demigryph: '鹫', demigryphHalberd: '鹰',
  warWagon: '垒', heavyChariot: '冲', ogreGreatWeapon: '斧', ogreHalberd: '镇', giant: '岳', stoneBeast: '磐', captain: '尉', warriorPriest: '祭',
}

const CLOTH = ['#35619f', '#a6352c'], FOLD = ['#274a7d', '#7c2620'], TRIM = ['#f0e6c6', '#ecc970']

export interface BannerState {
  side: Side
  glyph: string
  selected: boolean
  /** The regiment has broken: it flies a pale rag. */
  routing: boolean
  /** Leadership is giving way: the flag whips. */
  wavering: boolean
  /** 0..1 opacity for the whole banner. */
  alpha: number
}

/**
 * A regimental flag standing with its foot at (x, foot): pole on the left, cloth streaming right. All sizes are in
 * CSS pixels times `ui`. Drawn with plain coordinates only; the pen is never moved or turned.
 */
export function drawBanner(ctx: CanvasRenderingContext2D, x: number, foot: number, ui: number, state: BannerState, seconds: number, seed: number): void {
  const w = 21 * ui, h = 18 * ui, left = x - w / 2, top = foot - h - 3 * ui
  const speed = state.wavering ? 9 : 3.2, sway = (state.wavering ? 2.4 : 1.5) * ui
  const wave = (t: number) => Math.sin(seconds * speed + seed * 1.7 - t * 3.4) * sway * t
  const prior = ctx.globalAlpha
  ctx.globalAlpha = prior * state.alpha
  ctx.lineJoin = 'round'
  // Pole and its shadow on the turf.
  ctx.strokeStyle = 'rgba(8,10,6,0.35)'; ctx.lineWidth = 2 * ui
  ctx.beginPath(); ctx.moveTo(left, foot + 2 * ui); ctx.lineTo(left + 7 * ui, foot + 5 * ui); ctx.stroke()
  ctx.strokeStyle = '#2a2118'; ctx.lineWidth = 2.4 * ui
  ctx.beginPath(); ctx.moveTo(left, top - 3 * ui); ctx.lineTo(left, foot + 2 * ui); ctx.stroke()
  ctx.strokeStyle = '#a5855a'; ctx.lineWidth = ui
  ctx.beginPath(); ctx.moveTo(left, top - 3 * ui); ctx.lineTo(left, foot + 2 * ui); ctx.stroke()
  // Cloth: the upper and lower hems ripple away from the pole and end in a swallow tail.
  const edge = (y: number, from: number, to: number) => { for (let i = from; i !== to; i += Math.sign(to - from)) { const t = i / 5; ctx.lineTo(left + w * t, y + wave(t)) } }
  ctx.beginPath()
  ctx.moveTo(left, top)
  edge(top, 1, 6)
  ctx.lineTo(left + w * 0.8, top + h * 0.5 + wave(0.8))
  ctx.lineTo(left + w, top + h + wave(1))
  edge(top + h, 4, -1)
  ctx.closePath()
  ctx.fillStyle = state.routing ? '#d8d2c0' : CLOTH[state.side]
  ctx.fill()
  // Folds catch the shade where the cloth turns away.
  ctx.fillStyle = state.routing ? 'rgba(90,84,70,0.35)' : FOLD[state.side]
  for (const t of [0.34, 0.68]) {
    const lean = Math.cos(seconds * speed + seed * 1.7 - t * 3.4)
    if (lean <= 0) continue
    ctx.globalAlpha = prior * state.alpha * Math.min(0.7, lean * 0.7)
    ctx.fillRect(left + w * t - 1.5 * ui, top + wave(t) + ui, 3.2 * ui, h - 2 * ui)
  }
  ctx.globalAlpha = prior * state.alpha
  ctx.strokeStyle = state.selected ? '#ffe9a6' : 'rgba(14,16,10,0.85)'
  ctx.lineWidth = (state.selected ? 2 : 1.1) * ui
  ctx.stroke()
  if (!state.routing) {
    ctx.strokeStyle = TRIM[state.side]; ctx.lineWidth = ui
    ctx.beginPath(); ctx.moveTo(left + 1.2 * ui, top + 2.2 * ui + wave(0.06)); ctx.lineTo(left + w * 0.72, top + 2.2 * ui + wave(0.72)); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(left + 1.2 * ui, top + h - 2.2 * ui + wave(0.06)); ctx.lineTo(left + w * 0.72, top + h - 2.2 * ui + wave(0.72)); ctx.stroke()
  }
  ctx.fillStyle = '#e9c96f'
  ctx.beginPath(); ctx.arc(left, top - 3.6 * ui, 1.7 * ui, 0, Math.PI * 2); ctx.fill()
  ctx.font = `bold ${Math.round(11.5 * ui)}px ${TITLE_FONT}`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = state.routing ? '#6a6456' : TRIM[state.side]
  ctx.fillText(state.glyph, left + w * 0.42, top + h * 0.5 + wave(0.42) + 0.5 * ui)
  ctx.textBaseline = 'alphabetic'
  ctx.globalAlpha = prior
}
