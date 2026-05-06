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
  return
