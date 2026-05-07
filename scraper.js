const puppeteer = require("puppeteer");
const cheerio = require("cheerio");

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

async function fetchAllTeeTimesForDate({ date, playerCounts }) {
  const results = [];
  let b;
  try {
    b = await getBrowser();
    for (const players of playerCounts) {
      const page = await b.newPage();
      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        );
        await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

        const searchUrl = `${TARGET_URL}&Search=yes&numberofplayers=${players}&begindate=${formatDate(date)}&enddate=${formatDate(date)}`;
        await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

        const html = await page.content();
// Debug: log a snippet of the HTML so we can see the structure
const snippet = html.substring(0, 3000);
console.log("[debug] HTML snippet:", snippet);
const teeTimes = parseTeeTimesHtml(html, { date, players });
        results.push(...teeTimes);
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

function parseTeeTimesHtml(html, context) {
  const $ = cheerio.load(html);
  const teeTimes = [];
  const seen = new Set();

  // WebTrac renders each tee time as a card/block containing:
  // Time, Date, Holes, Course, Open Slots, Status (red=Booked, green=Available dots)
  // We find every element that contains "Open Slots" and parse upward to the card
  $("*").each((_, el) => {
    const text = $(el).text();

    // Must have Open Slots and a time pattern
    if (!text.includes("Open Slots")) return;
    if (!text.match(/\d{1,2}:\d{2}\s*(am|pm)/i)) return;

    // Skip large containers that contain multiple cards
    if ((text.match(/Open Slots/g) || []).length > 1) return;

    // Extract fields
    const timeMatch = text.match(/Time\s+(\d{1,2}:\d{2}\s*(?:am|pm))/i) ||
                      text.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
    const dateMatch = text.match(/Date\s+(\d{2}\/\d{2}\/\d{4})/i);
    const courseMatch = text.match(/Course\s+([^\n]+)/i);
    const slotsMatch = text.match(/Open Slots\s+(\d+)/i);

    if (!timeMatch) return;

    const openSlots = slotsMatch ? parseInt(slotsMatch[1]) : 0;
    if (openSlots < 1) return;

    // Only alert if enough open slots for players searched
    if (openSlots < context.players) return;

    const time = timeMatch[1].trim();
    const date = dateMatch ? dateMatch[1] : formatDate(context.date);
    const key = `${time}|${date}`;
    if (seen.has(key)) return;
    seen.add(key);

    teeTimes.push({
      time,
      date,
      course: courseMatch ? courseMatch[1].trim() : "Charleston Municipal",
      availableSpots: openSlots,
      price: "N/A",
      bookingUrl: TARGET_URL,
      playersSearched: context.players,
    });
  });

  console.log(
    `[scraper] Found ${teeTimes.length} tee times for ${formatDate(context.date)}, ${context.players} players`
  );
  return teeTimes;
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