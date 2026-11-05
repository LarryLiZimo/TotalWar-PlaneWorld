import type { UnitDef } from './sim/types'

/** Small code-native icons use the same weapon metadata as the battlefield. */
export function unitIcon(def: UnitDef): string {
  const weapon = def.weapon === 'bow'
    ? '<path d="M14 7Q43 24 14 41L14 7M10 24H39M32 18L39 24L32 30"/>'
    : def.weapon === 'claws'
      ? '<path d="M10 36L16 10L22 31L27 8L31 30L39 12L38 38"/>'
      : def.weapon === 'musket'
        ? '<path d="M9 39L19 29L15 25L38 6M19 24L37 6M24 18L29 23"/>'
        : '<path d="M10 39L37 8L30 10L34 15M15 26L25 35"/>'
  const shield = def.shieldBlock > 0 ? '<path d="M7 13L20 17L18 28L12 34L6 26Z" fill="currentColor" fill-opacity=".3"/>' : ''
  const horse = def.category === 'cavalry' ? '<path d="M10 40L12 31L29 30L33 20L39 24L37 33L31 36L30 43M16 35L17 43"/>' : ''
  return `<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${weapon}${shield}${horse}</svg>`
}
