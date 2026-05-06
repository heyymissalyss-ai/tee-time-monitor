require("dotenv").config();
const cron = require("node-cron");
const { fetchTeeTimes, matchesAlertWindows } = require("./scraper");
const { initMailer, sendTeeTimeAlert } = require("./mailer");
const { initGatewaySms, sendSmsAlert } = require("./sms");

const CONFIG = {
  players: process.env.PLAYERS
    ? process.env.PLAYERS.split(",").map(Number)
    : [1, 2, 3, 4],
  alert_windows: process.env.ALERT_WINDOWS
    ? process.env.ALERT_WINDOWS.split(",").map((s) => s.trim().replace(/"/g, ""))
    : ["same_day", "7d_out"],
  recipients: process.env.RECIPIENTS
    ? process.env.RECIPIENTS.split(",").map((s) => s.trim())
    : [],
  days_ahead: process.env.DAYS_AHEAD
    ? process.env.DAYS_AHEAD.split(",").map(Number)
    : [0, 1, 2, 3, 4, 5, 6, 7],
  check_interval_minutes: parseInt(process.env.CHECK_INTERVAL_MINUTES) || 10,
  check_hours: process.env.CHECK_HOURS || "business",
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
  gateway: {
    enabled: !!process.env.SMS_GATEWAY_RECIPIENTS,
    recipients: parseSmsGatewayRecipients(process.env.SMS_GATEWAY_RECIPIENTS),
  },
};

function parseSmsGatewayRecipients(raw) {
  if (!raw) return [];
  return raw
    .replace(/"/g, "")
    .split(",")
    .map((entry) => {
      const [phone, carrier] = entry.trim().split(":");
      return { phone: phone?.trim(), carrier: carrier?.trim().toLowerCase() };
    })
    .filter((r) => r.phone && r.carrier);
}

const alertedTeeTimes = new Set();
function makeAlertKey(t) {
  return `${t.date}|${t.time}|${t.course}|${t.playersSearched}`;
}

function getDatesToCheck() {
  return CONFIG.days_ahead.map((d) => {
    const date = new Date();
    date.setDate(date.getDate() + d);
    return date;
  });
}

function isWithinCheckHours() {
  const h = new Date().getHours();
  switch (CONFIG.check_hours.replace(/"/g, "")) {
    case "morning":   return h >= 6 && h < 12;
    case "afternoon": return h >= 12 && h < 18;
    case "business":  return h >= 6 && h < 20;
    default:          return true;
  }
}

async function pollForTeeTimes() {
  if (!isWithinCheckHours()) {
    console.log("[monitor] Outside check hours, skipping");
    return;
  }

  console.log(`[monitor] Polling at ${new Date().toISOString()}`);
  const newAlerts = [];

  for (const date of getDatesToCheck()) {
    for (const players of CONFIG.players) {
      const teeTimes = await fetchTeeTimes({ date, players });
      for (const teeTime of teeTimes) {
        const key = makeAlertKey(teeTime);
        if (alertedTeeTimes.has(key)) continue;
        if (matchesAlertWindows(teeTime, CONFIG.alert_windows)) {
          newAlerts.push(teeTime);
          alertedTeeTimes.add(key);
          console.log(`[monitor] MATCH: ${teeTime.time} on ${teeTime.date} for ${players}p`);
        }
      }
    }
  }

  if (newAlerts.length > 0) {
    console.log(`[monitor] Firing alerts for ${newAlerts.length} tee time(s)`);

    if (CONFIG.recipients.length > 0) {
      await sendTeeTimeAlert({
        recipients: CONFIG.recipients,
        teeTimes: newAlerts,
        config: CONFIG,
      });
    }

    if (CONFIG.gateway.enabled && CONFIG.gateway.recipients.length > 0) {
      await sendSmsAlert({
        teeTimes: newAlerts,
        twilioNumbers: [],
        config: CONFIG,
      });
    }
  } else {
    console.log("[monitor] No new matches");
  }

  if (alertedTeeTimes.size > 500) {
    const arr = [...alertedTeeTimes];
    arr.splice(0, 250).forEach((k) => alertedTeeTimes.delete(k));
  }
}

function buildCronExpression(minutes) {
  if (minutes < 60) return `*/${minutes} * * * *`;
  return `0 */${Math.floor(minutes / 60)} * * *`;
}

async function main() {
  console.log("=".repeat(52));
  console.log("  CHARLESTON GOLF TEE TIME MONITOR");
  console.log("=".repeat(52));
  console.log(`  Players:        ${CONFIG.players.join(", ")}`);
  console.log(`  Alert windows:  ${CONFIG.alert_windows.join(", ")}`);
  console.log(`  Days ahead:     0 - ${Math.max(...CONFIG.days_ahead)}`);
  console.log(`  Email to:       ${CONFIG.recipients.length} recipient(s)`);
  console.log(`  SMS (gateway):  ${CONFIG.gateway.enabled ? CONFIG.gateway.recipients.length + " number(s)" : "disabled"}`);
  console.log(`  Check every:    ${CONFIG.check_interval_minutes} min`);
  console.log(`  Check hours:    ${CONFIG.check_hours}`);
  console.log("=".repeat(52));

  if (CONFIG.smtp.user) initMailer(CONFIG.smtp);

  if (CONFIG.gateway.enabled) {
    initGatewaySms({
      smtpConfig: CONFIG.smtp,
      recipients: CONFIG.gateway.recipients,
    });
  }

  await pollForTeeTimes();

  const cronExpr = buildCronExpression(CONFIG.check_interval_minutes);
  cron.schedule(cronExpr, pollForTeeTimes, { timezone: "America/New_York" });
  console.log(`[cron] Scheduled: ${cronExpr} (ET) — running. Ctrl+C to stop.`);
}

main().catch(console.error);
