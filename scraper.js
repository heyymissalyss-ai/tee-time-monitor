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

async function parseTeeTimes(page) {
  return await page.evaluate(() => {
    const results = [];
    const rows = Array.from(document.querySelectorAll("tbody tr"));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 3) continue;

      const text = cells.map(c => c.innerText.trim());
      const joined = text.join(" ");

      const timeMatch = joined.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
      const dateMatch = joined.match(/(\d{2}\/\d{2}\/\d{4})/);
      const slotsMatch = joined.match(/Open Slots\s*(\d+)/i) || joined.match(/(\d+)\s*open/i);

      const time = timeMatch ? timeMatch[1].trim() : null;
      const date = dateMatch ? dateMatch[1] : null;
      const openSlots = slotsMatch ? parseInt(slotsMatch[1]) : 0;

      if (!time || !date || openSlots < 1) continue;

      const course = text.find(t =>
        t.length > 3 &&
        !t.match(/\d{1,2}:\d{2}/) &&
        !t.match(/\d{2}\/\d{2}\/\d{4}/) &&
        !t.match(/^\d+$/) &&
        !t.match(/^(Booked|Available|Status|Action|Holes|Time|Date|Course|Open Slots)$/i)
      ) || "Charleston Municipal";

      results.push({
        time,
        date,
        course,
        openSlots,
        status: joined.match(/available/i) ? "available" : "booked",
      });
    }

    const seen = new Set();
    return results.filter(item => {
      const key = `${item.date}-${item.time}`;
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

        // Load base page first
        await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

        // Fill and submit the search form
        await page.evaluate((dateStr, numPlayers) => {
          const beginDate = document.querySelector("input[name='begindate'], #begindate, input[name='BeginDate']");
          const endDate = document.querySelector("input[name='enddate'], #enddate, input[name='EndDate']");
          if (beginDate) beginDate.value = dateStr;
          if (endDate) endDate.value = dateStr;

          const playerSelect = document.querySelector("select[name='numberofplayers'], #numberofplayers, select[name='NumberOfPlayers']");
          if (playerSelect) playerSelect.value = String(numPlayers);

          const searchField = document.querySelector("input[name='Search']");
          if (searchField) searchField.value = "yes";
        }, formatDate(date), players);

        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
          page.evaluate(() => {
            const btn = document.querySelector(
              "input[type='submit'], button[type='submit'], .search-button, #search-button"
            );
            if (btn) btn.click();
            else {
              const form = document.querySelector("form");
              if (form) form.submit();
            }
          }),
        ]);

        // Wait for results
        await page.waitForFunction(
          () => document.body.innerText.includes("Open Slots") ||
                document.body.innerText.includes("did not return"),
          { timeout: 30000 }
        ).catch(async () => {
          const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 800));
          console.log("[debug] Page text after submit:", bodyText);
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        let teeTimes = [];
        try {
          teeTimes = await parseTeeTimes(page);
        } catch (parseErr) {
          console.error("[scraper] Parse error:", parseErr.message);
        }

        console.log(`[debug] Parsed tee times: ${teeTimes.length}`);
        if (teeTimes.length > 0) {
          console.log("[debug] Sample:", JSON.stringify(teeTimes.slice(0, 2), null, 2));
        }

        const matched = teeTimes
          .filter(t => t.openSlots >= players)
          .map(t => ({
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