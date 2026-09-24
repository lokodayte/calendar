import { devMode, LIMITS } from "./settings.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Send one email through Brevo. In DEV_MODE the email is printed to the terminal instead. */
export async function sendEmail(env, senderName, { to, subject, text, html }) {
  if (devMode(env)) {
    console.log(`\n──── EMAIL (dev mode, not sent) ────\nTo: ${to}\nSubject: ${subject}\n\n${text}\n────────────────────────────────────\n`);
    return true;
  }
  if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) {
    console.error("Email not sent: BREVO_API_KEY or SENDER_EMAIL is missing.");
    return false;
  }
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: env.SENDER_EMAIL, name: senderName || "SCSM Calendar" },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!r.ok) console.error("Brevo error", r.status, (await r.text().catch(() => "")).slice(0, 300));
  return r.ok;
}

const wrap = (inner) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#18223a;max-width:480px">${inner}</div>`;

export function codeEmail(siteTitle, code) {
  return {
    subject: `${code} is your ${siteTitle} code`,
    text: `Your ${siteTitle} sign-in code is ${code}\n\nIt works for ${LIMITS.CODE_MINUTES} minutes. After you enter it, this device stays signed in.\n\nIf you didn't ask for this, you can ignore this email.`,
    html: wrap(`<p>Your ${esc(siteTitle)} sign-in code is:</p>
      <p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:8px 0">${code}</p>
      <p>It works for ${LIMITS.CODE_MINUTES} minutes. After you enter it, this device stays signed in.</p>
      <p style="color:#7b8499;font-size:13px">If you didn't ask for this, you can ignore this email.</p>`),
  };
}

export function welcomeEmail(siteTitle, siteUrl) {
  const link = siteUrl || "";
  return {
    subject: `You've been added to ${siteTitle}`,
    text: `Hi,\n\nYou now have access to ${siteTitle}, the shared calendar for SCSM staff.\n\n${link ? `Open it here: ${link}\n\n` : ""}There's no password. Enter your work email and we'll send you a 6-digit code. After that, your device stays signed in.\n\nPlease don't choose to stay signed in on shared or public computers.`,
    html: wrap(`<p>Hi,</p><p>You now have access to <b>${esc(siteTitle)}</b>, the shared calendar for SCSM staff.</p>
      ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#2f5bd3;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open ${esc(siteTitle)}</a></p>` : ""}
      <p>There's no password. Enter your work email and we'll send you a 6-digit code. After that, your device stays signed in.</p>
      <p style="color:#7b8499;font-size:13px">Please don't stay signed in on shared or public computers.</p>`),
  };
}
