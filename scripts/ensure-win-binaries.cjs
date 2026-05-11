'use strict'

/**
 * Before `electron-builder --win`, ensure resources/win/ffmpeg.exe + ffprobe.exe exist.
 *
 * If you already keep both files there (checked in by your team or copied manually),
 * this script exits immediately and does nothing — runtime never reads node_modules here,
 * only electron-builder packs resources/win into the installer.
 *
 * Automatic steps are only for fresh clones / CI where resources/win is empty:
 * - ffprobe: copy from ffprobe-static (npm tarball includes win32 exe).
 * - ffmpeg: download same GitHub release as ffmpeg-static (host npm install only has host ffmpeg).
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { pipeline } = require('stream/promises')
const { createGunzip } = require('zlib')

const root = path.join(__dirname, '..')
const winDir = path.join(root, 'resources', 'win')
const ffprobeSrc = path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')

/** Avoid treating stubs / partial downloads as “already bundled” */
function looksLikeBundledWinBins(ffmpegPath, ffprobePath) {
  if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) return false
  const fsz = fs.statSync(ffmpegPath).size
  const psz = fs.statSync(ffprobePath).size
  return fsz >= 4 * 1024 * 1024 && psz >= 512 * 1024
}

function loadFfmpegReleaseTag() {
  const pkgPath = path.join(root, 'node_modules', 'ffmpeg-static', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const tag = pkg['ffmpeg-static']?.['binary-release-tag']
  if (!tag) throw new Error('Could not read ffmpeg-static binary-release-tag')
  return tag
}

function downloadGunzip(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error('too many redirects'))
      return
    }
    const opts = new URL(url)
    https
      .get(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, url).href
          downloadGunzip(next, dest, redirects + 1).then(resolve).catch(reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`GET ${url} → HTTP ${res.statusCode}`))
          return
        }
        const tmp = `${dest}.${process.pid}.part`
        const out = fs.createWriteStream(tmp)
        const gunzip = createGunzip()
        pipeline(res, gunzip, out)
          .then(() => {
            try {
              fs.renameSync(tmp, dest)
            } catch (e) {
              try {
                fs.unlinkSync(tmp)
              } catch {
                /* ignore */
              }
              throw e
            }
            resolve()
          })
          .catch((err) => {
            try {
              fs.unlinkSync(tmp)
            } catch {
              /* ignore */
            }
            reject(err)
          })
      })
      .on('error', reject)
  })
}

async function main() {
  fs.mkdirSync(winDir, { recursive: true })

  const ffmpegDest = path.join(winDir, 'ffmpeg.exe')
  const ffprobeDest = path.join(winDir, 'ffprobe.exe')

  if (looksLikeBundledWinBins(ffmpegDest, ffprobeDest)) {
    console.log(
      'resources/win already has ffmpeg.exe + ffprobe.exe — skipping download/copy (remove or shrink files to force refresh).'
    )
    return
  }

  if (!fs.existsSync(ffprobeDest) || fs.statSync(ffprobeDest).size < 512 * 1024) {
    if (!fs.existsSync(ffprobeSrc)) {
      throw new Error(
        `Missing ${ffprobeSrc} — run npm install at repo root so ffprobe-static includes win32 binaries.`
      )
    }
    fs.copyFileSync(ffprobeSrc, ffprobeDest)
    console.log('Copied', ffprobeDest)
  }

  if (!fs.existsSync(ffmpegDest) || fs.statSync(ffmpegDest).size < 4 * 1024 * 1024) {
    const release = loadFfmpegReleaseTag()
    const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`
    const gzUrl = `${base}/ffmpeg-win32-x64.gz`
    console.log('Downloading Windows ffmpeg from', gzUrl)
    await downloadGunzip(gzUrl, ffmpegDest)
    try {
      fs.chmodSync(ffmpegDest, 0o755)
    } catch {
      /* Windows may ignore chmod */
    }
    console.log('Wrote', ffmpegDest)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
