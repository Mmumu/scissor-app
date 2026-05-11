const fs = require('fs')
const path = require('path')

const SIZE = 16
const OUT_DIR = path.join(__dirname, '../resources/luts')

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
}

function generateLut(name, transform) {
  let out = `TITLE "${name}"\nLUT_3D_SIZE ${SIZE}\n`
  for (let b = 0; b < SIZE; b++) {
    for (let g = 0; g < SIZE; g++) {
      for (let r = 0; r < SIZE; r++) {
        const rr = r / (SIZE - 1)
        const gg = g / (SIZE - 1)
        const bb = b / (SIZE - 1)
        const [tr, tg, tb] = transform(rr, gg, bb)
        out += `${tr.toFixed(6)} ${tg.toFixed(6)} ${tb.toFixed(6)}\n`
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, `${name}.cube`), out)
  console.log(`Generated ${name}.cube`)
}

// 1. Black & White
generateLut('bw', (r, g, b) => {
  const v = r * 0.299 + g * 0.587 + b * 0.114
  return [v, v, v]
})

// 2. Sepia
generateLut('sepia', (r, g, b) => {
  const tr = Math.min(1, r * 0.393 + g * 0.769 + b * 0.189)
  const tg = Math.min(1, r * 0.349 + g * 0.686 + b * 0.168)
  const tb = Math.min(1, r * 0.272 + g * 0.534 + b * 0.131)
  return [tr, tg, tb]
})

// 3. Warm
generateLut('warm', (r, g, b) => {
  // increase red and green slightly, decrease blue
  const tr = Math.min(1, r * 1.05 + 0.05)
  const tg = Math.min(1, g * 1.02 + 0.02)
  const tb = Math.max(0, b * 0.9 - 0.05)
  return [tr, tg, tb]
})

// 4. Cool
generateLut('cool', (r, g, b) => {
  // increase blue, decrease red
  const tr = Math.max(0, r * 0.9 - 0.05)
  const tg = Math.min(1, g * 1.0)
  const tb = Math.min(1, b * 1.05 + 0.05)
  return [tr, tg, tb]
})

// 5. High Contrast
generateLut('contrast', (r, g, b) => {
  const adjust = (c) => Math.min(1, Math.max(0, (c - 0.5) * 1.3 + 0.5))
  return [adjust(r), adjust(g), adjust(b)]
})
