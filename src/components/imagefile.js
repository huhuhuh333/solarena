// Crop-to-square + shrink, in the BROWSER. The server only ever sees a small
// finished image, which is what lets its upload cap stay tight.
//
// Shared by profile pictures and market pictures - one implementation, so the
// two paths cannot drift on size, format or the WEBP fallback.
export const squareDataUrl = (file, size) => new Promise((resolve, reject) => {
  // Anything the browser can decode is fair game - PNG, JPG, WEBP, GIF, AVIF,
  // BMP - because the canvas below re-encodes every one of them to WEBP (or
  // JPEG) before it ever leaves the machine. The old PNG/JPG/WEBP whitelist was
  // guarding a pipeline that already normalises its output, and it turned away
  // perfectly good pictures for no gain.
  //
  // SVG is the one exception, and not out of squeamishness: it is a document,
  // not a bitmap - it can pull in external references, and drawing one taints
  // the canvas in some browsers, which makes toDataURL throw rather than
  // produce anything useful.
  if (!/^image\//.test(file.type) || /svg/i.test(file.type)) {
    return reject(new Error('Pick an image - PNG, JPG, WEBP, GIF or AVIF all work.'))
  }
  if (file.size > 8_000_000) return reject(new Error('That file is over 8 MB - pick something smaller.'))
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    URL.revokeObjectURL(url)
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    if (!side) return reject(new Error('Could not read that image.'))
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    const out = c.toDataURL('image/webp', 0.85)
    // Browsers without webp encoding (old Safari) silently return PNG - detect
    // and fall back to JPEG, which compresses photos far better than PNG.
    resolve(out.startsWith('data:image/webp') ? out : c.toDataURL('image/jpeg', 0.85))
  }
  // A format the browser cannot decode lands here rather than being guessed at
  // from its extension - the decoder is the only honest judge of "is this an
  // image this machine can open".
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image could not be opened - try a PNG or JPG.")) }
  img.src = url
})

// Scale-to-fit for post photos: the square crop above is right for a face or a
// logo, but a post picture is CONTENT - cropping it would cut the joke off.
// This keeps the aspect and only shrinks until the long side fits.
export const scaledDataUrl = (file, maxDim) => new Promise((resolve, reject) => {
  if (!/^image\//.test(file.type) || /svg/i.test(file.type)) {
    return reject(new Error('Pick an image - PNG, JPG, WEBP, GIF or AVIF all work.'))
  }
  if (file.size > 8_000_000) return reject(new Error('That file is over 8 MB - pick something smaller.'))
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    URL.revokeObjectURL(url)
    const w = img.naturalWidth, h = img.naturalHeight
    if (!w || !h) return reject(new Error('Could not read that image.'))
    const scale = Math.min(1, maxDim / Math.max(w, h))
    const c = document.createElement('canvas')
    c.width = Math.round(w * scale)
    c.height = Math.round(h * scale)
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const out = c.toDataURL('image/webp', 0.82)
    resolve(out.startsWith('data:image/webp') ? out : c.toDataURL('image/jpeg', 0.82))
  }
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image could not be opened - try a PNG or JPG.")) }
  img.src = url
})
