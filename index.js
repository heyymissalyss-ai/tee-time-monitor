require("dotenv").config();
const cron = require("node-cron");
const { fetchAllTeeTimesForDate, matchesAlertWindows } = require("./scraper");
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
  const now = new Date();
  const h = now.getHours();
  const m = now.getMi
