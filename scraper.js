const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");

const BASE_URL = "https://sccharlestonweb.myvscloud.com/webtrac/web/search.html";
const INIT_URL = `${BASE_URL}?module=GR&Search=no&interfaceparameter=webtrac_golf`;

let sessionCookie = "";
let csrfToken = "";
let sessionExpiry = 0;

// Use Puppeteer ONCE to get a real browser session, then close it
async function initSession() {
  const now = Date.now();
  if (sessionCookie && csrfToken && now < sessionExpiry) {
    console.log("[scraper] Reusing existing session");
    return true;
  }

  console.log("[scraper] Getting fresh session via browser...");
  let browser;
  try {
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
        "--js-flags=--max-old-space-size=256",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.goto(INIT_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Get cookies from browser
    const cookies = await page.cookies();
    sessionCookie = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    // Get CSRF token
    csrfToken = await page.evaluate(() => {
      const el = document.querySelector("input[name='_csrf_token']");
      return el ? el.value : "";
    });

    await page.close();
    await browser.close();

    // Session valid for 4 minutes
    sessionExpiry = now + 4 * 60 * 1000;
    console.log(`[scraper] Session ready. CSRF: ${csrfToken ? "found" : "missing"}`);
    return true;
  } catch (err) {
    console.error(`[scraper] Session init failed: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return false;
  }
}

function getHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "Referer": INIT_URL,
    "Cookie": sessionCookie,
  };
}

async function fetchAllTeeTimesForDate({ date, playerCounts }) {
  const results = [];

  const ok = await initSession();
  if (!ok) {
    console.error("[scraper] Could not initialize session, skipping");
    return results;
  }

  for (const players of playerCounts) {
    try {
      const params = new URLSearchParams({
        Action: "Start",
        SubAction: "",
        _csrf_token: csrfToken,
        numberofplayers: String(players),
        secondarycode: "",
        begindate: formatDate(date),
        begintime: "05:00 am",
        numberofholes: "18",
        module: "GR",
        multiselectlist_value: "",
        grwebsearch_buttonsearch: "yes",
      });

      const searchUrl = `${BASE_URL}?${params.toString()}`;
      console.log(`[scraper] Searching ${formatDate(date)}, ${players}p...`);

      const resp = await axios.get(searchUrl, {
        headers: getHeaders(),
        timeout: 20000,
        maxRedirects: 5,
      });

      if (resp.status === 403) {
        console.log("[scraper] 403 — forcing session refresh");
        sessionCookie = "";
        csrfToken = "";
        sessionExpiry = 0;
        break;
      }

      const teeTimes = parseTeeTimesHtml(resp.data, { date, players });
      console.log(`[scraper] Found ${teeTimes.length} tee times for ${formatDate(date)}, ${players} players`);
      results.push(...teeTimes);

    } catch (err) {
      console.error(`[scraper] Error for ${players}p on ${formatDate(date)}: ${err.message}`);
      if (err.response?.status === 403) {
        sessionCookie = "";
        csrfToken = "";
        sessionExpiry = 0;
      }
    }
  }

  return results;
}

function parseTeeTimesHtml(html, context) {
  const $ = cheerio.load(html);
  const teeTimes = [];
  const seen = new Set();

  // Strategy 1: Table rows
  $("tbody tr").each((_, row) => {
    const cells = $(row).find("td").map((_, td) => $(td).text().trim()).get();
    const joined = cells.join(" ");

    const timeMatch = joined.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
    const dateMatch = joined.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (!timeMatch || !dateMatch) return;
    if (!joined.match(/available/i)) return;

    let openSlots = 0;
    cells.forEach(c => { if (/^\d+$/.test(c.trim())) openSlots = parseInt(c.trim()); });
    if (openSlots < 1) return;

    const time = timeMatch[1].trim();
    const date = dateMatch[1];
    const key = `${date}-${time}`;
    if (seen.has(key)) return;
    seen.add(key);

    const course = cells.find(t =>
      t.length > 3 &&
      !t.match(/\d{1,2}:\d{2}/) &&
      !t.match(/\d{2}\/\d{2}\/\d{4}/) &&
      !t.match(/^\d+$/) &&
      !t.match(/^(Booked|Available|Unavailable|Status|Action|Holes|Time|Date|Course|Open Slots|Item Action|Add To Cart)$/i)
    ) || "Charleston Municipal";

    teeTimes.push({ time, date, course, openSlots, status: "available", playersSearched: context.players, bookingUrl: INIT_URL, price: "N/A" });
  });

  // Strategy 2: Full text regex fallback
  if (teeTimes.length === 0) {
    const text = $("body").text();
    const pattern = /(\d{1,2}:\d{2}\s*(?:am|pm))[\s\S]{0,200}?(\d{2}\/\d{2}\/\d{4})[\s\S]{0,200}?Open Slots[\s\S]{0,50}?(\d+)[\s\S]{0,100}?Available/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const openSlots = parseInt(match[3]);
      if (openSlots < 1) continue;
      const key = `${match[2]}-${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      teeTimes.push({ time: match[1].trim(), date: match[2], course: "Charleston Municipal", openSlots, status: "available", playersSearched: context.players, bookingUrl: INIT_URL, price: "N/A" });
    }
  }

  return teeTimes;
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