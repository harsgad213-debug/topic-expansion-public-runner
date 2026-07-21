import fs from "fs";
import path from "path";
import { ProxyAgent, fetch } from "undici";
import { createRequire } from "module";
import { hierarchicalPartition } from "../src/semantic_partitioner.js";

// Browser automation adapter for Phase 1 (CommonJS module â†’ ESM import)
const require = createRequire(import.meta.url);
const {
  generateInitialSynthesis,
  launchBrowserContext,
} = require("../src/chatgpt-browser-adapter.cjs");
const {
  generateGithubPhase1Synthesis,
} = require("../src/github-phase1-synthesis.cjs");

// Shared browser context â€” launched once, reused across all topics and prompt types
let sharedBrowserContext = null;

async function getBrowserContext() {
  if (!sharedBrowserContext) {
    console.log(`[browser-adapter] Launching shared browser context...`);
    sharedBrowserContext = await launchBrowserContext();

    // Non-interactive login: wait for page stability
    const pages = sharedBrowserContext.pages();
    const loginPage =
      pages.length > 0 ? pages[0] : await sharedBrowserContext.newPage();
    await loginPage.goto("https://chatgpt.com/");
    console.log(`[browser-adapter] Waiting 5s for page stability...`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return sharedBrowserContext;
}

// Toggle: set USE_BROWSER_PHASE1=true to use browser automation instead of API for Phase 1
const USE_BROWSER_PHASE1 =
  process.env.USE_BROWSER_PHASE1 === "true" ||
  process.env.USE_BROWSER_PHASE1 === "1";
const USE_GITHUB_PHASE1 =
  process.env.USE_GITHUB_PHASE1 === "true" ||
  process.env.USE_GITHUB_PHASE1 === "1";

let ignoredSocketErrors = 0;

process.on("uncaughtException", (err) => {
  const isKnownTransport =
    err?.name === "SocketError" && err?.message === "other side closed";
  if (isKnownTransport) {
    ignoredSocketErrors++;
    console.warn(
      `[CRASH-GUARD] Ignoring known transport disconnect (${ignoredSocketErrors}): ${err.name}: ${err.message}`,
    );
    return;
  }
  console.error("[CRASH-GUARD] Uncaught exception:", err);
  console.error(err?.stack);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[CRASH-GUARD] Unhandled rejection: ${reason}`);
  process.exit(1);
});

const ENRICHED_CSV =
  process.env.CSV_PATH ||
  "C:/Users/Harshad/Downloads/udemy-scraper/udemy_enriched.csv";
const META_DIR =
  process.env.META_DIR ||
  "C:/Users/Harshad/Downloads/udemy-scraper/synthetic_transcript_metadata";
const outBaseDir =
  process.env.OUT_DIR ||
  "C:/Users/Harshad/course-summary-pipeline/knowledge_output";
if (!fs.existsSync(outBaseDir)) fs.mkdirSync(outBaseDir, { recursive: true });
function loadKeysFromEnv(name) {
  const raw = process.env[name] || "";
  const fromInline = raw
    .split(/[\r\n,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  const filePath = process.env[`${name}_FILE`];
  if (!filePath) return fromInline;
  const fromFile = fs
    .readFileSync(filePath, "utf8")
    .split(/[\r\n,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  return [...fromInline, ...fromFile];
}

function safeBucketId(key, model) {
  let hash = 2166136261;
  for (const ch of String(key || "")) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `key-${(hash >>> 0).toString(36)}:${model}`;
}

const GROQ_KEYS = loadKeysFromEnv("GROQ_KEYS");
const GEMINI_KEYS = loadKeysFromEnv("GEMINI_KEYS");
const CEREBRAS_KEYS = loadKeysFromEnv("CEREBRAS_KEYS");
const GEMINI_KEYS_EXTRA = loadKeysFromEnv("GEMINI_KEYS_EXTRA");

const PROXY_FILE = process.env.PROXY_FILE || "proxies.txt";
const ALL_PROXIES = fs.existsSync(PROXY_FILE)
  ? fs
      .readFileSync(PROXY_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  : [];

const GROQ_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3.6-27b",
];

const CEREBRAS_MODELS = ["gpt-oss-120b", "zai-glm-4.7"];

const MISTRAL_KEYS = loadKeysFromEnv("MISTRAL_KEYS");
const MISTRAL_MODELS = [
  "mistral-large-latest",
  "mistral-medium-3.5",
  "devstral-2512",
  "codestral-2508",
  "mistral-small-2506",
];

const CLOUDFLARE_KEYS = loadKeysFromEnv("CLOUDFLARE_KEYS");
const CLOUDFLARE_MODELS = ["@cf/openai/gpt-oss-120b"];

const GITHUB_KEYS = loadKeysFromEnv("GITHUB_KEYS");
const GITHUB_MODELS = [
  "openai/gpt-4o",
  "deepseek/deepseek-v3-0324",
  "openai/gpt-4.1",
  "deepseek/deepseek-r1-0528",
  "deepseek/deepseek-r1",
  "mistral-ai/mistral-medium-2505",
  "meta/llama-4-maverick-17b-128e-instruct-fp8",
  "meta/llama-3.3-70b-instruct",
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "microsoft/phi-4",
  "mistral-ai/codestral-2501",
];

const ALL_BUCKETS = [];

if (!process.env.DISABLE_GITHUB) {
  for (const k of GITHUB_KEYS) {
    for (const m of GITHUB_MODELS)
      ALL_BUCKETS.push({
        provider: "github",
        key: k,
        model: m,
        id: safeBucketId(k, m),
      });
  }
}

if (!process.env.DISABLE_GROQ) {
  for (const k of GROQ_KEYS) {
    for (const m of GROQ_MODELS)
      ALL_BUCKETS.push({ provider: "groq", key: k, model: m, id: safeBucketId(k, m) });
  }
}
if (!process.env.DISABLE_GEMINI) {
  // Models confirmed to accept 120K+ token Phase 1 prompts (verified by gemini_model_matrix.js)
  const GEMINI_PHASE1_MODELS = [
    "gemini-3.1-flash-lite", // 15 RPM/key, 500 RPD/key â€” primary
    "gemini-3-flash-preview", //  5 RPM/key, 20 RPD/key â€” confirmed
    "gemini-2.5-flash", //  5 RPM/key, 20 RPD/key â€” confirmed
    // 'gemini-2.5-flash-lite' â€” removed: "no longer available to new users" at runtime
  ];
  for (const k of [...GEMINI_KEYS, ...GEMINI_KEYS_EXTRA]) {
    for (const m of GEMINI_PHASE1_MODELS) {
      ALL_BUCKETS.push({
        provider: "gemini",
        key: k,
        model: m,
        id: safeBucketId(k, m),
      });
    }
  }
}
if (!process.env.DISABLE_CEREBRAS) {
  for (const k of CEREBRAS_KEYS) {
    for (const m of CEREBRAS_MODELS)
      ALL_BUCKETS.push({
        provider: "cerebras",
        key: k,
        model: m,
        id: safeBucketId(k, m),
      });
  }
}
if (!process.env.DISABLE_MISTRAL) {
  for (const k of MISTRAL_KEYS) {
    for (const m of MISTRAL_MODELS)
      ALL_BUCKETS.push({
        provider: "mistral",
        key: k,
        model: m,
        id: safeBucketId(k, m),
      });
  }
}
if (!process.env.DISABLE_CLOUDFLARE) {
  for (const k of CLOUDFLARE_KEYS) {
    for (const m of CLOUDFLARE_MODELS)
      ALL_BUCKETS.push({
        provider: "cloudflare",
        key: k,
        model: m,
        id: safeBucketId(k, m),
      });
  }
}

for (let i = ALL_BUCKETS.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [ALL_BUCKETS[i], ALL_BUCKETS[j]] = [ALL_BUCKETS[j], ALL_BUCKETS[i]];
}

const keyDailyUsage = new Map();
const SOFT_DAILY_CAP = 180;
const rateLimiters = new Map();

class RateLimiter {
  constructor(max, refillPerSec) {
    this.max = max;
    this.tokens = max;
    this.refill = refillPerSec;
    this.last = Date.now();
  }
  canConsume() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.max, this.tokens + elapsed * this.refill);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

const UAs = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "python-requests/2.31.0",
  "PostmanRuntime/7.36.0",
  "curl/8.4.0",
  "groq-python/0.4.2",
];
const keyUaMap = new Map();
function getStickyUa(key) {
  if (!keyUaMap.has(key)) {
    keyUaMap.set(key, UAs[Math.floor(Math.random() * UAs.length)]);
  }
  return keyUaMap.get(key);
}

const groqLatencies = [];
const geminiLatencies = [];
const cerebrasLatencies = [];
const mistralLatencies = [];
const githubLatencies = [];
const cloudflareLatencies = [];

// --- PER-PROVIDER COUNTERS ---
const providerStats = {
  groq: {
    requests: 0,
    successes: 0,
    failures: 0,
    rate429s: 0,
    failureTypes: {},
  },
  gemini: {
    requests: 0,
    successes: 0,
    failures: 0,
    rate429s: 0,
    failureTypes: {},
  },
  cerebras: {
    requests: 0,
    successes: 0,
    failures: 0,
    rate429s: 0,
    failureTypes: {},
  },
  mistral: {
    requests: 0,
    successes: 0,
    failures: 0,
    rate429s: 0,
    failureTypes: {},
  },
  github: {
    requests: 0,
    successes: 0,
    failures: 0,
    rate429s: 0,
    failureTypes: {},
  },
  cloudflare: {
    requests: 0,
    successes: 0,
    failures: 0,
    rate429s: 0,
    failureTypes: {},
  },
};

// --- PER-MODEL COUNTERS ---
const modelStats = new Map();
function getModelStats(model) {
  if (!modelStats.has(model)) {
    modelStats.set(model, {
      requests: 0,
      successes: 0,
      failures: 0,
      rate429s: 0,
      timeouts: 0,
      latencies: [],
    });
  }
  return modelStats.get(model);
}

const REQUEST_TIMEOUT_MS = 180000;

const deadProxies = new Set();
const keyProxyMap = new Map();
const inFlightBucket = new Map();
const coolingBucket = new Map();
const tpdExhausted = new Map();
const proxyHealth = new Map();
// Restore proxy health from disk if available
try {
  const phPath = path.join(outBaseDir, "proxy-health.json");
  if (fs.existsSync(phPath)) {
    const raw = fs.readFileSync(phPath, "utf8");
    if (raw.trim()) {
      const phArr = JSON.parse(raw);
      if (Array.isArray(phArr)) {
        let restoredCount = 0;
        let deadRestoredCount = 0;
        for (const entry of phArr) {
          if (!entry.proxy || typeof entry.proxy !== "string") continue;
          const { proxy, ...rest } = entry;
          // Normalize missing fields from legacy entries
          rest.successes = rest.successes || 0;
          rest.failures = rest.failures || 0;
          rest.consecutiveFailures = rest.consecutiveFailures || 0;
          rest.maxRecoveredFailureStreak = rest.maxRecoveredFailureStreak || 0;
          if (rest.firstSuccessAfterFailures === undefined)
            rest.firstSuccessAfterFailures = null;
          if (rest.lastSuccessAt === undefined) rest.lastSuccessAt = null;
          if (rest.lastFailureAt === undefined) rest.lastFailureAt = null;
          if (rest.lastFailureCode === undefined) rest.lastFailureCode = null;
          if (rest.lastAttemptAt === undefined) rest.lastAttemptAt = null;
          if (!rest.errors) rest.errors = {};
          // Mark legacy entries that predate persistence
          if (rest.historyComplete === undefined) rest.historyComplete = false;
          proxyHealth.set(proxy, rest);
          restoredCount++;
          // Restore dead proxy state only for entries with complete history
          if (rest.historyComplete === true && rest.consecutiveFailures >= 50) {
            deadProxies.add(proxy);
            deadRestoredCount++;
          }
        }
        console.log(
          `[Startup] Restored proxy health for ${restoredCount} proxies (${deadRestoredCount} dead) from disk.`,
        );
      }
    }
  }
} catch (e) {
  console.warn(`[Startup] Could not restore proxy health: ${e.message}`);
}
const proxyAgents = new Map();
const bucketRequestsThisRun = new Map();
const first403Reported = new Set();

// --- VALIDATION METRICS ---
let totalRequests = 0;
let total429s = 0;
let total429_TPD = 0;
let total429_TPM = 0;
let total429_RPM = 0;
let total429_Context = 0;
let total429_Unknown = 0;
let exhaustedBucketsLogged = new Set();
let totalWaitTime = 0;
let waitCount = 0;
let newlyCompletedCount = 0;
const pipelineStartTime = Date.now();

setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`\n--- [TELEMETRY] ---`);
  console.log(
    `Memory: RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB | Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB/${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB`,
  );

  // Queue Telemetry
  let coolingCount = 0;
  let availableCount = 0;
  let inFlightCount = 0;
  let exhaustedCount = 0;
  const now = Date.now();
  for (const item of ALL_BUCKETS) {
    const bucket = item.id;
    if (tpdExhausted.get(bucket)) exhaustedCount++;
    else if ((inFlightBucket.get(bucket) || 0) > 0) inFlightCount++;
    else if ((coolingBucket.get(bucket) || 0) > now) coolingCount++;
    else availableCount++;
  }
  console.log(`Queue State:`);
  console.log(`  In-Flight Buckets: ${inFlightCount}`);
  console.log(`  Cooling Buckets: ${coolingCount}`);
  console.log(`  Exhausted Buckets (TPD): ${exhaustedCount}`);
  console.log(`  Available Buckets: ${availableCount}`);
  console.log(
    `  Pending Courses (Total queue depth managed by mapLimit): ${globalBatchCounter}`,
  );

  if (total429s > 0) {
    console.log(`429 Breakdown:`);
    console.log(
      `  TPD (Exhaustion): ${((total429_TPD / total429s) * 100).toFixed(1)}%`,
    );
    console.log(`  TPM: ${((total429_TPM / total429s) * 100).toFixed(1)}%`);
    console.log(`  RPM: ${((total429_RPM / total429s) * 100).toFixed(1)}%`);
    console.log(
      `  Context: ${((total429_Context / total429s) * 100).toFixed(1)}%`,
    );
    console.log(
      `  Unknown: ${((total429_Unknown / total429s) * 100).toFixed(1)}%`,
    );
  }
  console.log(`Provider Stats:  Reqs    | OK      | Fail    | 429s    | Succ%`);
  for (const [p, s] of Object.entries(providerStats)) {
    if (s.requests === 0) continue;
    const succRate = ((s.successes / s.requests) * 100).toFixed(1);
    console.log(
      `  ${p.padEnd(12)} ${String(s.requests).padStart(7)} | ${String(s.successes).padStart(7)} | ${String(s.failures).padStart(7)} | ${String(s.rate429s).padStart(7)} | ${succRate}%`,
    );
  }
  console.log(`-------------------\n`);

  // APPEND PRODUCTION METRICS
  try {
    const hoursElapsed = (Date.now() - pipelineStartTime) / (1000 * 60 * 60);
    const coursesPerHour =
      hoursElapsed > 0 ? (newlyCompletedCount / hoursElapsed).toFixed(2) : 0;
    const rate =
      totalRequests === 0 ? 0 : ((total429s / totalRequests) * 100).toFixed(2);
    let diskFree = "N/A";
    try {
      const stats = fs.statfsSync(outBaseDir);
      diskFree = ((stats.bavail * stats.bsize) / 1024 ** 3).toFixed(1) + " GB";
    } catch (e) {}

    const efficiency =
      totalRequests === 0
        ? 0
        : (newlyCompletedCount / totalRequests).toFixed(4);

    function getP(arr, p) {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const pos = (sorted.length - 1) * p;
      const base = Math.floor(pos);
      const rest = pos - base;
      return sorted[base + 1] !== undefined
        ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
        : sorted[base];
    }

    const metricLine =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        uptimeHours: hoursElapsed.toFixed(2),
        completedCourses: newlyCompletedCount,
        coursesPerHour: coursesPerHour,
        totalRequests: totalRequests,
        total429s: total429s,
        rate429: rate + "%",
        memoryRss: (mem.rss / 1024 / 1024).toFixed(1) + "MB",
        diskFree: diskFree,
        activeBuckets: availableCount,
        exhaustedCount: exhaustedCount,
        coolingCount: coolingCount,
        efficiency: efficiency,
        providerStats: providerStats,
        modelStats: Object.fromEntries(
          [...modelStats.entries()].map(([m, s]) => {
            const sorted = [...s.latencies].sort((a, b) => a - b);
            return [
              m,
              {
                requests: s.requests,
                successes: s.successes,
                failures: s.failures,
                rate429s: s.rate429s,
                timeouts: s.timeouts,
                timeoutPct:
                  s.requests > 0
                    ? ((s.timeouts / s.requests) * 100).toFixed(1) + "%"
                    : "0%",
                p50: getP(s.latencies, 0.5).toFixed(0),
                p90: getP(s.latencies, 0.9).toFixed(0),
                p95: getP(s.latencies, 0.95).toFixed(0),
                p99: getP(s.latencies, 0.99).toFixed(0),
              },
            ];
          }),
        ),
        groqP50: getP(groqLatencies, 0.5).toFixed(0),
        groqP95: getP(groqLatencies, 0.95).toFixed(0),
        geminiP50: getP(geminiLatencies, 0.5).toFixed(0),
        geminiP95: getP(geminiLatencies, 0.95).toFixed(0),
        cerebrasP50: getP(cerebrasLatencies, 0.5).toFixed(0),
        cerebrasP95: getP(cerebrasLatencies, 0.95).toFixed(0),
        mistralP50: getP(mistralLatencies, 0.5).toFixed(0),
        mistralP95: getP(mistralLatencies, 0.95).toFixed(0),
        githubP50: getP(githubLatencies, 0.5).toFixed(0),
        githubP95: getP(githubLatencies, 0.95).toFixed(0),
        cloudflareP50: getP(cloudflareLatencies, 0.5).toFixed(0),
        cloudflareP95: getP(cloudflareLatencies, 0.95).toFixed(0),
        avgSchedulerWaitMs:
          waitCount > 0 ? (totalWaitTime / waitCount).toFixed(1) : "0",
        totalSchedulerWaitS: (totalWaitTime / 1000).toFixed(1),
        concurrency: 150,
        efficiencyPerWorker:
          hoursElapsed > 0
            ? (newlyCompletedCount / hoursElapsed / 150).toFixed(2)
            : "0",
      }) + "\n";
    fs.appendFileSync(
      path.join(outBaseDir, "production-metrics.jsonl"),
      metricLine + "\n",
    );

    try {
      const phArr = Array.from(proxyHealth.entries()).map(([k, v]) => ({
        proxy: k,
        ...v,
      }));
      const phPath = path.join(outBaseDir, "proxy-health.json");
      const tmpPath = phPath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(phArr, null, 2));
      try {
        fs.unlinkSync(phPath);
      } catch (e) {}
      fs.renameSync(tmpPath, phPath);
    } catch (e) {}
  } catch (e) {
    console.error("Failed to write metrics:", e.message);
  }
}, 60000);
let globalBatchCounter = 0;

function getStickyProxy(key) {
  if (!keyProxyMap.has(key) || deadProxies.has(keyProxyMap.get(key))) {
    const available = ALL_PROXIES.filter((p) => !deadProxies.has(p));
    if (available.length === 0) throw new Error("ALL PROXIES ARE DEAD!");
    const p = available[Math.floor(Math.random() * available.length)];
    keyProxyMap.set(key, p);
  }
  return keyProxyMap.get(key);
}

function getHealth(p) {
  if (!proxyHealth.has(p)) {
    proxyHealth.set(p, {
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      maxRecoveredFailureStreak: 0,
      firstSuccessAfterFailures: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastAttemptAt: null,
      errors: {},
      historyComplete: true,
    });
  }
  return proxyHealth.get(p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function sanitizePath(s) {
  return String(s || "Unknown")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function buildTopicLookup(csvPath) {
  console.log(`Loading topic lookup from ${csvPath}...`);
  const lookup = new Map();
  if (!fs.existsSync(csvPath)) return lookup;
  const content = fs.readFileSync(csvPath, "utf8");
  const lines = content.split("\n");

  const header = lines[0];
  const cols = header.split(",");
  const idIdx = cols.indexOf("id");
  let topicIdx = -1;
  for (let i = cols.length - 1; i >= 0; i--) {
    if (cols[i].trim() === "topic") {
      topicIdx = i;
      break;
    }
  }

  if (idIdx === -1 || topicIdx === -1) return lookup;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = [];
    let field = "";
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') inQuotes = !inQuotes;
      else if (line[c] === "," && !inQuotes) {
        fields.push(field);
        field = "";
      } else field += line[c];
    }
    fields.push(field);

    const courseId = fields[idIdx]?.replace(/"/g, "").trim();
    const topic = fields[topicIdx]?.replace(/"/g, "").trim();

    if (courseId && topic) {
      const cleanTopic = topic.split("|")[0].trim();
      lookup.set(courseId, cleanTopic);
    }
  }
  return lookup;
}

function getOutputPath(courseData, courseId, topicLookup) {
  const category = sanitizePath(courseData.category);
  const subcategory = sanitizePath(courseData.subcategory);
  const topic = sanitizePath(topicLookup.get(courseId) || "General");

  const titleSlug = sanitizePath(courseData.title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);

  return path.join(
    outBaseDir,
    category,
    subcategory,
    topic,
    `${titleSlug}_[${courseId}].md`,
  );
}

function findCourseFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      findCourseFiles(fullPath, fileList);
    } else if (file.endsWith("_context.json")) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

async function fetchWithProxyRetry(
  messages,
  batchIndex,
  courseName,
  requireSmartModel = false,
  requireLargeContext = false,
) {
  let attempts = 0;
  let serverErrors = 0;
  // proxyFailures removed â€” proxy banning now uses per-proxy h.consecutiveFailures

  while (true) {
    if (attempts > 50) {
      throw new Error(
        `Failed to process batch after 50 attempts! All buckets might be permanently exhausted.`,
      );
    }

    const waitStart = Date.now();
    let selectedKey = null;
    let selectedModel = null;
    let bucket = null;
    let selectedProvider = null;

    while (!selectedKey) {
      const now = Date.now();
      const startIdx = Math.floor(Math.random() * ALL_BUCKETS.length);
      for (let i = 0; i < ALL_BUCKETS.length; i++) {
        const item = ALL_BUCKETS[(startIdx + i) % ALL_BUCKETS.length];
        const b = item.id;
        const m = item.model.toLowerCase();

        if (requireSmartModel) {
          const isSmart =
            m.includes("gpt-4") ||
            m.includes("claude") ||
            m.includes("gemini") ||
            m.includes("llama-3.3-70b") ||
            m.includes("deepseek");
          if (!isSmart) continue;
        }

        if (requireLargeContext) {
          // Phase 1: ONLY Gemini can handle 120K+ token synthesis prompts
          const isLarge = m.includes("gemini");
          if (!isLarge) continue;
        } else {
          // Phase 2/3: Reserve Gemini exclusively for Phase 1 â€” skip it here.
          // Phase 3 expansion prompts are small and can be handled by all other providers.
          if (m.includes("gemini")) continue;
        }

        if ((keyDailyUsage.get(b) || 0) >= SOFT_DAILY_CAP) continue;

        if (!rateLimiters.has(b)) rateLimiters.set(b, new RateLimiter(2, 0.5));
        if (!rateLimiters.get(b).canConsume()) continue;

        if (
          !tpdExhausted.get(b) &&
          (inFlightBucket.get(b) || 0) === 0 &&
          (coolingBucket.get(b) || 0) < now
        ) {
          selectedKey = item.key;
          selectedModel = item.model;
          selectedProvider = item.provider;
          bucket = b;
          break;
        }
      }

      if (!selectedKey) {
        let allExhausted = true;
        for (const item of ALL_BUCKETS) {
          if (!tpdExhausted.get(item.id)) {
            allExhausted = false;
            break;
          }
        }
        if (allExhausted)
          throw new Error(
            "ALL BUCKETS EXHAUSTED FOR THE DAY. Pipeline cannot continue.",
          );
        await sleep(500);
      }
    }
    const keyWaitMs = Date.now() - waitStart;
    const shortKey = selectedKey.slice(-4);

    totalWaitTime += keyWaitMs;
    waitCount++;
    totalRequests++;
    if (providerStats[selectedProvider])
      providerStats[selectedProvider].requests++;
    getModelStats(selectedModel).requests++;

    attempts++;

    const proxyStr = getStickyProxy(selectedKey);
    const proxyUrl = `http://${proxyStr}`;
    const userAgent = getStickyUa(selectedKey);

    let dispatcher = proxyAgents.get(proxyStr);
    if (!dispatcher) {
      dispatcher = new ProxyAgent({
        uri: proxyUrl,
        connections: 10,
        requestTls: { rejectUnauthorized: false },
        connect: { timeout: 10000 },
        keepAliveTimeout: 30000,
        keepAliveMaxTimeout: 60000,
      });
      proxyAgents.set(proxyStr, dispatcher);
    }

    const reqId = Math.random().toString(36).substring(7);
    const startMs = Date.now();

    const kCount = (inFlightBucket.get(bucket) || 0) + 1;
    inFlightBucket.set(bucket, kCount);
    bucketRequestsThisRun.set(
      bucket,
      (bucketRequestsThisRun.get(bucket) || 0) + 1,
    );

    let success = false;
    let finalContent = "";
    let finalUsage = 0;

    // Inject micro-jitter to prevent exactly-synchronized bursts
    await sleep(Math.random() * 250);

    try {
      // INSTRUMENTATION: Log exact firing timestamp to test the synchronized burst hypothesis
      if (selectedProvider === "github") {
        try {
          const fireMs = Date.now();
          const instrLine = JSON.stringify({
            fireMs,
            provider: selectedProvider,
            model: selectedModel,
            reqId: reqId,
            batchIndex: batchIndex,
          });
          fs.appendFileSync(
            path.join(outBaseDir, "github-burst-telemetry.jsonl"),
            instrLine + "\\n",
          );
        } catch (e) {}
      }

      let res;
      if (selectedProvider === "gemini") {
        const systemMsg =
          messages.find((m) => m.role === "system")?.content || "";
        const userMsg = messages.find((m) => m.role === "user")?.content || "";
        const combinedText = systemMsg
          ? `System: ${systemMsg}\n\nUser: ${userMsg}`
          : userMsg;

        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${selectedKey}`,
          {
            method: "POST",
            dispatcher: dispatcher,
            headers: {
              "Content-Type": "application/json",
              "User-Agent": userAgent,
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: combinedText }] }],
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
      } else if (selectedProvider === "cerebras") {
        res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
          method: "POST",
          dispatcher: dispatcher,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${selectedKey}`,
            "User-Agent": userAgent,
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: messages,
            max_completion_tokens: 3000,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } else if (selectedProvider === "mistral") {
        res = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          dispatcher: dispatcher,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${selectedKey}`,
            "User-Agent": userAgent,
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: messages,
            max_tokens: 3000,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } else if (selectedProvider === "github") {
        res = await fetch(
          "https://models.github.ai/inference/chat/completions",
          {
            method: "POST",
            dispatcher: dispatcher,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${selectedKey}`,
              "User-Agent": userAgent,
            },
            body: JSON.stringify({
              model: selectedModel,
              messages: messages,
              max_tokens: 3000,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
      } else if (selectedProvider === "cloudflare") {
        res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/9a3746654b9d0dc6b231daebccbd92fb/ai/run/${selectedModel}`,
          {
            method: "POST",
            dispatcher: dispatcher,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${selectedKey}`,
              "User-Agent": userAgent,
            },
            body: JSON.stringify({ messages: messages, max_tokens: 3000 }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
      } else {
        res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          dispatcher: dispatcher,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${selectedKey}`,
            "User-Agent": userAgent,
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: messages,
            max_tokens: 3000,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      }

      if ((process.env.TEST_STAGE || "").trim().toLowerCase() === "isolation") {
        const chaos = Math.random();
        if (chaos < 0.1) {
          throw new Error("timeout (Simulated Failure Injection)");
        } else if (chaos < 0.2) {
          res = {
            ok: false,
            status: 500,
            text: async () => "Internal Server Error (Simulated)",
            headers: { get: () => null },
          };
        } else if (chaos < 0.3) {
          res.json = async () => {
            throw new Error(
              "Unexpected token < in JSON at position 0 (Simulated Malformed Output)",
            );
          };
        }
      }

      if (!res.ok) {
        if (res.status === 429) {
          total429s++;
          if (providerStats[selectedProvider])
            providerStats[selectedProvider].rate429s++;
          getModelStats(selectedModel).rate429s++;
          const bodyText = await res.text().catch(() => "{}");

          if (selectedProvider === "gemini") {
            if (bodyText.includes("per day")) {
              tpdExhausted.set(bucket, true);
              console.warn(
                `[REQ ${reqId}] ðŸš¨ GEMINI TPD EXHAUSTED on ${shortKey}. Locked for the day!`,
              );
            } else {
              total429_RPM++;
              const retryAfter = res.headers.get("retry-after");
              const cooldownMs = retryAfter
                ? parseFloat(retryAfter) * 1000
                : 60000;
              console.warn(
                `[REQ ${reqId}] âš ï¸ GEMINI 429 on ${shortKey} | Cooling ${cooldownMs / 1000}s`,
              );
              coolingBucket.set(bucket, Date.now() + cooldownMs);
            }
          } else if (selectedProvider === "mistral") {
            total429_RPM++;
            // Mistral uses ratelimit headers
            const remTokens = res.headers.get(
              "x-ratelimit-remaining-tokens-minute",
            );
            const cooldownMs = 60000; // Mistral pools reset per minute
            console.warn(
              `[REQ ${reqId}] âš ï¸ MISTRAL 429 on ${shortKey} (${selectedModel}) | RemTokens: ${remTokens} | Cooling 60s`,
            );
            coolingBucket.set(bucket, Date.now() + cooldownMs);
          } else if (selectedProvider === "cloudflare") {
            total429_RPM++;
            console.warn(
              `[REQ ${reqId}] âš ï¸ CLOUDFLARE 429 on ${shortKey} (${selectedModel}) | Cooling 60s`,
            );
            coolingBucket.set(bucket, Date.now() + 60000);
          } else if (
            bodyText.includes("tokens per day (TPD)") ||
            res.headers.get("x-ratelimit-type") === "UserByModelByDay"
          ) {
            total429_TPD++;
            tpdExhausted.set(bucket, true);
            console.warn(
              `[REQ ${reqId}] ðŸš¨ TPD EXHAUSTED on ${selectedModel} via ${shortKey}. Locked for the day!`,
            );
            try {
              if (!exhaustedBucketsLogged.has(bucket)) {
                exhaustedBucketsLogged.add(bucket);
                fs.appendFileSync(
                  path.join(outBaseDir, "exhausted-buckets.jsonl"),
                  JSON.stringify({
                    bucket: bucket,
                    shortKey: shortKey,
                    model: selectedModel,
                    exhaustedAt: new Date().toISOString(),
                  }) + "\n",
                );
              }
            } catch (e) {}
          } else {
            if (bodyText.includes("tokens_per_minute")) total429_TPM++;
            else if (bodyText.includes("requests_per_minute")) total429_RPM++;
            else if (
              bodyText.includes("context_length") ||
              bodyText.includes("input_too_large")
            )
              total429_Context++;
            else total429_Unknown++;

            const retryAfter = res.headers.get("retry-after");
            const cooldownMs = retryAfter
              ? parseFloat(retryAfter) * 1000
              : 60000;
            console.warn(
              `[REQ ${reqId}] âš ï¸ 429 on ${shortKey} (${selectedModel}) | Cooling ${cooldownMs / 1000}s`,
            );
            coolingBucket.set(bucket, Date.now() + cooldownMs);

            // Log full headers for GitHub 429s to diagnose rate limit type
            if (selectedProvider === "github") {
              try {
                const hdrs = {};
                res.headers.forEach((v, k) => {
                  hdrs[k] = v;
                });
                fs.appendFileSync(
                  path.join(outBaseDir, "github-429-headers.jsonl"),
                  JSON.stringify({
                    timestamp: new Date().toISOString(),
                    key: shortKey,
                    model: selectedModel,
                    retryAfter: retryAfter,
                    rateLimitType: res.headers.get("x-ratelimit-type"),
                    bodySnippet: bodyText.slice(0, 500),
                    headers: hdrs,
                  }) + "\n",
                );
              } catch (e) {}
            }
          }
          getHealth(proxyStr).lastAttemptAt = Date.now();
          continue;
        }
        if (res.status >= 500) {
          serverErrors++;
          if (serverErrors > 5)
            throw new Error(`500 Server Error Cap Exceeded`);
          console.warn(
            `[REQ ${reqId}] [Server Error] ${res.status}. Retrying...`,
          );
          getHealth(proxyStr).lastAttemptAt = Date.now();
          await sleep(5000);
          continue;
        }
        const text = await res.text();
        if (
          [400, 401, 403, 404].includes(res.status) ||
          text.includes("organization_restricted")
        ) {
          console.warn(
            `[REQ ${reqId}] Account Banned/Unauthorized/Restricted (Status: ${res.status}). Response: ${text}. Locking bucket permanently.`,
          );
          try {
            if (!first403Reported.has(bucket)) {
              first403Reported.add(bucket);

              let reason = "Unknown";
              if (text.includes("organization_restricted"))
                reason = "organization_restricted";
              else if (res.status === 401) reason = "unauthorized";
              else if (res.status === 403) reason = "forbidden";
              else if (res.status === 404) reason = "not_found";
              else if (res.status === 400) reason = "bad_request";

              const tEvent = JSON.stringify({
                timestamp: new Date().toISOString(),
                event: "first_state_change",
                provider: selectedProvider,
                key: selectedKey.slice(-4),
                model: selectedModel,
                status: res.status,
                reason: reason,
                bucketRequests: bucketRequestsThisRun.get(bucket) || 0,
                uptimeSeconds: Math.floor(
                  (Date.now() - pipelineStartTime) / 1000,
                ),
              });
              fs.appendFileSync(
                path.join(outBaseDir, "bucket-state-changes.jsonl"),
                tEvent + "\n",
              );
            }
          } catch (e) {}
          getHealth(proxyStr).lastAttemptAt = Date.now();
          tpdExhausted.set(bucket, true);
          continue;
        }
        throw new Error(`API Error ${res.status}: ${text}`);
      }

      const data = await res.json();
      let content = "";
      if (selectedProvider === "gemini") {
        content = data.candidates?.[0]?.content?.parts?.[0]?.text;
        finalUsage = data.usageMetadata?.totalTokenCount || 0;
      } else if (selectedProvider === "cloudflare") {
        content = data.result?.response;
        finalUsage = 0; // Cloudflare doesn't return usage in /run/
      } else {
        content = data.choices?.[0]?.message?.content;
        finalUsage = data.usage?.total_tokens || 0;
      }

      if (!content || content.trim() === "") {
        console.warn(`[REQ ${reqId}] âš ï¸ Empty content from model. Retrying...`);
        // Proxy worked fine (got 200 + JSON), so reset its failure counter
        const tempH = getHealth(proxyStr);
        if (tempH.firstSuccessAfterFailures === null) {
          tempH.firstSuccessAfterFailures = tempH.consecutiveFailures || 0;
        }
        tempH.maxRecoveredFailureStreak = Math.max(
          tempH.maxRecoveredFailureStreak || 0,
          tempH.consecutiveFailures || 0,
        );
        tempH.consecutiveFailures = 0;
        tempH.lastAttemptAt = Date.now();
        await sleep(2000);
        continue;
      }

      const h = getHealth(proxyStr);
      if (h.firstSuccessAfterFailures === null) {
        h.firstSuccessAfterFailures = h.consecutiveFailures || 0;
      }
      h.successes++;
      h.maxRecoveredFailureStreak = Math.max(
        h.maxRecoveredFailureStreak || 0,
        h.consecutiveFailures || 0,
      );
      h.consecutiveFailures = 0;
      h.lastSuccessAt = Date.now();
      h.lastAttemptAt = Date.now();

      success = true;
      finalContent = content;

      const durationMs = Date.now() - startMs;
      const latMap = {
        gemini: geminiLatencies,
        cerebras: cerebrasLatencies,
        mistral: mistralLatencies,
        github: githubLatencies,
        cloudflare: cloudflareLatencies,
        groq: groqLatencies,
      };
      const latArr = latMap[selectedProvider] || groqLatencies;
      latArr.push(durationMs);
      if (latArr.length > 100) latArr.shift();
      if (providerStats[selectedProvider])
        providerStats[selectedProvider].successes++;
      const ms = getModelStats(selectedModel);
      ms.successes++;
      ms.latencies.push(durationMs);
      if (ms.latencies.length > 200) ms.latencies.shift();
      console.log(
        `[REQ ${reqId}] âœ… SUCCESS | Batch: ${batchIndex} | Bucket: ${shortKey}(${selectedModel}) | Wait: ${keyWaitMs}ms | Proxy: ${proxyStr} | Duration: ${durationMs}ms`,
      );
    } catch (err) {
      if (err.name === "AbortError" || err.message.includes("timeout")) {
        // Fallthrough
      } else if (
        err.message.includes("Banned") ||
        err.message.includes("Exceeded") ||
        err.message.includes("Unauthorized")
      ) {
        throw err;
      } else if (err.message.includes("API Error")) {
        console.warn(
          `[REQ ${reqId}] API Error (likely 413 context limit). Retrying with another model...`,
        );
        if (bucket) coolingBucket.set(bucket, Date.now() + 300000); // Cool the small-context model bucket for 5 mins
      }

      const errCode = err.code || err.name || "UNKNOWN";
      const errMsg = err.message;
      const h = getHealth(proxyStr);
      h.failures++;
      h.consecutiveFailures++;
      h.lastFailureAt = Date.now();
      h.lastAttemptAt = Date.now();
      h.lastFailureCode =
        typeof err.cause?.code === "string"
          ? err.cause.code
          : typeof err.code === "string"
            ? err.code
            : null;
      h.lastFailureCauseCode = err.cause?.code ?? null;
      h.lastFailureName = err.name ?? null;
      h.lastFailureMessage = err.message ?? null;
      h.lastFailureCauseName = err.cause?.name ?? null;
      h.lastFailureCauseMessage = err.cause?.message ?? null;
      h.errors[errCode] = (h.errors[errCode] || 0) + 1;

      if (providerStats[selectedProvider]) {
        providerStats[selectedProvider].failures++;
        const fType =
          err.name === "AbortError" || err.message.includes("timeout")
            ? "AbortError/Timeout"
            : err.code || err.name || "UNKNOWN";
        providerStats[selectedProvider].failureTypes[fType] =
          (providerStats[selectedProvider].failureTypes[fType] || 0) + 1;
        const msf = getModelStats(selectedModel);
        msf.failures++;
        if (fType === "AbortError/Timeout") msf.timeouts++;
      }
      console.log(
        `[REQ ${reqId}] âŒ FAILURE | Batch: ${batchIndex} | Bucket: ${shortKey}(${selectedModel}) | Proxy: ${proxyStr} | Error: ${errCode} - ${errMsg}`,
      );

      if (h.consecutiveFailures >= 50) {
        console.log(
          `[Auto-Heal] Proxy ${proxyStr} reached 50 consecutive failures. Banning...`,
        );
        deadProxies.add(proxyStr);
      }

      await sleep(2000);
    } finally {
      if (bucket)
        inFlightBucket.set(bucket, (inFlightBucket.get(bucket) || 1) - 1);
    }

    if (success) {
      keyDailyUsage.set(bucket, (keyDailyUsage.get(bucket) || 0) + 1);

      if (selectedProvider === "cerebras") {
        // Enforce 5 RPM limit for Cerebras
        coolingBucket.set(bucket, Date.now() + 12000);
      }

      await sleep(500 + Math.random() * 2000);
      return {
        content: finalContent,
        usage: finalUsage,
        attempts,
        usedProxy: proxyUrl,
        shortKey: shortKey,
        usedModel: selectedModel,
      };
    }
  }
}

async function mapLimit(arr, limit, asyncFn) {
  const results = [];
  const executing = [];
  for (const item of arr) {
    const p = asyncFn(item).then((result) => {
      executing.splice(executing.indexOf(p), 1);
      return result;
    });
    results.push(p);
    executing.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

const ORGANIZED_DIR =
  process.env.ORGANIZED_DIR ||
  "C:/Users/Harshad/Downloads/FreshArchive/organized";

function findTopicFolders(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  const folders = [];
  for (const item of items) {
    if (item.isDirectory()) {
      const fullPath = path.join(dir, item.name);
      const subItems = fs.readdirSync(fullPath, { withFileTypes: true });

      const hasTranscriptsFolder = subItems.some(
        (si) => si.isDirectory() && si.name === "transcripts",
      );
      const hasDirectTxts = subItems.some(
        (si) => si.isFile() && si.name.endsWith(".txt"),
      );
      const hasOtherDirs = subItems.some(
        (si) =>
          si.isDirectory() &&
          si.name !== "response_parts" &&
          si.name !== "transcripts",
      );

      if (hasTranscriptsFolder || (hasDirectTxts && !hasOtherDirs)) {
        folders.push(fullPath);
      } else {
        folders.push(...findTopicFolders(fullPath));
      }
    }
  }
  return folders;
}

function readNonNegativeIntEnv(name, fallback = null) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(name + " must be a non-negative integer.");
  }
  return value;
}

function buildInitialSynthesisPrompt(rawTranscript, promptType, topicName) {
  let systemPrompt = "";
  let userPrompt = "";

  if (promptType === "full_book") {
    systemPrompt =
      "You are an expert AI assistant helping to explain course material.";
    userPrompt = `explain with full mapping and example as i want to understand full book(entire book's content pgs) at once-${topicName}`;
  } else if (promptType === "unit_overview") {
    systemPrompt =
      "You are an expert AI assistant helping to explain course material.";
    userPrompt = `explain everything about this unit from this book, explain with full mapping and example as i want to understand complete unit from this entire book all at once. -${topicName}`;
  } else if (promptType === "knowledge_map") {
    systemPrompt =
      "You are an expert AI assistant helping to explain course material.";
    userPrompt = `explain with full mapping and example as i want to understand full book at once - I have created combined transcripts of all these courses in this book -${topicName}`;
  }

  return [
    {
      role: "system",
      content: `${systemPrompt} Output only the requested material in Markdown format. Do not use conversational filler or introductory/outro text.`,
    },
    {
      role: "user",
      content: `Here is the full raw transcript:\n\n<context>\n${rawTranscript}\n</context>\n\n${userPrompt}`,
    },
  ];
}

function buildExpansionPrompt(sectionContent) {
  return [
    {
      role: "system",
      content:
        "You are an expert AI assistant expanding a specific section of a textbook draft. Output only the requested material in Markdown format. Do not use conversational filler.",
    },
    {
      role: "user",
      content: `Continue from THIS exact structural region only.

Preserve:
- exact progression
- exact subsection order
- exact hierarchy
- formulas
- tables
- examples
- transition logic
- mappings
- flows

Do NOT reorganize concepts.
Do NOT summarize.
Do NOT restructure pedagogy.
Do NOT merge sections.

Expand ONLY by adding deeper explanation BETWEEN the existing structure.

SECTION:
${sectionContent}`,
    },
  ];
}

async function runStageA(topicFolders) {
  // Stage A: Browser Phase 1 â€” collect initial syntheses for ALL topics
  console.log("\n\n=== STAGE A: Initial Synthesis Collection ===");

  if (USE_BROWSER_PHASE1) {
    console.log("[STAGE A] USE_BROWSER_PHASE1 set - using browser automation for Phase 1");
  } else if (USE_GITHUB_PHASE1) {
    console.log("[STAGE A] USE_GITHUB_PHASE1 set - using staged GitHub API synthesis for Phase 1");
  } else {
    console.log("[STAGE A] USE_BROWSER_PHASE1 not set - using inline API for Phase 1");
  }

  const artifactTypes = ["full_book", "unit_overview", "knowledge_map"];
  const STAGE_A_TOPIC_CONCURRENCY =
    Math.max(1, readNonNegativeIntEnv("STAGE_A_TOPIC_CONCURRENCY", 1) || 1);
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  console.log("[STAGE A] Topic concurrency: " + STAGE_A_TOPIC_CONCURRENCY);

  await mapLimit(topicFolders, STAGE_A_TOPIC_CONCURRENCY, async (folder) => {
    const topicName = path.basename(folder);
    let transcriptsDir = path.join(folder, "transcripts");
    if (!fs.existsSync(transcriptsDir)) {
      transcriptsDir = folder;
    }

    const files = fs
      .readdirSync(transcriptsDir)
      .filter((f) => f.endsWith(".txt"))
      .sort();
    if (files.length === 0) return;

    const responsePartsDir = path.join(folder, "response_parts");
    fs.mkdirSync(responsePartsDir, { recursive: true });

    for (const type of artifactTypes) {
      const fullPath = path.join(
        responsePartsDir,
        topicName + "_" + type + "_FULL.txt",
      );

      // Checkpoint: skip if already exists
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 100) {
        skipped++;
        continue;
      }

      try {
        let initialText;

        if (USE_BROWSER_PHASE1) {
          console.log(
            "[STAGE A] Browser synthesis for " +
              topicName +
              " (" +
              type +
              ")...",
          );
          const context = await getBrowserContext();
          const txtFilePaths = files.map((f) => path.join(transcriptsDir, f));
          initialText = await generateInitialSynthesis(
            txtFilePaths,
            topicName,
            type,
            {
              context,
              nonInteractive: true,
            },
          );
        } else if (USE_GITHUB_PHASE1) {
          console.log(
            "[STAGE A] GitHub staged synthesis for " +
              topicName +
              " (" +
              type +
              ")...",
          );
          initialText = await generateGithubPhase1Synthesis({
            topicName,
            transcriptsDir,
            files,
            metadataDir: META_DIR,
            responsePartsDir,
            promptType: type,
            githubKeys: GITHUB_KEYS,
            githubModels: GITHUB_MODELS,
            log: (message) => console.log("[STAGE A][GitHub Phase1] " + message),
          });
        } else {
          console.log(
            "[STAGE A] API synthesis for " + topicName + " (" + type + ")...",
          );
          let fullContent = "";
          for (const f of files) {
            fullContent +=
              fs.readFileSync(path.join(transcriptsDir, f), "utf-8") + "\n\n";
          }
          const initialMessages = buildInitialSynthesisPrompt(
            fullContent,
            type,
            topicName,
          );
          const initialResult = await fetchWithProxyRetry(
            initialMessages,
            0,
            topicName,
            true,
            true,
          );
          initialText = initialResult.content;
        }

        // Save initial synthesis
        const tmpPath = fullPath + ".tmp";
        fs.writeFileSync(tmpPath, initialText);
        fs.renameSync(tmpPath, fullPath);
        completed++;
        console.log(
          "[STAGE A] Saved " +
            topicName +
            "_" +
            type +
            "_FULL.txt (" +
            initialText.length +
            " chars)",
        );
      } catch (e) {
        failed++;
        console.error(
          "[STAGE A] FAILED: " + topicName + " (" + type + "): " + e.message,
        );
        fs.appendFileSync(
          path.join(outBaseDir, "stage-a-dlq.json"),
          JSON.stringify({
            topicFolder: folder,
            type,
            error: e.message,
            timestamp: new Date().toISOString(),
          }) + "\n",
        );
      }
    }
  });

  console.log("\n=== STAGE A COMPLETE ===");
  console.log(
    "Completed: " +
      completed +
      " | Skipped: " +
      skipped +
      " | Failed: " +
      failed,
  );
}

async function runStageB(topicFolders) {
  // Stage B: API Phase 2 â€” partition ALL initial syntheses
  console.log("\n\n=== STAGE B: Partitioning (API) ===");

  const artifactTypes = ["full_book", "unit_overview", "knowledge_map"];
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const folder of topicFolders) {
    const topicName = path.basename(folder);
    const responsePartsDir = path.join(folder, "response_parts");

    for (const type of artifactTypes) {
      const mapPath = path.join(responsePartsDir, "MAP_" + type + ".json");
      const fullPath = path.join(
        responsePartsDir,
        topicName + "_" + type + "_FULL.txt",
      );

      // Checkpoint: skip if MAP already exists
      if (fs.existsSync(mapPath)) {
        skipped++;
        continue;
      }

      // Require Stage A output
      if (!fs.existsSync(fullPath)) {
        console.log(
          "[STAGE B] SKIP: No FULL.txt for " +
            topicName +
            " (" +
            type +
            ") â€” Stage A not complete",
        );
        continue;
      }

      try {
        const initialText = fs.readFileSync(fullPath, "utf-8");
        if (!initialText.trim()) {
          console.log(
            "[STAGE B] SKIP: Empty synthesis for " +
              topicName +
              " (" +
              type +
              ")",
          );
          continue;
        }

        console.log(
          "[STAGE B] Partitioning " + topicName + " (" + type + ")...",
        );

        // Custom LLM caller for the partitioner
        const callLLM = async (prompt) => {
          const messages = [{ role: "user", content: prompt }];
          const result = await fetchWithProxyRetry(
            messages,
            0,
            topicName,
            true,
          );
          return result.content;
        };

        const sections = await hierarchicalPartition(initialText, callLLM);

        const tmpPath = mapPath + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(sections, null, 2));
        fs.renameSync(tmpPath, mapPath);
        completed++;
        console.log(
          "[STAGE B] Partitioned " +
            topicName +
            " (" +
            type +
            "): " +
            sections.length +
            " sections",
        );
      } catch (e) {
        failed++;
        console.error(
          "[STAGE B] FAILED: " + topicName + " (" + type + "): " + e.message,
        );
        fs.appendFileSync(
          path.join(outBaseDir, "stage-b-dlq.json"),
          JSON.stringify({
            topicFolder: folder,
            type,
            error: e.message,
            timestamp: new Date().toISOString(),
          }) + "\n",
        );
      }
    }
  }

  console.log("\n=== STAGE B COMPLETE ===");
  console.log(
    "Completed: " +
      completed +
      " | Skipped: " +
      skipped +
      " | Failed: " +
      failed,
  );
}

async function runStageC(topicFolders) {
  // Stage C: API Phase 3 â€” expand ALL partitioned sections
  console.log("\n\n=== STAGE C: Expansion (API) ===");

  const artifactTypes = ["full_book", "unit_overview", "knowledge_map"];
  let totalExpanded = 0;
  let totalSkipped = 0;
  let failedTopics = 0;

  for (const folder of topicFolders) {
    const topicName = path.basename(folder);
    const responsePartsDir = path.join(folder, "response_parts");

    for (const type of artifactTypes) {
      const mapPath = path.join(responsePartsDir, "MAP_" + type + ".json");

      // Require Stage B output
      if (!fs.existsSync(mapPath)) {
        continue;
      }

      try {
        const sections = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
        if (!sections || sections.length === 0) continue;

        console.log(
          "[STAGE C] Expanding " +
            topicName +
            " (" +
            type +
            "): " +
            sections.length +
            " sections...",
        );

        const mappedTasks = sections.map((sec, i) => ({
          section: sec,
          index: i,
          type,
        }));

        await mapLimit(mappedTasks, 6, async ({ section, index, type }) => {
          const partPath = path.join(
            responsePartsDir,
            topicName +
              "_" +
              type +
              "_PART_" +
              String(index).padStart(3, "0") +
              ".txt",
          );

          // Checkpoint: skip if already exists
          if (fs.existsSync(partPath) && fs.statSync(partPath).size > 0) {
            totalSkipped++;
            return { index, type, skipped: true };
          }

          const messages = buildExpansionPrompt(section.content);
          const result = await fetchWithProxyRetry(messages, index, topicName);

          const tmpPath = partPath + ".tmp";
          fs.writeFileSync(
            tmpPath,
            "# " + section.title + "\n\n" + result.content,
          );
          fs.renameSync(tmpPath, partPath);
          totalExpanded++;
          return { index, type };
        });
      } catch (e) {
        failedTopics++;
        console.error(
          "[STAGE C] FAILED: " + topicName + " (" + type + "): " + e.message,
        );
        fs.appendFileSync(
          path.join(outBaseDir, "stage-c-dlq.json"),
          JSON.stringify({
            topicFolder: folder,
            type,
            error: e.message,
            timestamp: new Date().toISOString(),
          }) + "\n",
        );
      }
    }

    // Write meta.json after all types for this topic
    const hasAnyPart = artifactTypes.some((t) =>
      fs.existsSync(path.join(responsePartsDir, "MAP_" + t + ".json")),
    );
    if (hasAnyPart) {
      fs.writeFileSync(
        path.join(responsePartsDir, "_meta.json"),
        JSON.stringify(
          {
            topicName,
            timestamp: new Date().toISOString(),
            architecture:
              "Staged 3-Phase (Stage A: Browser Init -> Stage B: API Partition -> Stage C: API Expand)",
          },
          null,
          2,
        ),
      );
      newlyCompletedCount++;
    }
  }

  console.log("\n=== STAGE C COMPLETE ===");
  console.log(
    "Expanded: " +
      totalExpanded +
      " | Skipped: " +
      totalSkipped +
      " | Failed topics: " +
      failedTopics,
  );
}

async function run() {
  console.log("\n\n=== TOPIC EXPANSION PIPELINE (STAGED) ===");

  console.log("Scanning for topic folders in " + ORGANIZED_DIR + "...");
  const allTopicFolders = findTopicFolders(ORGANIZED_DIR);

  let remainingFolders = allTopicFolders;
  const TEST_STAGE = (process.env.TEST_STAGE || "production")
    .trim()
    .toLowerCase();
  if (TEST_STAGE === "smoke") remainingFolders = remainingFolders.slice(0, 2);
  else if (TEST_STAGE === "functional")
    remainingFolders = remainingFolders.slice(0, 10);
  else if (TEST_STAGE === "stress")
    remainingFolders = remainingFolders.slice(0, 100);
  else if (TEST_STAGE === "isolation")
    remainingFolders = remainingFolders.slice(0, 3);

  const stageSelectedCount = remainingFolders.length;
  const TOPIC_SHARD_COUNT = readNonNegativeIntEnv("TOPIC_SHARD_COUNT", 1) || 1;
  const TOPIC_SHARD_INDEX = readNonNegativeIntEnv("TOPIC_SHARD_INDEX", 0) || 0;
  if (TOPIC_SHARD_COUNT < 1) {
    throw new Error("TOPIC_SHARD_COUNT must be at least 1.");
  }
  if (TOPIC_SHARD_INDEX >= TOPIC_SHARD_COUNT) {
    throw new Error("TOPIC_SHARD_INDEX must be lower than TOPIC_SHARD_COUNT.");
  }
  if (TOPIC_SHARD_COUNT > 1) {
    remainingFolders = remainingFolders.filter(
      (_folder, index) => index % TOPIC_SHARD_COUNT === TOPIC_SHARD_INDEX,
    );
  }

  const TOPIC_OFFSET = readNonNegativeIntEnv("TOPIC_OFFSET", 0) || 0;
  const TOPIC_LIMIT = readNonNegativeIntEnv("TOPIC_LIMIT", null);
  if (TOPIC_OFFSET || TOPIC_LIMIT != null) {
    const end =
      TOPIC_LIMIT == null ? undefined : TOPIC_OFFSET + TOPIC_LIMIT;
    remainingFolders = remainingFolders.slice(TOPIC_OFFSET, end);
  }

  console.log(
    "[STAGE: " +
      TEST_STAGE.toUpperCase() +
      "] " +
      remainingFolders.length +
      " topics to process",
  );
  console.log("[TOPICS_DISCOVERED: " + allTopicFolders.length + "]");
  console.log("[TOPICS_AFTER_STAGE: " + stageSelectedCount + "]");
  console.log(
    "[TOPIC_SHARD: " +
      TOPIC_SHARD_INDEX +
      "/" +
      TOPIC_SHARD_COUNT +
      " | OFFSET: " +
      TOPIC_OFFSET +
      " | LIMIT: " +
      (TOPIC_LIMIT == null ? "none" : TOPIC_LIMIT) +
      "]",
  );

  const PIPELINE_STAGE = (process.env.PIPELINE_STAGE || "all")
    .trim()
    .toLowerCase();
  console.log("[PIPELINE_STAGE: " + PIPELINE_STAGE.toUpperCase() + "]");

  // Run stages in order (or single stage)
  if (PIPELINE_STAGE === "a" || PIPELINE_STAGE === "all") {
    await runStageA(remainingFolders);
  }
  if (PIPELINE_STAGE === "b" || PIPELINE_STAGE === "all") {
    await runStageB(remainingFolders);
  }
  if (PIPELINE_STAGE === "c" || PIPELINE_STAGE === "all") {
    await runStageC(remainingFolders);
  }

  console.log("\n=== FINAL ACCOUNTING ===");
  console.log("Completed This Run: " + newlyCompletedCount);
  console.log("Pipeline Finished!");
  console.log("\n=== VALIDATION METRICS ===");
  console.log("Total Requests: " + totalRequests);
  console.log("Total 429s: " + total429s);
  console.log("  -> TPD Limits (Daily Exhaustion): " + total429_TPD);
  console.log("  -> TPM Limits: " + total429_TPM);
  console.log("  -> RPM Limits: " + total429_RPM);
  console.log("  -> Context/Size Limits: " + total429_Context);
  console.log("  -> Unknown: " + total429_Unknown);
  console.log(
    "429 Rate: " +
      ((total429s / Math.max(1, totalRequests)) * 100).toFixed(2) +
      "%",
  );
  console.log(
    "Average Wait Time: " +
      Math.round(totalWaitTime / Math.max(1, waitCount)) +
      "ms",
  );

  // Close browser if it was opened
  if (sharedBrowserContext) {
    await sharedBrowserContext.close().catch(() => {});
  }

  process.exit(0);
}

run().catch(console.error);

