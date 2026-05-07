const puppeteer = require("puppeteer");

const TARGET_URL =
  "https://sccharlestonweb.myvscloud.com/webtrac/web/search.html?module=GR&Search=no&interfaceparameter=webtrac_golf";

let browser = null;

async function getBrowser() {
  if (browser) {
    try {
      await browser.pages();
      return browser;
    } catch {
      browser = null;
    }
  }
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
      "--js-flags=--max-old-space-size=512",
    ],
  });
  console.log("[scraper] Browser launched");
  return browser;
}

// DOM-based parser — runs inside the browser, sees fully rendered content
async function parseTeeTimes(page) {
  return await page.evaluate(() => {
    const results = [];

    // WebTrac renders each tee time as a card — find all cards
    const cards = Array.from(document.querySelectorAll(
      ".wt-search-result, .search-result, .result-item, " +
      "[class*='result'], [class*='tee-time'], [class*='teetime'], " +
      "[class*='booking'], [class*='slot'], li, article, .card"
    ));

    // Also try table rows
    const rows = Array.from(document.querySelectorAll("tr"));
    const allElements = [...cards, ...rows];

    for (const el of allElements) {
      const text = el.innerText || "";
      const joined = text.replace(/\s+/g, " ").trim();

      if (!joined.includes("Open Slots")) continue;
      if (!joined.match(/\d{1,2}:\d{2}\s*(am|pm)/i)) continue;

      // Time
      const timeMatch = joined.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
      const time = timeMatch ? timeMatch[1].trim() : null;

      // Date
      const dateMatch = joined.match(/(\d{2}\/\d{2}\/\d{4})/);
      const date = dateMatch ? dateMatch[1] : null;

      // Holes
      const holesMatch = joined.match(/(9|18)\s*\(([^)]+)\)/i);
      const holes = holesMatch ? holesMatch[0] : null;

      // Open Slots
      const slotsMatch = joined.match(/Open Slots\s*(\d+)/i);
      const openSlots = slotsMatch ? parseInt(slotsMatch[1], 10) : 0;

      // Course — find text that isn't time/date/slots/status
      const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean);
      const courseCandidates = lines.filter(t => {
        return (
          !t.match(/\d{1,2}:\d{2}\s*(am|pm)/i) &&
          !t.match(/\d{2}\/\d{2}\/\d{4}/) &&
          !t.includes("Open Slots") &&
          !t.match(/^(Booked|Available)$/i) &&
          !t.match(/^(9|18)\s*\(/) &&
          !t.match(/^\d+$/) &&
          t.length > 3
        );
      });
      const course = courseCandidates[0] || "Charleston Municipal";

      // Status
      const status = joined.match(/available/i) ? "available" : "booked";

      if (!time || !date) continue;
      if (openSlots < 1) continue;

      results.push({ time, date, holes, course, openSlots, status });
    }

    // Deduplicate
    const seen = new Set();
    return results.filter(item => {
      const key = `${item.date}-${item.time}-${item.course}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

async function fetchAllTeeTimesForDate({ date, playerCounts }) {
  const results = [];
  let b;
  try {
    b = await getBrowser();
    for (const players of playerCounts) {
      const page = await b.newPage();
      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
        );
        await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

        const searchUrl = `${TARGET_URL}&Search=yes&numberofplayers=${players}&begindate=${formatDate(date)}&enddate=${formatDate(date)}`;

        await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });

        // Wait for tee time cards to render
        await page.waitForFunction(
          () => document.body.innerText.includes("Open Slots"),
          { timeout: 30000 }
        ).catch(async () => {
          // Log what the page actually says for debugging
          const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
          console.log("[debug] Page text (no Open Slots found):", bodyText);
        });

        // Small buffer for late-rendering content
        await new Promise(resolve => setTimeout(resolve, 3000));

        const teeTimes = await parseTeeTimes(page);
        console.log(`[debug] Parsed tee times: ${teeTimes.length}`);
        if (teeTimes.length > 0) {
          console.log("[debug] Sample:", JSON.stringify(teeTimes.slice(0, 2), null, 2));
        }

        // Filter by player count
        const matched = teeTimes.filter(t => t.openSlots >= players).map(t => ({
          ...t,
          playersSearched: players,
          bookingUrl: TARGET_URL,
          price: "N/A",
        }));

        console.log(`[scraper] Found ${matched.length} tee times for ${formatDate(date)}, ${players} players`);
        results.push(...matched);
      } catch (err) {
        console.error(`[scraper] Page error for ${players}p on ${formatDate(date)}: ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[scraper] Browser error: ${err.message}`);
    browser = null;
  }
  return results;
}

async function fetchTeeTimes({ date, players }) {
  return fetchAllTeeTimesForDate({ date, playerCounts: [players] });
}

function formatDate(date) {
  const d = new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const y = d.getFullYear();
  return `${m}/${day}/${y}`;
}

function matchesAlertWindows(teeTime, alertWindows) {
  const now = new Date();
  const [month, day, year] = teeTime.date.split("/").map(Number);
  const teeDate = new Date(year, month - 1, day);
  const timeMatch = teeTime.time.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    const meridiem = timeMatch[3].toLowerCase();
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    teeDate.setHours(hours, minutes, 0, 0);
  }

  const diffMs = teeDate - now;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  const checks = {
    same_day:    teeDate.toDateString() === now.toDateString() && diffMs > 0,
    "2h_before": teeDate.toDateString() === now.toDateString() && diffHours >= 0 && diffHours <= 2,
    "2d_before": diffDays >= 1.9 && diffDays <= 2.1,
    "3d_before": diffDays >= 2.9 && diffDays <= 3.1,
    "4d_before": diffDays >= 3.9 && diffDays <= 4.1,
    "5d_before": diffDays >= 4.9 && diffDays <= 5.1,
    "6d_before": diffDays >= 5.9 && diffDays <= 6.1,
    "7d_before": diffDays >= 6.9 && diffDays <= 7.1,
    "2d_out":    diffDays >= 0 && diffDays <= 2,
    "7d_out":    diffDays >= 0 && diffDays <= 7,
  };

  return alertWindows.some((w) => checks[w]);
}

module.exports = { fetchTeeTimes, fetchAllTeeTimesForDate, matchesAlertWindows, formatDate };