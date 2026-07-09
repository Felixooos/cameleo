/*
 * Intègre une scène générée au jeu :
 *   node scripts/add_scene.js <id> <url> <theme> <difficulty easy|normal|hard>
 * - télécharge l'image, la convertit en 1920x1080 WebP (cover) dans public/scenes/
 * - met à jour shared/scenes/manifest.json (remplace l'entrée si l'id existe)
 */
const path = require("path");
const fs = require("fs");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const C = require("../shared/constants");

const [id, url, theme, difficulty] = process.argv.slice(2);
if (!id || !url || !["easy", "normal", "hard"].includes(difficulty)) {
  console.error("usage: node scripts/add_scene.js <id> <url> <theme> <easy|normal|hard>");
  process.exit(1);
}

const MANIFEST_PATH = path.join(__dirname, "..", "shared", "scenes", "manifest.json");
const OUT = path.join(__dirname, "..", "public", "scenes", id + ".webp");
const W = C.PHOTO_SCENE_W, H = C.PHOTO_SCENE_H;

(async () => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status + " sur " + url);
  const buf = Buffer.from(await res.arrayBuffer());
  const img = await loadImage(buf);

  // cover 1920x1080 (les sources 16:9 passent sans crop, sinon crop centré)
  const c = createCanvas(W, H);
  const x = c.getContext("2d");
  const s = Math.max(W / img.width, H / img.height);
  const dw = img.width * s, dh = img.height * s;
  x.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  const webp = c.toBuffer("image/webp", 88);
  fs.writeFileSync(OUT, webp);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  manifest.scenes = manifest.scenes.filter((sc) => sc.id !== id);
  manifest.scenes.push({ id, file: "/scenes/" + id + ".webp", theme: theme || id, difficulty });
  manifest.scenes.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log("✅ " + id + " -> " + Math.round(webp.length / 1024) + " Ko webp · manifest: " +
              manifest.scenes.length + " scènes");
})().catch((e) => { console.error("❌ " + e.message); process.exit(1); });
