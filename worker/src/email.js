import { devMode, LIMITS } from "./settings.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Which email service is set up: "emailjs", "brevo" or null. */
export function emailProvider(env) {
  if (env.EMAILJS_PRIVATE_KEY && env.EMAILJS_SERVICE_ID && env.EMAILJS_TEMPLATE_ID && env.EMAILJS_PUBLIC_KEY) return "emailjs";
  if (env.BREVO_API_KEY && env.SENDER_EMAIL) return "brevo";
  return null;
}

/**
 * Send one email through EmailJS (or Brevo, if that's what is set up).
 * In DEV_MODE the email is printed to the terminal instead.
 * Failures are remembered in settings.email_status so the Admin tab can warn about them.
 */
export async function sendEmail(env, senderName, { to, subject, text, html }) {
  if (devMode(env)) {
    console.log(`\n──── EMAIL (dev mode, not sent) ────\nTo: ${to}\nSubject: ${subject}\n\n${text}\n────────────────────────────────────\n`);
    return true;
  }
  const provider = emailProvider(env);
  let error = null;
  if (!provider) {
    error = "No email service is set up (EmailJS keys are missing).";
  } else {
    try {
      const r = provider === "emailjs"
        ? await fetch("https://api.emailjs.com/api/v1.0/email/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service_id: env.EMAILJS_SERVICE_ID,
            template_id: env.EMAILJS_TEMPLATE_ID,
            user_id: env.EMAILJS_PUBLIC_KEY,
            accessToken: env.EMAILJS_PRIVATE_KEY,
            template_params: { to_email: to, subject, message: text, html_message: html, from_name: senderName || "SCSM Calendar" },
          }),
        })
        : await fetch("https://api.brevo.com/v3/smtp/email", {
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
      if (!r.ok) error = `${provider === "emailjs" ? "EmailJS" : "Brevo"} said: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`;
    } catch (err) {
      error = `Couldn't reach ${provider === "emailjs" ? "EmailJS" : "Brevo"}: ${err && err.message}`;
    }
  }
  if (error) console.error("Email not sent.", error);
  await noteEmailStatus(env, error);
  return !error;
}

/** Save the latest failure (or clear it after a success). Writes only when the state changes. */
async function noteEmailStatus(env, error) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'email_status'").first();
    if (!error && !row) return;
    if (error) {
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('email_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify({ at: Date.now(), error })).run();
    } else {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'email_status'").run();
    }
  } catch { /* never let bookkeeping break sign-in */ }
}

/** EmailJS allows about 1 email per second; pause between emails sent in a row. */
export const pauseBetweenEmails = (env) =>
  emailProvider(env) === "emailjs" && !devMode(env) ? new Promise((r) => setTimeout(r, 1100)) : Promise.resolve();

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
