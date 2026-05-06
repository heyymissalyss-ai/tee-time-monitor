const axios = require("axios");
const cheerio = require("cheerio");

const TARGET_URL =
  "https://sccharlestonweb.myvscloud.com/webtrac/web/search.html?module=GR&Search=no&interfaceparameter=webtrac_golf";

async function fetchTeeTimes({ date, players }) {
  const params = new URLSearchParams({
    module: "GR",
    Search: "yes",
    interfaceparameter: "webtrac_golf",
    numberofplayers: players,
    begindate: formatDate(date),
    enddate: formatDate(date),
  });

  const cookie = process.env.WEBTRAC_COOKIE || "";

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
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
    try {
      const getUrl = `${TARGET_URL}&Search=yes&numberofplayers=${players}&begindate=${formatDate(date)}&enddate=${formatDate(date)}`;
      const response = await axios.get(getUrl, { headers, timeout: 15000 });
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
  return `https://sccharlestonweb.myvscloud.com${href.startsWith("/") ? "" : "/webtrac/web/
