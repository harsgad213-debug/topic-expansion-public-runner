/**
 * ChatGPT Browser Automation Adapter for Phase 1
 *
 * This module wraps the legacy browser automation pattern to replace
 * the API-based Phase 1 synthesis with ChatGPT file-upload based synthesis.
 *
 * It is a SELF-CONTAINED adapter — it does NOT import the legacy file.
 * It reimplements only the minimal mechanisms needed for Phase 1:
 *   - Browser launch (persistent context, anti-automation flags)
 *   - File upload (with retry)
 *   - Prompt submission (Enter + send-button fallback)
 *   - Response detection (start + stabilization)
 *   - Response extraction (DOM text + canvas)
 *
 * Output: a plain text string — the same interface as the old fetchWithProxyRetry().content
 *
 * Per docs/GLM_LEGACY_CONTRACT.md: preserve all operational behaviors.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ─── Constants (from LEGACY_BEHAVIORAL_SPEC.md) ──────────────────────────────
const CHATGPT_URL = 'https://chatgpt.com/';
const MAX_STABILIZE_MS = 30 * 60 * 1000; // 30 min
const MAX_UPLOAD_RETRIES = 3;

const PROFILE_DIR = path.join(
  os.homedir(),
  'AppData',
  'Local',
  'chatgpt-playwright-profile',
);

// ─── Prompts (identical to legacy PROMPTS and pipeline buildInitialSynthesisPrompt) ──
const PROMPTS = {
  full_book: (name) =>
    `explain with full mapping and example as i want to understand full book(entire book's content pgs) at once-${name}`,
  unit_overview: (name) =>
    `explain everything about this unit from this book, explain with full mapping and example as i want to understand complete unit from this entire book all at once. -${name}`,
  knowledge_map: (name) =>
    `explain with full mapping and example as i want to understand full book at once - I have created combined transcripts of all these courses in this book -${name}`,
};

// ─── Browser Launch (mechanisms #50, #51, #52) ────────────────────────────────
// Seam #2: accepts an optional profile dir so callers (e.g. an account-pool
// that rotates profiles) can launch into a specific profile. Defaults to the
// hardcoded PROFILE_DIR, so existing callers (Stage A, etc.) are unaffected.
async function launchBrowserContext(profileDir = PROFILE_DIR) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--profile-directory=Default',
      '--start-maximized',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--js-flags=--max-old-space-size=4096',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Block heavy resources (mechanism #52)
  await context.route('**/*', (route) => {
    const url = route.request().url();
    const type = route.request().resourceType();

    if (
      ['image', 'media', 'font'].includes(type) ||
      url.includes('analytics') ||
      url.includes('tracking') ||
      url.includes('sentry') ||
      url.includes('events')
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return context;
}

// ─── Response State Extraction (mechanisms #13–17, #109) ─────────────────────
async function extractCompleteResponseState(page, assistantStartIndex = 0) {
  return await page.evaluate((startIndex) => {
    const msgs = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]'),
    );

    const stopBtn = document.querySelector('[data-testid="stop-button"]');
    const streaming = !!stopBtn && !stopBtn.disabled;

    if (!msgs.length) {
      return { text: '', streaming, hasCanvas: false };
    }

    const relevantMsgs = msgs.slice(startIndex);

    // Auto-click continue/show more/expand buttons (mechanism #13)
    relevantMsgs.forEach((msg) => {
      msg.querySelectorAll('button').forEach((btn) => {
        const txt = btn.innerText?.toLowerCase() || '';
        if (
          txt.includes('continue') ||
          txt.includes('show more') ||
          txt.includes('expand')
        ) {
          try { btn.click(); } catch {}
        }
      });
    });

    // Recursive text collection (mechanism #14)
    function collect(node) {
      let text = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName?.toLowerCase();
          if (['p','div','section','article','br','li','ul','ol','h1','h2','h3','h4','pre','code'].includes(tag)) {
            text += '\n';
          }
          text += collect(child);
          if (['p','div','section','article','li','ul','ol','h1','h2','h3','h4','pre'].includes(tag)) {
            text += '\n';
          }
        }
      }
      return text;
    }

    const chatText = relevantMsgs.map((msg) => collect(msg)).join('\n\n');

    // Canvas capture (mechanism #15)
    let canvasText = '';
    let hasCanvas = false;
    const canvasSelectors = [
      '[data-testid="canvas"]',
      '[data-testid="canvas-panel"]',
      '.canvas-panel',
      '[class*="canvas"]',
      '[role="document"]',
      '.ce-block__content',
    ];
    for (const sel of canvasSelectors) {
      const canvasEls = document.querySelectorAll(sel);
      if (canvasEls.length > 0) {
        hasCanvas = true;
        canvasEls.forEach((el) => {
          const txt = collect(el);
          if (txt.trim().length > 100) {
            canvasText += '\n\n' + txt;
          }
        });
        if (canvasText.trim().length > 100) break;
      }
    }

    // Fallback panel detection (mechanism #15)
    if (!canvasText.trim()) {
      const allPanels = document.querySelectorAll('[class*="thread"] ~ div, [class*="Panel"], [class*="panel"]');
      allPanels.forEach((panel) => {
        const txt = panel.innerText || '';
        if (txt.length > 500 && !panel.querySelector('[data-message-author-role]')) {
          hasCanvas = true;
          canvasText += '\n\n' + txt;
        }
      });
    }

    const combined = canvasText.trim()
      ? chatText + '\n\n--- CANVAS CONTENT ---\n\n' + canvasText
      : chatText;

    return {
      text: combined.replace(/\n{3,}/g, '\n\n').trim(),
      streaming,
      hasCanvas,
    };
  }, assistantStartIndex);
}

async function extractCompleteResponse(page, assistantStartIndex = 0) {
  const state = await extractCompleteResponseState(page, assistantStartIndex);
  return state.text;
}

// ─── Send Button Click (mechanism #21) ──────────────────────────────────────
async function clickSendButtonIfReady(page) {
  await page
    .evaluate(() => {
      const btn = document.querySelector('[data-testid="send-button"]');
      if (btn && !btn.disabled) {
        btn.click();
      }
    })
    .catch(() => {});
}

// ─── Submit Prompt (mechanisms #22–24) ──────────────────────────────────────
async function submitPrompt(page, promptType, previousUserCount) {
  const textarea = page.locator('#prompt-textarea').last();

  await textarea.focus();
  await page.waitForTimeout(300); // React tick
  await page.keyboard.press('Enter');

  let sent = false;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(600);
    const count = await page.evaluate(() => {
      return document.querySelectorAll('[data-message-author-role="user"]').length;
    });
    if (count > previousUserCount) {
      sent = true;
      break;
    }
  }

  if (!sent) {
    console.log(`[browser-adapter] Enter failed - clicking send button`);
    await textarea.focus();
    await page.waitForTimeout(200);
    await clickSendButtonIfReady(page);

    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const count = await page.evaluate(() => {
        return document.querySelectorAll('[data-message-author-role="user"]').length;
      });
      if (count > previousUserCount) {
        sent = true;
        break;
      }
    }
  }

  if (!sent) {
    console.error(`[browser-adapter] Warning: Could not confirm successful submission!`);
  }
}

// ─── Wait For Response (mechanisms #25–32) ───────────────────────────────────
async function waitForResponse(page, logPrefix = '', previousAssistantCount = 0) {
  if (page.isClosed()) {
    throw new Error('PageClosed');
  }

  console.log(`[browser-adapter:${logPrefix}] Waiting for response...`);

  let started = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await page.evaluate(async (prevCount) => {
        return new Promise((resolve) => {
          let loops = 0;
          const interval = setInterval(() => {
            loops++;
            const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (msgs.length > prevCount) {
              clearInterval(interval);
              resolve('started');
            }

            const textContent = document.body.innerText || '';
            // Memory / personalization modal (new ChatGPT feature). If this
            // appears, it blocks the response. Dismiss it inline by clicking
            // the "Got it" / close button, then keep polling for the actual
            // response start. This is the ONLY change needed for this modal.
            if (
              textContent.includes("More relevant, personalized replies") ||
              textContent.includes("keeping memory up to date")
            ) {
              document.querySelectorAll('button').forEach((btn) => {
                const t = (btn.innerText || '').toLowerCase();
                if (t.includes('got it') || t.includes('ok') || t.includes('close') || t.includes('dismiss')) {
                  try { btn.click(); } catch {}
                }
              });
              // Don't resolve — keep polling; the modal will be gone on the
              // next tick and we'll detect the real response start.
            }
            if (
              textContent.includes("You've reached our limit") ||
              textContent.includes("limit of messages") ||
              textContent.includes("Too many requests")
            ) {
              clearInterval(interval);
              resolve('limit');
            } else if (
              textContent.includes("There was an error generating") ||
              textContent.includes("Please wait for the previous response") ||
              textContent.includes("network error") ||
              textContent.includes("Something went wrong") ||
              textContent.includes("Conversation not found")
            ) {
              clearInterval(interval);
              resolve('error');
            }

            if (loops > 2400) {
              clearInterval(interval);
              resolve('timeout');
            }
          }, 500);
        });
      }, previousAssistantCount);

      if (result === 'limit') throw new Error('RateLimit');
      if (result === 'timeout') throw new Error('Timeout');
      if (result === 'error') throw new Error('GenerationError');
      if (result === 'started') {
        started = true;
        break;
      }
    } catch (e) {
      if (e.message === 'RateLimit') {
        console.log(`[browser-adapter:${logPrefix}] Rate limit detected, pausing 15 min...`);
        await page.waitForTimeout(15 * 60000 + 5000);
        await clickSendButtonIfReady(page);
        attempt--;
        continue;
      }
      console.log(`[browser-adapter:${logPrefix}] Response start retry ${attempt + 1} (${e.message})`);
      await clickSendButtonIfReady(page);
      await page.waitForTimeout(3000);
    }
  }

  if (!started) {
    throw new Error('Response never started');
  }

  // Stabilization loop (mechanisms #30–32)
  let previous = '';
  let stable = 0;
  let shortStable = 0;
  const start = Date.now();

  while (stable < 5) {
    if (Date.now() - start > MAX_STABILIZE_MS) {
      console.log(`[browser-adapter:${logPrefix}] Stabilization timeout`);
      break;
    }

    const state = await extractCompleteResponseState(page, previousAssistantCount);
    const txt = state.text;

    if (txt === previous && txt.length > 0 && !state.streaming) {
      if (txt.length > 1000) {
        stable++;
      } else {
        shortStable++;
      }
    } else {
      stable = 0;
      shortStable = 0;
    }

    if (txt.length <= 1000 && shortStable >= 12) {
      console.log(`[browser-adapter:${logPrefix}] Short/canvas response stabilized (${txt.length} chars).`);
      break;
    }

    previous = txt;
    await page.waitForTimeout(1200);
  }

  console.log(`[browser-adapter:${logPrefix}] Response stabilized.`);
}

// ─── Dismiss memory/personalization modal ─────────────────────────────────
// ChatGPT shows a "More relevant, personalized replies" modal on new
// conversations. It overlays the entire page and intercepts pointer events,
// so textarea.click() hangs for 30s. This dismisses it. Must be called
// BEFORE the upload loop's textarea.click() step, and ALSO retried a few
// times because the modal may appear slightly AFTER waitForSelector returns.
async function dismissMemoryModal(page, logPrefix = '') {
  // Try up to 5 times with 1s gaps — the modal may appear a moment after
  // the page loads, so the first attempt may not find it yet.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const dismissed = await page.evaluate(() => {
        // Try multiple selectors — the data-testid may vary across accounts/versions.
        const selectors = [
          '[data-testid="modal-m3m-nux"]',
          '[id*="modal-m3m"]',
          '[data-testid*="modal"]',
          '[class*="modal"][class*="nux"]',
        ];
        let modal = null;
        for (const sel of selectors) {
          modal = document.querySelector(sel);
          if (modal) break;
        }
        // Fallback: look for the modal by its text content.
        if (!modal) {
          const all = document.querySelectorAll('div.absolute.inset-0, [class*="absolute"][class*="inset-0"]');
          for (const el of all) {
            const t = (el.innerText || '').toLowerCase();
            if (t.includes('more relevant') || t.includes('keeping memory')) { modal = el; break; }
          }
        }
        if (!modal) return false;

        // Click any dismiss button inside the modal.
        const buttons = modal.querySelectorAll('button');
        for (const btn of buttons) {
          const t = (btn.innerText || '').toLowerCase();
          if (t.includes('got it') || t.includes('ok') || t.includes('close') || t.includes('dismiss') || t.includes('continue') || t.includes('next')) {
            try { btn.click(); } catch {}
            return true;
          }
        }
        // Fallback: click the last button in the modal.
        if (buttons.length > 0) {
          try { buttons[buttons.length - 1].click(); } catch {}
          return true;
        }
        // Last resort: hide the modal via CSS so it stops intercepting events.
        modal.style.display = 'none';
        return true;
      });
      if (dismissed) {
        console.log(`[browser-adapter:${logPrefix}] Dismissed memory/personalization modal (attempt ${attempt})`);
        await page.waitForTimeout(1000);
        // Verify it's actually gone — check if any overlay still intercepts.
        const stillThere = await page.evaluate(() => {
          const m = document.querySelector('[data-testid="modal-m3m-nux"], [id*="modal-m3m"]');
          return m && m.style.display !== 'none';
        });
        if (!stillThere) return; // done
        // If still there, the CSS hide worked — continue anyway.
        console.log(`[browser-adapter:${logPrefix}] Modal hidden via CSS (click may not have worked)`);
        return;
      }
      // Modal not found yet — wait and retry.
      await page.waitForTimeout(1000);
    } catch {
      await page.waitForTimeout(1000);
    }
  }
}

// ─── Setup Conversation with Upload (mechanisms #37–49) ─────────────────────
async function setupConversationWithUpload(page, zipPath, prompt, promptType, logPrefix = promptType) {
  if (page.isClosed()) {
    throw new Error('PageClosed');
  }

  console.log(`[browser-adapter:${logPrefix}] Loading ChatGPT...`);
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });

  // UI optimizations (mechanism #39)
  await page
    .addStyleTag({
      content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
      html, body { overflow: hidden !important; }
    `,
    })
    .catch(() => {});

  // Close sidebar (mechanism #40)
  await page
    .evaluate(() => {
      window.scrollTo = () => {};
      const btn = document.querySelector('[data-testid="close-sidebar-button"]');
      if (btn) btn.click();
    })
    .catch(() => {});

  await page.waitForSelector('#prompt-textarea', { timeout: 60000 });

  // Dismiss the "More relevant, personalized replies" / memory modal if it
  // appeared on page load. This modal (data-testid="modal-m3m-nux") overlays
  // the entire page and intercepts pointer events — so textarea.click() below
  // would hang for 30s. Must dismiss it BEFORE the upload loop.
  await dismissMemoryModal(page, logPrefix);

  const resolvedPaths = [zipPath];

  console.log(`[browser-adapter:${logPrefix}] Uploading ${resolvedPaths.length} file(s) and typing prompt...`);

  // Upload retry loop (mechanism #41)
  let uploadSuccess = false;
  for (let uploadAttempt = 1; uploadAttempt <= MAX_UPLOAD_RETRIES; uploadAttempt++) {
    try {
      await page.locator('#upload-files').setInputFiles(resolvedPaths);
      console.log(`[browser-adapter:${logPrefix}] Files attached (attempt ${uploadAttempt}/${MAX_UPLOAD_RETRIES}). Waiting for processing...`);

      // Fill prompt immediately (mechanism #41 — text typed to unlock send button)
      const textarea = page.locator('#prompt-textarea').last();
      await textarea.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(prompt);

      // Wait for upload to finish OR error (mechanisms #42, #45)
      const uploadResult = await page.evaluate(() => {
        return new Promise((resolve) => {
          let elapsed = 0;
          const interval = setInterval(() => {
            elapsed += 500;

            const bodyText = document.body.innerText || '';
            if (
              bodyText.includes('Unknown error') ||
              bodyText.includes('Something went wrong') ||
              bodyText.includes('error uploading') ||
              bodyText.includes('failed to upload') ||
              bodyText.includes('file is too large') ||
              bodyText.includes('Unable to upload')
            ) {
              clearInterval(interval);
              resolve('error');
              return;
            }

            const btn = document.querySelector('[data-testid="send-button"]');
            // Only treat as "ready" if the send button is enabled AND a file
            // attachment chip is present. Without this check, the send button
            // can be enabled by the prompt text alone — causing the adapter to
            // submit without the file actually being attached.
            const hasAttachment = document.querySelector(
              '[data-testid="attachment-draft-attachment-file"]'
            ) || document.querySelector('[class*="attachment"]');
            if (btn && !btn.disabled && hasAttachment) {
              clearInterval(interval);
              resolve('ready');
              return;
            }

            if (elapsed > 1200000) {
              clearInterval(interval);
              resolve('timeout');
            }
          }, 500);
        });
      });

      if (uploadResult === 'ready') {
        console.log(`[browser-adapter:${logPrefix}] ✅ Upload successful!`);
        uploadSuccess = true;
        break;
      } else if (uploadResult === 'error') {
        console.log(`[browser-adapter:${logPrefix}] ❌ Upload error (attempt ${uploadAttempt}/${MAX_UPLOAD_RETRIES})`);

        // Dismiss error toast (mechanism #43)
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          buttons.forEach((btn) => {
            const txt = (btn.innerText || '').toLowerCase();
            if (txt.includes('ok') || txt.includes('dismiss') || txt.includes('close') || txt.includes('try again')) {
              btn.click();
            }
          });
        }).catch(() => {});

        if (uploadAttempt < MAX_UPLOAD_RETRIES) {
          const retryWait = 10000 + Math.random() * 10000;
          console.log(`[browser-adapter:${logPrefix}] Retrying in ${(retryWait / 1000).toFixed(0)}s...`);
          await page.waitForTimeout(retryWait);
          await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
          await page.addStyleTag({
            content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
          }).catch(() => {});
          await page.waitForSelector('#prompt-textarea', { timeout: 60000 });
          await dismissMemoryModal(page, logPrefix);
          await page.waitForTimeout(2000);
        }
      } else {
        console.log(`[browser-adapter:${logPrefix}] ⏱️ Upload timed out (attempt ${uploadAttempt}/${MAX_UPLOAD_RETRIES})`);
        if (uploadAttempt < MAX_UPLOAD_RETRIES) {
          await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
          await page.addStyleTag({
            content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
          }).catch(() => {});
          await page.waitForSelector('#prompt-textarea', { timeout: 60000 });
          await dismissMemoryModal(page, logPrefix);
          await page.waitForTimeout(2000);
        }
      }
    } catch (uploadErr) {
      console.log(`[browser-adapter:${logPrefix}] Upload exception (attempt ${uploadAttempt}): ${uploadErr.message}`);
      if (uploadAttempt < MAX_UPLOAD_RETRIES) {
        await page.waitForTimeout(5000);
        await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
        await page.addStyleTag({
          content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
        }).catch(() => {});
        await page.waitForSelector('#prompt-textarea', { timeout: 60000 });
        await dismissMemoryModal(page, logPrefix);
        await page.waitForTimeout(2000);
      }
    }
  }

  if (!uploadSuccess) {
    throw new Error(`Upload failed after ${MAX_UPLOAD_RETRIES} retries`);
  }

  // Post-upload submission (mechanism #48)
  const previousAssistantCount = await page
    .locator('[data-message-author-role="assistant"]')
    .count();
  const previousUserCount = await page
    .locator('[data-message-author-role="user"]')
    .count();

  console.log(`[browser-adapter:${logPrefix}] Submission ready. Sending!`);
  await page.waitForTimeout(2000);
  await submitPrompt(page, promptType, previousUserCount);
  await waitForResponse(page, logPrefix, previousAssistantCount);
  const fullText = await extractCompleteResponse(page, previousAssistantCount);

  return fullText;
}

// ─── Zip Creation Helper ─────────────────────────────────────────────────────
function createZipFromFiles(txtFiles, zipPath, tempDir) {
  const { execSync } = require('child_process');

  // Write all txt files to temp dir
  const tempFilesDir = path.join(tempDir, 'zip_content');
  if (fs.existsSync(tempFilesDir)) {
    fs.rmSync(tempFilesDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempFilesDir, { recursive: true });

  for (const file of txtFiles) {
    const dest = path.join(tempFilesDir, path.basename(file));
    fs.copyFileSync(file, dest);
  }

  // Delete existing zip
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  // Create zip using PowerShell
  // Use tar.exe (built into Windows 10+) to create zip
  const { execFileSync } = require('child_process');
  execFileSync('tar', ['-acf', zipPath, '-C', tempFilesDir, '.'], { stdio: 'pipe' });

  // Verify zip was created
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Zip creation failed: ${zipPath} not found`);
  }

  // Clean up temp dir
  // Clean up temp dir
  fs.rmSync(tempFilesDir, { recursive: true, force: true });

  return zipPath;
}

// ─── Main Export: generateInitialSynthesis ──────────────────────────────────
/**
 * Generate initial synthesis text using ChatGPT browser automation.
 *
 * This replaces the API-based Phase 1 (fetchWithProxyRetry with inline transcript).
 * Instead, it uploads the transcript files as a ZIP to ChatGPT and extracts
 * the synthesized response from the DOM.
 *
 * @param {string[]} txtFiles - Array of paths to transcript .txt files
 * @param {string} topicName - Topic name (used in prompt)
 * @param {string} promptType - One of: "full_book", "unit_overview", "knowledge_map"
 * @param {Object} options - { context: existingBrowserContext (optional), nonInteractive: bool }
 * @returns {Promise<string>} - The synthesized text (plain string)
 */
async function generateInitialSynthesis(txtFiles, topicName, promptType, options = {}) {
  // Seam #1: a caller may pass options.prompt to use a custom prompt (e.g. one
  // loaded from a file). When options.prompt is provided, promptType is ignored
  // and the PROMPTS validation is skipped. When options.prompt is absent, the
  // proven default behavior is preserved: promptType must be one of the three
  // hardcoded types. Stage A calls without options.prompt, so it is unaffected.
  const hasCustomPrompt = typeof options.prompt === 'string' && options.prompt.length > 0;
  if (!hasCustomPrompt && !PROMPTS[promptType]) {
    throw new Error(`Invalid promptType: ${promptType}. Must be one of: full_book, unit_overview, knowledge_map`);
  }

  const prompt = hasCustomPrompt ? options.prompt : PROMPTS[promptType](topicName);

  // Log prefix: defaults to promptType (preserves Stage A output). A caller
  // (e.g. the transcript runner) may pass options.logPrefix to attribute every
  // adapter log line to a worker/account, e.g. "w1:chatgpt-account-a:full_book".
  const logPrefix = options.logPrefix || promptType;

  // Upload payload: by default, package the transcript(s) into a zip (proven
  // behavior). Set NO_ZIP_UPLOAD=1 to upload the raw .txt file(s) directly —
  // an A/B switch to test whether zip-vs-txt affects ChatGPT's send-button
  // enablement. When NO_ZIP_UPLOAD is set and there is exactly one txt file,
  // upload it directly; otherwise fall back to the zip path.
  const noZip = process.env.NO_ZIP_UPLOAD === '1' || process.env.NO_ZIP_UPLOAD === 'true';
  let uploadPath;
  let zipPath = null;
  let tempDir = null;

  if (noZip && txtFiles.length === 1) {
    uploadPath = txtFiles[0];
    console.log(`[browser-adapter:${logPrefix}] Uploading 1 .txt DIRECTLY (NO zip): ${path.basename(uploadPath)}`);
  } else {
    tempDir = path.join(os.tmpdir(), 'chatgpt-adapter');
    fs.mkdirSync(tempDir, { recursive: true });
    const zipFileName = topicName.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.zip';
    zipPath = path.join(tempDir, zipFileName);
    console.log(`[browser-adapter:${logPrefix}] Packaging ${txtFiles.length} transcript file(s) into zip...`);
    createZipFromFiles(txtFiles, zipPath, tempDir);
    uploadPath = zipPath;
  }

  // Launch or reuse browser context
  let context = options.context;
  let shouldCloseContext = false;

  if (!context) {
    console.log(`[browser-adapter:${logPrefix}] Launching browser...`);
    context = await launchBrowserContext();
    shouldCloseContext = true;

    // Login gate (mechanism #60 — non-interactive)
    if (!options.nonInteractive) {
      const pages = context.pages();
      const loginPage = pages.length > 0 ? pages[0] : await context.newPage();
      await loginPage.goto(CHATGPT_URL);
      console.log(`[browser-adapter] Verify ChatGPT login/cloudflare in browser. Press Enter here to continue...`);
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', () => {
          process.stdin.pause();
          resolve();
        });
      });
    } else {
      console.log(`[browser-adapter] Non-interactive mode. Waiting 5s for page stability...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  try {
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    const fullText = await setupConversationWithUpload(page, uploadPath, prompt, promptType, logPrefix);

    console.log(`[browser-adapter:${logPrefix}] Synthesis complete (${fullText.length} chars).`);
    return fullText;
  } finally {
    // Clean up zip (only when we created one; in NO_ZIP_UPLOAD mode uploadPath
    // points at the original .txt, which we must NOT delete).
    if (zipPath && fs.existsSync(zipPath)) {
      try { fs.unlinkSync(zipPath); } catch {}
    }

    if (shouldCloseContext) {
      await context.close().catch(() => {});
    }
  }
}

module.exports = { generateInitialSynthesis, launchBrowserContext, PROMPTS };