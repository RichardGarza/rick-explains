import { app, BrowserWindow, dialog, net } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root: repo in dev, extraResources in packaged app. */
function projectRoot() {
  if (app.isPackaged) {
    return join(process.resourcesPath, "rick-explains");
  }
  return join(__dirname, "..");
}

function resourcesRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return join(__dirname, "..", "vendor");
}

function bundledOllamaBin() {
  if (app.isPackaged) {
    for (const rel of ["ollama/ollama", "bin/ollama"]) {
      const p = join(process.resourcesPath, rel);
      if (existsSync(p)) return p;
    }
  }
  const dev = join(__dirname, "..", "vendor", "ollama", "ollama");
  return existsSync(dev) ? dev : null;
}

function bundledModelsDir() {
  if (app.isPackaged) {
    const p = join(process.resourcesPath, "ollama-models");
    if (existsSync(p)) return p;
  }
  const dev = join(__dirname, "..", "vendor", "ollama-models");
  return existsSync(dev) ? dev : null;
}

function bundledKokoroDir() {
  if (app.isPackaged) {
    const p = join(process.resourcesPath, "kokoro-model");
    if (existsSync(join(p, "config.json"))) return p;
  }
  const dev = join(__dirname, "..", "vendor", "kokoro-model");
  return existsSync(join(dev, "config.json")) ? dev : null;
}

function getFreePort(preferred = 3000) {
  return new Promise((resolve, reject) => {
    const tryListen = (port) => {
      const server = createServer();
      server.unref();
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE" && port < preferred + 50) {
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        const { port: p } = server.address();
        server.close(() => resolve(p));
      });
    };
    tryListen(preferred);
  });
}

function waitForUrl(url, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return resolve();
      } catch {
        /* not ready */
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`${url} not ready within ${timeoutMs / 1000}s`));
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}


/** Chromium network stack for article pages — Electron/Node undici+BoringSSL
 *  fails hard on some CDNs (e.g. WaPo HTTP/2 INTERNAL_ERROR). */
let fetchHelperServer = null;
let fetchHelperUrl = null;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function startFetchHelper() {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer(async (req, res) => {
      const send = (code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      };
      if (req.method === "GET" && req.url === "/health") {
        return send(200, { ok: true });
      }
      if (req.method !== "POST" || req.url !== "/fetch") {
        return send(404, { error: "not found" });
      }
      let raw = "";
      try {
        for await (const chunk of req) raw += chunk;
        const { url } = JSON.parse(raw || "{}");
        if (!url) return send(400, { error: "url required" });
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) {
          return send(400, { error: "Only http(s) links work." });
        }
        const r = await net.fetch(parsed.href, {
          headers: {
            "User-Agent": BROWSER_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        const html = await r.text();
        send(200, { status: r.status, url: r.url, html });
      } catch (err) {
        send(502, { error: err?.message || String(err) });
      }
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      fetchHelperServer = srv;
      fetchHelperUrl = `http://127.0.0.1:${port}`;
      console.log(`[fetch-helper] Chromium net.fetch on ${fetchHelperUrl}`);
      resolve(fetchHelperUrl);
    });
    srv.on("error", reject);
  });
}

let serverProcess = null;
let ollamaProcess = null;
let mainWindow = null;
let embeddedOllamaPort = null;

function killChild(proc, label) {
  if (!proc || proc.killed) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  try {
    if (proc?.pid) process.kill(-proc.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (proc && !proc.killed && proc.pid) {
        proc.kill("SIGKILL");
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, 2000);
  if (label === "server") serverProcess = null;
  if (label === "ollama") ollamaProcess = null;
}

function killAllChildren() {
  killChild(serverProcess, "server");
  killChild(ollamaProcess, "ollama");
  if (fetchHelperServer) {
    try {
      fetchHelperServer.close();
    } catch {
      /* ignore */
    }
    fetchHelperServer = null;
    fetchHelperUrl = null;
  }
}

async function startEmbeddedOllama() {
  const bin = bundledOllamaBin();
  const models = bundledModelsDir();
  if (!bin || !models) {
    console.warn("[ollama] bundled binary/models missing; skipping embed");
    return null;
  }

  try {
    chmodSync(bin, 0o755);
  } catch {
    /* ignore */
  }

  // Prefer 11435 so we don't collide with a system Ollama on 11434.
  const port = await getFreePort(11435);
  const userData = app.getPath("userData");
  const ollamaHome = join(userData, "ollama-home");
  mkdirSync(ollamaHome, { recursive: true });
  mkdirSync(join(userData, "ollama-tmp"), { recursive: true });

  const env = {
    ...process.env,
    HOME: ollamaHome,
    OLLAMA_MODELS: models,
    OLLAMA_HOST: `127.0.0.1:${port}`,
    OLLAMA_TMPDIR: join(userData, "ollama-tmp"),
    // Avoid pulling; we ship the model.
    OLLAMA_NOPRUNE: "true",
  };

  console.log(`[ollama] starting bundled serve on 127.0.0.1:${port}`);
  console.log(`[ollama] models=${models}`);
  ollamaProcess = spawn(bin, ["serve"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let stderrBuf = "";
  ollamaProcess.stdout?.on("data", (d) => process.stdout.write(`[ollama] ${d}`));
  ollamaProcess.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    process.stderr.write(`[ollama] ${d}`);
  });

  ollamaProcess.on("error", (err) => {
    console.error("[ollama] spawn error:", err);
  });
  ollamaProcess.on("exit", (code, signal) => {
    console.log(`[ollama] exited code=${code} signal=${signal}`);
    ollamaProcess = null;
  });

  await waitForUrl(`http://127.0.0.1:${port}/api/tags`, 90000).catch((err) => {
    throw new Error(
      `Bundled Ollama did not start: ${err.message}\n${stderrBuf.slice(-1500)}`
    );
  });

  embeddedOllamaPort = port;
  return port;
}

async function startServer(ollamaPort) {
  const root = projectRoot();
  const serverJs = join(root, "server.js");
  if (!existsSync(serverJs)) {
    throw new Error(`server.js not found at ${serverJs}`);
  }

  const port = await getFreePort(Number(process.env.PORT) || 3000);
  const kokoroPath = bundledKokoroDir();

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
  };
  if (fetchHelperUrl) {
    env.ELECTRON_FETCH_HELPER = fetchHelperUrl;
  }

  if (ollamaPort) {
    env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`;
    env.OLLAMA_HOST = `127.0.0.1:${ollamaPort}`;
    env.OLLAMA_MODEL = "qwen2.5:7b";
  } else if (app.isPackaged) {
    // Packaged without embed should still prefer qwen if something is reachable.
    env.OLLAMA_MODEL = env.OLLAMA_MODEL || "qwen2.5:7b";
  }

  if (kokoroPath) {
    env.KOKORO_MODEL_PATH = kokoroPath;
  }

  // Electron binary as Node — no system Node required.
  const nodeBin = process.execPath;
  const args = ["--env-file-if-exists=.env", "server.js"];

  console.log(`[server] spawn ELECTRON_RUN_AS_NODE via ${nodeBin}`);
  serverProcess = spawn(nodeBin, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let stderrBuf = "";
  serverProcess.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    process.stderr.write(`[server] ${d}`);
  });

  let exited = false;
  const earlyExit = new Promise((_, reject) => {
    serverProcess.on("error", (err) => reject(err));
    serverProcess.on("exit", (code, signal) => {
      exited = true;
      if (code && code !== 0) {
        reject(
          new Error(
            `Server exited early (code ${code}${signal ? `, signal ${signal}` : ""}).\n${stderrBuf.slice(-2000)}`
          )
        );
      } else if (!mainWindow) {
        reject(
          new Error(`Server exited before ready (code ${code}).\n${stderrBuf.slice(-2000)}`)
        );
      }
    });
  });

  await Promise.race([
    waitForUrl(`http://127.0.0.1:${port}/api/config`, 90000),
    earlyExit,
  ]);
  if (exited) throw new Error("Server exited unexpectedly after becoming ready");
  return port;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    title: "Rick Explains",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  try {
    await startFetchHelper();
    let ollamaPort = null;
    // Always prefer bundled Ollama when available (packaged or vendor present).
    if (bundledOllamaBin() && bundledModelsDir()) {
      ollamaPort = await startEmbeddedOllama();
    }
    const port = await startServer(ollamaPort);
    createWindow(port);
  } catch (err) {
    console.error(err);
    dialog.showErrorBox(
      "Rick Explains failed to start",
      String(err?.message || err)
    );
    killAllChildren();
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on("window-all-closed", () => {
    killAllChildren();
    app.quit();
  });

  app.on("before-quit", () => {
    killAllChildren();
  });

  app.on("will-quit", () => {
    killAllChildren();
  });
}
