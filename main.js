const { app, BrowserWindow, ipcMain, nativeTheme, Tray, nativeImage, Menu, screen } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');

const execAsync = promisify(exec);
nativeTheme.themeSource = 'dark';
const HOME = os.homedir();

// ── tray icon (pure Node, no deps) ───────────────────────────────────────────

function createIconPNG(scale = 2) {
  const BASE = 22, S = BASE * scale;
  const px = new Uint8Array(S * S * 4);

  function fill(x1, y1, x2, y2) {
    for (let y = y1 * scale; y < (y2 + 1) * scale; y++)
      for (let x = x1 * scale; x < (x2 + 1) * scale; x++)
        if (x >= 0 && x < S && y >= 0 && y < S)
          px[(y * S + x) * 4 + 3] = 255;
  }

  // 3 rows:  ● ─────────  (dot + horizontal line)
  for (const y of [3, 9, 15]) {
    fill(2, y,  4, y + 2); // 3×3 dot
    fill(7, y, 19, y + 1); // line
  }

  // PNG encoder
  function crc32(b) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    let c = 0xFFFFFFFF;
    for (const byte of b) c = t[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([l, t, data, crcBuf]);
  }

  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(S, 0); IHDR.writeUInt32BE(S, 4);
  IHDR[8] = 8; IHDR[9] = 6; // 8-bit RGBA

  const rows = [];
  for (let y = 0; y < S; y++) {
    rows.push(0);
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      rows.push(0, 0, 0, px[i + 3]);
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', IHDR),
    chunk('IDAT', zlib.deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── process helpers ───────────────────────────────────────────────────────────

function extractLabel(name, cmd, cwd) {
  if (cmd) {
    const args = cmd.trim().split(/\s+/).slice(1);
    for (const arg of args) {
      if (arg.startsWith('-') || !arg.includes('/')) continue;
      let dir = arg
        .replace(/\/node_modules\/.+$/, '')
        .replace(/\/\.bin\/.+$/, '')
        .replace(/\/dist(\/.*)?$/, '')
        .replace(/\/build(\/.*)?$/, '')
        .replace(/\/out(\/.*)?$/, '');
      if (/\.[a-z]{1,5}$/i.test(dir)) dir = dir.replace(/\/[^/]+$/, '');
      if (!dir || dir === '.' || dir === HOME || dir === '/') continue;
      const label = dir.split('/').filter(p =>
        p.length > 1 && !/^(usr|bin|local|lib|etc|tmp|var|opt|home|Users|node_modules|\.bin)$/i.test(p)
      ).pop();
      if (label && label !== name) return label;
    }
  }
  if (cwd && cwd !== '/' && cwd !== HOME) {
    const parts = cwd.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && !/^(bin|lib|etc|tmp|Desktop|root)$/i.test(last)) return last;
  }
  return null;
}

function shortDir(cwd) {
  if (!cwd) return '';
  return cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd;
}

async function enrichWithDetails(ports) {
  const pids = [...new Set(ports.map(p => p.pid))];
  if (!pids.length) return ports;
  const pidStr = pids.join(',');
  const cmdMap = {}, cwdMap = {};

  try {
    const { stdout } = await execAsync(`/bin/ps -p ${pidStr} -o pid=,args=`);
    for (const line of stdout.trim().split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) cmdMap[m[1]] = m[2];
    }
  } catch {}

  try {
    const { stdout } = await execAsync(
      `/usr/sbin/lsof -a -p ${pidStr} -d cwd -F pn 2>/dev/null`
    );
    let cur = null;
    for (const line of stdout.trim().split('\n')) {
      if (line[0] === 'p') cur = line.slice(1);
      else if (line[0] === 'n' && cur) { cwdMap[cur] = line.slice(1); cur = null; }
    }
  } catch {}

  return ports.map(p => {
    const cmd = cmdMap[p.pid] || '';
    const cwd = cwdMap[p.pid] || '';
    return { ...p, cmd, dir: shortDir(cwd), label: extractLabel(p.name, cmd, cwd) };
  });
}

async function getOpenPorts() {
  try {
    const { stdout } = await execAsync('/usr/sbin/lsof -i -P -n | /usr/bin/grep LISTEN');
    const seen = new Map();
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const addrField = parts.slice(8).join(' ');
      const match = addrField.match(/:(\d+)\s+\(LISTEN\)/);
      if (!match) continue;
      const port = match[1];
      if (!seen.has(port)) seen.set(port, { pid: parts[1], name: parts[0], port });
    }
    const ports = [...seen.values()].sort((a, b) => Number(a.port) - Number(b.port));
    return enrichWithDetails(ports);
  } catch { return []; }
}

async function killProcess(pid) {
  const safePid = String(pid).replace(/\D/g, '');
  if (!safePid) return { success: false, error: 'PID inválido' };
  try {
    await execAsync(`/bin/kill -9 ${safePid}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── window + tray ─────────────────────────────────────────────────────────────

let win  = null;
let tray = null;

function showWindow() {
  if (!win) return;
  const tb = tray.getBounds();
  const [winW, winH] = win.getSize();
  const display = screen.getDisplayMatching(tb);
  const { bounds } = display;

  let x = Math.round(tb.x + tb.width / 2 - winW / 2);
  const y = Math.round(tb.y + tb.height + 2);
  x = Math.max(bounds.x + 8, Math.min(x, bounds.x + bounds.width - winW - 8));

  win.setPosition(x, y);
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 640,
    minWidth: 540,
    minHeight: 440,
    backgroundColor: '#0d0d10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  // Close button hides the window instead of quitting
  win.on('close', e => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  const img = nativeImage.createFromBuffer(createIconPNG(2), { scaleFactor: 2 });
  img.setTemplateImage(true); // auto-adapts to light/dark menu bar

  tray = new Tray(img);
  tray.setToolTip('Port Manager');

  tray.on('click', () => {
    win && win.isVisible() ? win.hide() : showWindow();
  });

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Port Manager', click: showWindow },
    { type: 'separator' },
    { label: 'Iniciar no login', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }) },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.dock.hide(); // hide from macOS Dock

  // Enable "start at login" on first run
  if (!app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  }

  createWindow();
  createTray();
  showWindow(); // show once on first launch
});

app.on('window-all-closed', () => { /* keep alive as menu bar app */ });
app.on('before-quit', () => { app.isQuitting = true; });

ipcMain.handle('get-ports', async () => getOpenPorts());
ipcMain.handle('kill-port', async (_, pid) => killProcess(pid));
