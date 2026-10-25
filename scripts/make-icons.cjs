// Renders build/icon.svg into build/icon.png and build/icon.ico, the site's
// favicon and social card mark, and the Android launcher icons and splash.
// Run with: npm run icons
const { app, BrowserWindow } = require("electron");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const svg = readFileSync(join(root, "build/icon.svg"), "utf8");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const LARGE = 1024; // macOS and Linux want a big PNG

let win;

// Draws an SVG on a canvas of the exact size and reads the pixels back.
async function render(size, source = svg, height = size) {
  const url = "data:image/svg+xml;base64," + Buffer.from(source).toString("base64");
  const data = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = ${size};
      c.height = ${height};
      c.getContext("2d").drawImage(img, 0, 0, ${size}, ${height});
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("svg did not load"));
    img.src = "${url}";
  })`);
  return Buffer.from(data.split(",")[1], "base64");
}

// An .ico file may hold PNG images directly.
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size === 256 ? 0 : size, at);
    header.writeUInt8(size === 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

// The blocks of the mark, without the white square behind them.
const blocks = svg.split("\n").filter((l) => l.includes("<path") && !l.includes('fill="#ffffff"')).join("\n");

// Draws the mark centred on a sheet: `share` is how much of the shorter side it takes.
function sheet(w, h, share, background) {
  const side = Math.min(w, h) * share;
  const s = side / 28; // the blocks span 2 to 30 in the mark's 32 unit grid
  const tx = w / 2 - 16 * s;
  const ty = h / 2 - 16 * s;
  const bg = background ? `<rect width="${w}" height="${h}" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">${bg}<g transform="translate(${tx} ${ty}) scale(${s})">${blocks}</g></svg>`;
}

async function android() {
  const res = join(root, "android/app/src/main/res");
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, k] of Object.entries(densities)) {
    const dir = join(res, "mipmap-" + name);
    mkdirSync(dir, { recursive: true });
    const legacy = Math.round(48 * k);
    const full = sheet(legacy, legacy, 0.78, "#ffffff");
    writeFileSync(join(dir, "ic_launcher.png"), await render(legacy, full));
    writeFileSync(join(dir, "ic_launcher_round.png"), await render(legacy, full));
    // Adaptive icons are cut to a circle or a squircle: keep the mark inside the safe zone.
    const fg = Math.round(108 * k);
    writeFileSync(join(dir, "ic_launcher_foreground.png"), await render(fg, sheet(fg, fg, 0.44, null)));
  }
  // The image shown while the app starts, on the same white as the interface.
  const splash = [
    ["drawable", 480, 320],
    ["drawable-land-mdpi", 480, 320],
    ["drawable-land-hdpi", 800, 480],
    ["drawable-land-xhdpi", 1280, 720],
    ["drawable-land-xxhdpi", 1600, 960],
    ["drawable-land-xxxhdpi", 1920, 1280],
    ["drawable-port-mdpi", 320, 480],
    ["drawable-port-hdpi", 480, 800],
    ["drawable-port-xhdpi", 720, 1280],
    ["drawable-port-xxhdpi", 960, 1600],
    ["drawable-port-xxxhdpi", 1280, 1920],
  ];
  for (const [dir, w, h] of splash) {
    mkdirSync(join(res, dir), { recursive: true });
    writeFileSync(join(res, dir, "splash.png"), await render(w, sheet(w, h, 0.2, "#ffffff"), h));
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
  win = new BrowserWindow({ show: false });
  await win.loadURL("about:blank");
  const images = [];
  for (const size of SIZES) images.push({ size, png: await render(size) });
  writeFileSync(join(root, "build/icon.png"), await render(LARGE));
  writeFileSync(join(root, "build/icon.ico"), ico(images));
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "site/favicon.ico"), ico(images.filter((i) => i.size <= 48)));
  writeFileSync(join(root, "site/icon-256.png"), images[images.length - 1].png);
  writeFileSync(join(root, "site/icon.svg"), svg);
  if (existsSync(join(root, "android"))) await android();
  console.log("icons written");
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
