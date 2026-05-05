/**
 * Charleston WebTrac Golf Tee Time Scraper
 * Target: https://sccharlestonweb.myvscloud.com/webtrac/web/search.html?module=GR&Search=no&interfaceparameter=webtrac_golf
 */

const axios = require("axios");
const cheerio = require("cheerio");

const TARGET_URL =
  "https://sccharlestonweb.myvscloud.com/webtrac/web/search.html?module=GR&Search=no&interfaceparameter=webtrac_golf";

// Fetch the tee time search results for a given date and player count
async function fetchTeeTimes({ date, players }) {
  // WebTrac uses POST form params to filter results
  const params = new URLSearchParams({
    module: "GR",
    Search: "yes",
    interfaceparameter: "webtrac_golf",
    numberofplayers: players,
    begindate: formatDate(date), // MM/DD/YYYY
    enddate: formatDate(date),
  });

  try {
    const response = await axios.post(TARGET_URL, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Referer: TARGET_URL,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      timeout: 15000,
    });

    return parseTeeTimesHtml(response.data, { date, players });
  } catch (err) {
    // Fallback: try GET with query params
    try {
      const getUrl = `${TARGET_URL}&Search=yes&numberofplayers=${players}&begindate=${formatDate(date)}&enddate=${formatDate(date)}`;
      const response = await axios.get(getUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
        timeout: 15000,
      });
      return parseTeeTimesHtml(response.data, { date, players });
    } catch (err2) {
      console.error(`[scraper] Error fetching tee times: ${err2.message}`);
      return [];
    }
  }
}

function parseTeeTimesHtml(html, context) {
  const $ = cheerio.load(html);
  const teeTimes = [];

  // WebTrac typically renders results in a table or div grid
  // Primary selector: rows with tee time data
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

  // Secondary fallback: look for any element containing a time pattern near booking links
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

  console.log(
    `[scraper] Found ${teeTimes.length} tee times for ${formatDate(context.date)}, ${context.players} players`
  );
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

// Check if a tee time falls within the configured alert windows
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
    same_day:
      teeDate.toDateString() === now.toDateString() && diffMs > 0,
    "2h_before":
      teeDate.toDateString() === now.toDateString() &&
      diffHours >= 0 &&
      diffHours <= 2,
    "2d_before": diffDays >= 1.9 && diffDays <= 2.1,
    "2d_out": diffDays >= 0 && diffDays <= 2,
  };

  return alertWindows.some((w) => checks[w]);
}

module.exports = { fetchTeeTimes, matchesAlertWindows, formatDate };
