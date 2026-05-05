/**
 * SMS Alerter — two strategies:
 *   1. Twilio API (recommended, requires account)
 *   2. Email-to-SMS gateway (free, no account — uses carrier MMS/SMS email addresses)
 */

const nodemailer = require("nodemailer");

// Carrier email-to-SMS gateways (US carriers)
const CARRIER_GATEWAYS = {
  att:        (n) => `${n}@txt.att.net`,
  verizon:    (n) => `${n}@vtext.com`,
  tmobile:    (n) => `${n}@tmomail.net`,
  sprint:     (n) => `${n}@messaging.sprintpcs.com`,
  boost:      (n) => `${n}@sms.myboostmobile.com`,
  cricket:    (n) => `${n}@sms.cricketwireless.net`,
  metro:      (n) => `${n}@mymetropcs.com`,
  uscellular: (n) => `${n}@email.uscc.net`,
  republic:   (n) => `${n}@text.republicwireless.com`,
  google_fi:  (n) => `${n}@msg.fi.google.com`,
};

let twilioClient = null;
let twilioFrom = null;
let smsTransporter = null;
let smsConfig = null;

// ─── Init Twilio ──────────────────────────────────────────────────────────────
function initTwilio({ accountSid, authToken, fromNumber }) {
  try {
    const twilio = require("twilio");
    twilioClient = twilio(accountSid, authToken);
    twilioFrom = fromNumber;
    console.log(`[sms] Twilio initialized. From: ${fromNumber}`);
  } catch (e) {
    console.warn("[sms] Twilio package not installed. Run: npm install twilio");
  }
}

// ─── Init email-to-SMS gateway ────────────────────────────────────────────────
function initGatewaySms({ smtpConfig, recipients }) {
  // recipients = [{ phone: "8431234567", carrier: "att" }, ...]
  smsTransporter = nodemailer.createTransport({
    host: smtpConfig.host || "smtp.gmail.com",
    port: parseInt(smtpConfig.port) || 587,
    secure: parseInt(smtpConfig.port) === 465,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });
  smsConfig = { from: smtpConfig.user, recipients };
  console.log(`[sms] Gateway SMS initialized for ${recipients.length} number(s)`);
}

// ─── Send SMS via Twilio ──────────────────────────────────────────────────────
async function sendViaTwilio(phoneNumbers, message) {
  if (!twilioClient) {
    console.warn("[sms] Twilio not initialized, skipping");
    return;
  }
  for (const to of phoneNumbers) {
    try {
      const normalized = normalizePhone(to);
      const result = await twilioClient.messages.create({
        body: message,
        from: twilioFrom,
        to: normalized,
      });
      console.log(`[sms] Twilio sent to ${normalized}: ${result.sid}`);
    } catch (err) {
      console.error(`[sms] Twilio failed for ${to}: ${err.message}`);
    }
  }
}

// ─── Send SMS via carrier email gateway ──────────────────────────────────────
async function sendViaGateway(message) {
  if (!smsTransporter || !smsConfig) {
    console.warn("[sms] Gateway SMS not initialized, skipping");
    return;
  }
  for (const recipient of smsConfig.recipients) {
    const carrier = recipient.carrier?.toLowerCase();
    const gateway = CARRIER_GATEWAYS[carrier];
    if (!gateway) {
      console.warn(`[sms] Unknown carrier "${carrier}" for ${recipient.phone}`);
      continue;
    }
    const digits = recipient.phone.replace(/\D/g, "").slice(-10);
    const toAddress = gateway(digits);
    try {
      await smsTransporter.sendMail({
        from: smsConfig.from,
        to: toAddress,
        subject: "",               // Carriers ignore subject on SMS
        text: message,             // Keep it short — 160 char limit
      });
      console.log(`[sms] Gateway SMS sent to ${toAddress}`);
    } catch (err) {
      console.error(`[sms] Gateway failed for ${toAddress}: ${err.message}`);
    }
  }
}

// ─── Build a compact SMS message (160 char target) ───────────────────────────
function buildSmsMessage(teeTimes) {
  if (teeTimes.length === 1) {
    const t = teeTimes[0];
    return `⛳ TEE TIME: ${t.time} on ${t.date} | ${t.course} | ${t.playersSearched} players | ${t.price} | Book: ${shortenUrl(t.bookingUrl)}`;
  }
  const summary = teeTimes
    .slice(0, 3)
    .map((t) => `${t.time} (${t.playersSearched}p)`)
    .join(", ");
  const more = teeTimes.length > 3 ? ` +${teeTimes.length - 3} more` : "";
  return `⛳ ${teeTimes.length} tee times open on ${teeTimes[0].date}: ${summary}${more}. Book: sccharlestonweb.myvscloud.com`;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────
async function sendSmsAlert({ teeTimes, twilioNumbers, config }) {
  const message = buildSmsMessage(teeTimes);
  console.log(`[sms] Dispatching: "${message.slice(0, 80)}..."`);

  const tasks = [];

  // Twilio path
  if (twilioClient && twilioNumbers?.length > 0) {
    tasks.push(sendViaTwilio(twilioNumbers, message));
  }

  // Gateway path
  if (smsTransporter && smsConfig?.recipients?.length > 0) {
    tasks.push(sendViaGateway(message));
  }

  if (tasks.length === 0) {
    console.warn("[sms] No SMS method configured. Set TWILIO_* or SMS_RECIPIENTS env vars.");
  }

  await Promise.allSettled(tasks);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}

function shortenUrl(url) {
  // Just return the domain — SMS links don't need full path
  try {
    return new URL(url).hostname;
  } catch {
    return "sccharlestonweb.myvscloud.com";
  }
}

module.exports = {
  initTwilio,
  initGatewaySms,
  sendSmsAlert,
  CARRIER_GATEWAYS,
  buildSmsMessage,
};
