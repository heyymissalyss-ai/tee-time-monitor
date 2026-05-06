const axios = require("axios");
const cheerio = require("cheerio");

const TARGET_URL =
  "https://sccharlestonweb.myvscloud.com/webtrac/web/search.html?module=GR&Search=no&interfaceparameter=webtrac_golf";

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

// Step 1: Hit the page first to get a fresh session cookie
async function getFreshCookie() {
  try {
    const response = await axios.get(TARGET_URL, {
      headers: BASE_HEADERS,
      timeout: 15000,
      maxRedirects: 5,
    });
    const setCookie = response.headers["set-cookie"];
    if (setCookie) {
      const cookie = setCookie
        .map((c) => c.split(";")[0])
        .join("; ");
      console.log("[scraper] Got fresh session cookie");
      return cookie;
    }
  } catch (err) {
    console.error(`[scraper] Could not get fresh cookie: ${err.message}`);
  }
  return process.env.WEBTRAC_COOKIE || "";
}

let sessionCookie = "";
let lastCookieTime = 0;

async function getSessionCookie() {
  const now = Date.now();
  // Refresh cookie every 5 minutes
  if (!sessionCookie || now - lastCookieTime > 5 * 60 * 1000) {
    sessionCookie = await getFreshCookie();
    lastCookieTime = now;
  }
  return sessionCookie;
}

async function fetchTeeTimes({ date, players }) {
  const params = new URLSearchParams({
    module: "GR",
    Search: "yes",
    interfaceparameter: "webtrac_golf",
    numberofplayers: players,
    begindate: formatDate(date),
    enddate: formatDate(date),
  });

  const cookie = await getSessionCookie();

  const headers = {
    ...BASE_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": TARGET_URL,
    "Cookie": cookie,
  };

  try {
    const response = await axios.post(TARGET_URL, params.toString(), {
      headers,
      timeout: 15000,
    });
    return parseTeeTimesHtml(response.data, { date, players });
  } catch (err) {
    if (err.response?.status === 403) {
      console.log("[scraper] 403 received — refreshing cookie and retrying");
      sessionCookie = "";
      const freshCookie = await getFreshCookie();
      lastCookieTime = Date.now();
      try {
        const retry = await axios.post(TARGET_URL, params.toString(), {
          headers: { ...headers, Cookie: freshCookie },
          timeout: 15000,
        });
        return parseTeeTimesHtml(retry.data, { date, players });
      } catch (err2) {
        console.error(`[scraper] Retry failed: ${err2.message}`);
        return [];
      }
    }
    console.error(`[scraper] Error: ${err.message}`);
    return [];
  }
}

function parseTeeTimesHtml(html, context) {
  const $ = cheerio.load(html);
  const teeTimes = [];

  $(".webTracResultItemRow, .result-row, tr[class*='result']").each((_, el) => {
    const row = $(el);
    const timeText = row.find(".time, td:nth-child(1), [class*='time']").first().text().trim();
    const courseText = row.find(".course, td:nth-child(2), [class*='course']").first().text().trim();
    const spotsText = row.find(".spots, td:nth-child(3), [class*='avail']").first().text().trim();
    const priceText = row.find(".price, td:nth-child(4), [class*='price']").first().text().trim();
    const bookUrl = row.find("a[href*='book'], a[href*='reserve'], a.book-btn").attr("href");

    if (timeText && timeText.match(/\d{1,2}:\d{2}/)) {
      teeTimes.push({
        time: timeText,
        course: courseText || "Unknown Course",
        availableSpots: parseSpots(spotsText) || context.players,
        price: priceText || "N/A",
        bookingUrl: bookUrl ? resolveUrl(bookUrl) : TARGET_URL,
        date: formatDate(context.date),
        playersSearched: context.players,
      });
    }
  });

  if (teeTimes.length === 0) {
    $("a[href*='book'], a[href*='reserve'], button[onclick*='book']").each((_, el) => {
      const parent = $(el).closest("tr, div[class*='item'], div[class*='result']");
      const allText = parent.text();
      const timeMatch = allText.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)\b/);
      if (timeMatch) {
        const priceMatch = allText.match(/\$[\d.]+/);
        teeTimes.push({
          time: timeMatch[1],
          course: extractCourse(allText) || "Charleston Golf Course",
          availableSpots: context.players,
          price: priceMatch ? priceMatch[0] : "N/A",
          bookingUrl: resolveUrl($(el).attr("href") || TARGET_URL),
          date: formatDate(context.date),
          playersSearched: context.players,
        });
      }
    });
  }

  console.log(`[scraper] Found ${teeTimes.length} tee times for ${formatDate(context.date)}, ${context.players} players`);
  return teeTimes;
}

function parseSpots(text) {
  const match = text.match(/\d+/);
  return match ? parseInt(match[0]) : null;
}

function extractCourse(text) {
  const patterns = [
    /([A-Z][a-z]+ (?:Golf|Course|Club|Links)[^,\n]*)/,
    /(Charleston [A-Za-z ]+Course)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function resolveUrl(href) {
  if (!href) return TARGET_URL;
  if (href.startsWith("http")) return href;
  return `https://sccharlestonweb.myvscloud.com${href.startsWith("/") ? "" : "/webtrac/web/"}${href}`;
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
  const teeDate = new Date(teeTime.date);
  const [timePart, meridiem] = teeTime.time.split(/(?=[AP]M)/i);
  let [hours, minutes] = timePart.trim().split(":").map(Number);
  if (meridiem && meridiem.toLowerCase() === "pm" && hours !== 12) hours += 12;
  if (meridiem && meridiem.toLowerCase() === "am" && hours === 12) hours = 0;
  teeDate.setHours(hours, minutes, 0, 0);

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

module.exports = { fetchTeeTimes, matchesAlertWindows, formatDate };
