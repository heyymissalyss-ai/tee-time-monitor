const nodemailer = require("nodemailer");

let transporter = null;

function initMailer({ host, port, user, pass, from }) {
  transporter = nodemailer.createTransport({
    host: host || "smtp.gmail.com",
    port: parseInt(port) || 587,
    secure: parseInt(port) === 465,
    auth: { user, pass },
  });
  console.log(`[mailer] SMTP configured: ${host}:${port} as ${user}`);
}

async function sendTeeTimeAlert({ recipients, teeTimes, config }) {
  if (!transporter) {
    console.error("[mailer] Transporter not initialized. Call initMailer() first.");
    return;
  }
  if (!recipients || recipients.length === 0) {
    console.warn("[mailer] No recipients configured.");
    return;
  }

  const subject =
    teeTimes.length === 1
      ? `⛳ Tee time available: ${teeTimes[0].time} on ${teeTimes[0].date}`
      : `⛳ ${teeTimes.length} tee times available — ${teeTimes[0].date}`;

  const textBody = buildTextEmail(teeTimes, config);
  const htmlBody = buildHtmlEmail(teeTimes, config);

  try {
    const info = await transporter.sendMail({
      from: `"Tee Time Monitor" <${config.smtp.user}>`,
      to: recipients.join(", "),
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log(`[mailer] Alert sent to ${recipients.length} recipients. MsgId: ${info.messageId}`);
  } catch (err) {
    console.error(`[mailer] Failed to send email: ${err.message}`);
  }
}

function buildTextEmail(teeTimes, config) {
  const lines = [
    "TEE TIME ALERT — Charleston Golf",
    "=".repeat(40),
    "",
    `${teeTimes.length} tee time(s) found matching your criteria:`,
    "",
  ];

  teeTimes.forEach((t, i) => {
    lines.push(`[${i + 1}] ${t.time} on ${t.date}`);
    lines.push(`    Course: ${t.course}`);
    lines.push(`    Players: ${t.playersSearched}`);
    lines.push(`    Price: ${t.price}`);
    lines.push(`    Book: ${t.bookingUrl}`);
    lines.push("");
  });

  lines.push("-".repeat(40));
  lines.push(`Alert windows: ${config.alert_windows.join(", ")}`);
  lines.push(`Players searched: ${config.players.join(", ")}`);
  lines.push(
    `\nBook now at: https://sccharlestonweb.myvscloud.com/webtrac/web/search.html?module=GR&Search=no&interfaceparameter=webtrac_golf`
  );

  return lines.join("\n");
}

function buildHtmlEmail(teeTimes, config) {
  const rows = teeTimes
    .map(
      (t) => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:12px 8px;font-weight:600;color:#1a1a1a">${t.time}</td>
      <td style="padding:12px 8px;color:#444">${t.date}</td>
      <td style="padding:12px 8px;color:#444">${t.course}</td>
      <td style="padding:12px 8px;color:#444">${t.playersSearched}</td>
      <td style="padding:12px 8px;color:#444">${t.price}</td>
      <td style="padding:12px 8px">
        <a href="${t.bookingUrl}" style="background:#1a6b3c;color:#fff;padding:6px 14px;border-radius:4px;text-decoration:none;font-size:13px;white-space:nowrap">Book now</a>
      </td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    
    <div style="background:#1a6b3c;padding:24px 32px">
      <div style="font-size:28px;margin-bottom:4px">⛳</div>
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Tee time alert</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px">
        ${teeTimes.length} tee time${teeTimes.length !== 1 ? "s" : ""} found — Charleston Golf
      </p>
    </div>

    <div style="padding:24px 32px">
      <p style="margin:0 0 16px;color:#444;font-size:14px">
        The following tee times matched your alert criteria. Book quickly — these go fast!
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f8f8f8">
            <th style="padding:10px 8px;text-align:left;color:#666;font-weight:500;border-bottom:2px solid #eee">Time</th>
            <th style="padding:10px 8px;text-align:left;color:#666;font-weight:500;border-bottom:2px solid #eee">Date</th>
            <th style="padding:10px 8px;text-align:left;color:#666;font-weight:500;border-bottom:2px solid #eee">Course</th>
            <th style="padding:10px 8px;text-align:left;color:#666;font-weight:500;border-bottom:2px solid #eee">Players</th>
            <th style="padding:10px 8px;text-align:left;color:#666;font-weight:500;border-bottom:2px solid #eee">Price</th>
            <th style="padding:10px 8px;text-align:left;color:#666;font-weight:500;border-bottom:2px solid #eee"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div style="margin-top:24px;padding:16px;background:#f0f7f3;border-radius:6px;border-left:3px solid #1a6b3c">
        <p style="margin:0;font-size:13px;color:#444">
          <strong>Alert criteria:</strong> Players: ${config.players.join(", ")} · 
          Windows: ${config.alert_windows.join(", ")}
        </p>
      </div>

      <p style="margin:20px 0 0;font-size:13px;color:#888">
        <a href="https://sccharlestonweb.myvscloud.com/webtrac/web/search.html?module=GR&Search=no&interfaceparameter=webtrac_golf" 
           style="color:#1a6b3c">View all tee times on Charleston WebTrac →</a>
      </p>
    </div>

    <div style="padding:16px 32px;background:#f8f8f8;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#aaa">Sent by Tee Time Monitor · Charleston Golf Alert System</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { initMailer, sendTeeTimeAlert };
