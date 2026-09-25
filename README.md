# SCSM Calendar

A private calendar website for SCSM staff and faculty. It shows several shared calendars in one place (Student Work Schedule, School Events, Club Events, Social Media and more). Each person can also add private events of their own. The **Coverage** tab shows who is at the front desk, and when nobody is.

- **Staff only.** People sign in with a 6-digit code sent to their work email. There are no passwords.
- **Remembers each device** for a year. People can sign out of a device at any time, and the admin can sign anyone out.
- **Everyone chooses what they see.** Each calendar has an on/off switch, and the choices follow the person to any device.
- **Private events.** Events you add are visible only to you.
- **Desk coverage.** Shows who's on shift now, who's next, a week grid of covered and uncovered times, and a list of gaps you can copy.
- **Free.** Everything runs on free plans: Cloudflare, Firebase, EmailJS and GitHub.

```
 Outlook / Google calendars ─┐
                             ▼
   Website (Firebase) ◀──▶ Helper (Cloudflare Worker) ◀──▶ Database (Cloudflare D1)
                             │
                             └──▶ EmailJS → Gmail (sends the sign-in code emails)
```

**How it goes live:** you push to the `main` branch on GitHub. GitHub then tests the code and puts the new version online, usually within 2 minutes.

---

## Contents

1. [What's in this folder](#whats-in-this-folder)
2. [Try it on your computer first](#try-it-on-your-computer-first-optional)
3. [One-time setup](#one-time-setup) (Parts A–F, about 1 hour)
4. [Getting a calendar's ICS link](#getting-a-calendars-ics-link)
5. [Daily use for the admin](#daily-use-for-the-admin)
6. [A short guide for staff](#a-short-guide-for-staff)
7. [Free-plan limits with ~100 staff](#free-plan-limits-with-100-staff)
8. [Security](#security)
9. [Troubleshooting](#troubleshooting)
10. [For developers](#for-developers)

---

## What's in this folder

| Path | What it is |
|---|---|
| `public/` | The website (plain HTML, CSS and JavaScript, with no build step). |
| `public/config.js` | The **only website file you edit**: it holds the Worker's address. |
| `worker/src/` | The helper that runs on Cloudflare. It handles sign-in, calendars, private events and the admin tools. |
| `worker/migrations/` | The database tables (SQL files). They are applied automatically. |
| `wrangler.toml` | Cloudflare settings: the database ID, admin emails and website address. |
| `firebase.json`, `.firebaserc` | Firebase Hosting settings and your project ID. |
| `.github/workflows/deploy.yml` | The automatic test-and-deploy steps. |
| `test/` | Automated tests (`npm test`). |

---

## Try it on your computer first (optional)

This runs the whole app on your computer with sample calendars. No accounts are needed, and emails aren't sent: sign-in codes are printed in the terminal instead.

1. Install **Node.js 22 or newer** from [nodejs.org](https://nodejs.org) (the "LTS" button).
2. Open a terminal in this folder and run these once:
   ```bash
   npm install
   ```
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   ```bash
   npm run dev:setup
   ```
3. Start the helper (leave this terminal open):
   ```bash
   npx wrangler dev
   ```
4. In a **second** terminal, start the website:
   ```bash
   npm run site
   ```
5. Open **http://localhost:5500** and sign in:
   - As the admin, with `boris.sargsyan1@marist.edu`.
   - As regular staff, with `staff@marist.edu` or `elina@marist.edu`.
6. Look in the **first** terminal for a box like this, and type the code:
   ```
   ──── EMAIL (dev mode, not sent) ────
   Subject: 123456 is your SCSM Calendar code
   ```

The sample Student Work Schedule is already marked as a shift calendar, so the Coverage tab has data for this week. To start over with fresh sample data, run `npm run dev:setup` again.

---

## One-time setup

You'll create 3 free accounts, collect a few keys, and paste them into GitHub. Keep a text file open to note things down as you go. The steps below tell you exactly what to note.

> **Tip:** Do the parts in order. Part E needs things from A–D.

### Part A: EmailJS (sends the code emails), about 15 minutes

EmailJS sends the emails through a normal Gmail account. **We recommend a new Gmail account just for this**, for example `scsm.calendar@gmail.com`. Codes will come from that address.

1. **Create the Gmail account** at [accounts.google.com/signup](https://accounts.google.com/signup), if you're making a new one.
2. Go to **[emailjs.com](https://www.emailjs.com)**, click **Sign Up**, and create a free account.
3. **Connect Gmail:**
   1. Click **Email Services → Add New Service → Gmail → Connect Account**.
   2. Sign in with the calendar's Gmail account and allow **"Send email on your behalf"**.
   3. Click **Create Service**.
   4. Copy the **Service ID** (looks like `service_ab12cd3`). **Save as: EmailJS service ID**
4. **Create the email template:**
   1. Click **Email Templates → Create New Template**.
   2. On the right, fill in:
      - **To Email:** `{{to_email}}`
      - **From Name:** `{{from_name}}`
      - Leave **From Email** set to use the default address, and leave **Reply To** empty.
   3. **Subject:** `{{subject}}`
   4. **Content:** delete the sample text and type exactly `{{{html_message}}}`. That's **three** curly braces on each side, so the email keeps its formatting.
      > If the content editor changes the braces, switch it to the code or HTML view, or use `{{message}}` (two braces) for plain text.
   5. Click **Save**. Open the template's **Settings** tab and copy the **Template ID** (like `template_xy98z`). **Save as: EmailJS template ID**
5. **Keys and the important setting:**
   1. Click your account name, then **Account**.
   2. On the **General** tab, copy the **Public Key**. **Save as: EmailJS public key**
   3. Still under **Account**, copy the **Private Key**. **Save as: EMAILJS_PRIVATE_KEY** (secret)
   4. Open the **Security** tab and turn **on** "Allow EmailJS API for non-browser applications". Without this, the helper can't send emails. Also turn on "Use Private Key", then save.
6. **Test it:** in the template, click **Test It**, put your own email in `to_email` and anything in `subject` and `html_message`, then send. Check that it arrives.

> ⚠️ **EmailJS's free plan is 200 emails a month.** The app sends an email only when someone signs in on a new device, or when you choose to send welcome emails. Tips:
> - Welcome emails are **off** by default. You can simply tell people the site address yourself.
> - If the allowance runs out, **nobody can get a sign-in code until next month.** People who are already signed in are fine. The Admin tab's **Settings** section shows a warning when emails start failing.
> - If this becomes a problem, EmailJS's paid plan or Brevo (300 a day, free) can replace it. The helper already supports Brevo: set `BREVO_API_KEY` and `SENDER_EMAIL` instead.

### Part B: Cloudflare (the helper and the database), about 15 minutes

1. Go to **[dash.cloudflare.com](https://dash.cloudflare.com)** and sign up (free).
2. **Choose your workers.dev name.** In the left menu, click **Workers & Pages**. If asked, pick a subdomain, for example `scsm`. Your helper's address will be `https://scsm-calendar-api.<that-name>.workers.dev`.
3. **Create the database:**
   1. In the left menu, click **Storage & Databases → D1 SQL Database**, then **Create**.
   2. Name it exactly **`scsm-calendar`** and click **Create**.
   3. On the database page, copy the **Database ID** (a long code like `3f2a…`). Note it down as **D1 database ID**.
4. **Find your Account ID:** go to **Workers & Pages → Overview**. The **Account ID** is on the right. Note it down as **CLOUDFLARE_ACCOUNT_ID**.
5. **Create an API token** (this lets GitHub deploy for you):
   1. Click the person icon (top right), then **My Profile → API Tokens → Create Token**.
   2. Next to **Edit Cloudflare Workers**, click **Use template**.
   3. Under **Permissions**, click **+ Add more** and choose **Account**, then **D1**, then **Edit**.
   4. Under **Account Resources**, choose your account. Under **Zone Resources**, choose **All zones**.
   5. Click **Continue to summary**, then **Create Token**.
   6. Copy the token. Note it down as **CLOUDFLARE_API_TOKEN**. Cloudflare only shows it once.

### Part C: Firebase (the website), about 10 minutes

1. Go to **[console.firebase.google.com](https://console.firebase.google.com)** and click **Create a project**.
   1. Name it, for example `scsm-calendar`. Google Analytics isn't needed.
   2. Stay on the free **Spark** plan. Don't upgrade.
2. In the left menu, click **Build → Hosting**, then **Get started**. Click **Next** through the screens; you don't need to run the commands they show.
3. Note down the **Project ID** as **Firebase project ID**. It's in the gear ⚙ menu under **Project settings**, and looks like `scsm-calendar-1a2b3`.
4. Your website address will be **`https://<project-id>.web.app`**. Note it down.
5. **Create a deploy key** (this lets GitHub publish the website):
   1. Open **[console.cloud.google.com/iam-admin/serviceaccounts](https://console.cloud.google.com/iam-admin/serviceaccounts)**, and pick the same project at the top.
   2. Click **+ Create service account**. Name it `github-deploy` and click **Create and continue**.
   3. Add the role **Firebase Hosting Admin**. Click **+ Add another role** and add **API Keys Viewer**. Click **Continue**, then **Done**.
   4. Click the new `github-deploy` account, open the **Keys** tab, click **Add key → Create new key**, choose **JSON**, then **Create**. A file downloads.
   5. Open that file in a text editor and copy **everything** in it. This is **FIREBASE_SERVICE_ACCOUNT**. Keep the file private and delete it once it's saved in GitHub.

> Shortcut for people who use a terminal: `npx firebase-tools init hosting:github` does step 5 for you and adds the GitHub secret itself.

### Part D: GitHub (secrets and 3 small file edits), about 10 minutes

1. Open your repository on **github.com**.
2. Go to **Settings → Secrets and variables → Actions**, then click **New repository secret**.
3. Add these 3 secrets. The name must match exactly; the value is what you noted down.

   | Name | Value | From |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | the Cloudflare API token | Part B, step 5 |
   | `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare Account ID | Part B, step 4 |
   | `FIREBASE_SERVICE_ACCOUNT` | the whole JSON file's contents | Part C, step 5 |

4. Now edit 3 files in GitHub. Click the file, then the ✏️ pencil icon, then **Commit changes** when you're done.
5. **`wrangler.toml`:**
   - Replace `PASTE_YOUR_D1_DATABASE_ID_HERE` with your **D1 database ID**.
   - Replace `PASTE_SERVICE_ID`, `PASTE_TEMPLATE_ID` and `PASTE_PUBLIC_KEY` with your **EmailJS service ID**, **template ID** and **public key** from Part A. These three aren't secret.
   - In `ALLOWED_ORIGINS` and `SITE_URL`, replace `YOUR-PROJECT` with your **Firebase project ID**. For example: `https://scsm-calendar-1a2b3.web.app,https://scsm-calendar-1a2b3.firebaseapp.com`.
6. **`.firebaserc`:** replace `YOUR-FIREBASE-PROJECT-ID` with your **Firebase project ID**.
7. **`public/config.js`:** replace `YOUR-NAME` with your workers.dev subdomain from Part B, step 2. For example: `https://scsm-calendar-api.scsm.workers.dev`.

Each commit starts a deploy. Early ones may fail until everything is filled in, and that's expected.

### Part E: The first deploy and Cloudflare secrets, about 10 minutes

1. On GitHub, open the **Actions** tab. Wait until the latest **Test and deploy** run has 3 green ticks. If one is red, click it: the error says what's missing.
2. Now add the 2 secrets to the helper in Cloudflare. They are stored only in Cloudflare, never in GitHub.
   1. Go to Cloudflare **Workers & Pages** and click **scsm-calendar-api**.
   2. Open **Settings → Variables and Secrets** and click **+ Add**.
   3. Add these 2, with **Type: Secret** for both:

   | Name | Value |
   |---|---|
   | `EMAILJS_PRIVATE_KEY` | the EmailJS private key from Part A |
   | `SESSION_SECRET` | 64 random letters and numbers. Use a password generator (for example, 1Password's "Generate password", 64 characters, no symbols). |

   4. Click **Deploy** if Cloudflare asks. You don't need to redeploy from GitHub.
3. Check the helper: open `https://scsm-calendar-api.<your-name>.workers.dev`. It should show `{"ok":true,"service":"SCSM Calendar API"}`.

> Changing `SESSION_SECRET` later signs **everyone** out. Only do it if you think it leaked.

### Part F: First sign-in, about 5 minutes

1. Open your website, `https://<project-id>.web.app`.
2. Sign in with **boris.sargsyan1@marist.edu**, then enter the code from the email. Check junk too.
3. Open the **Admin** tab:
   1. **Shared calendars → + Add shared calendar.** Add each calendar with its ICS link (see the next section) and click **Test link**. For the **Student Work Schedule**, tick **Shift calendar**, then check that the name preview shows the workers' names correctly.
   2. **Desk coverage:** check the office hours (Mon–Fri, 9–5 by default) and add holidays and breaks.
   3. **People:** paste everyone's emails and choose their role. Welcome emails use your 200-a-month allowance, so it's usually better to send people the link yourself.

You're live. 🎉

---

## Getting a calendar's ICS link

An **ICS link** is a private web address that lets other apps read a calendar. You need one for each shared calendar. Staff can also paste their own ICS links to overlay their personal calendars.

**Outlook (web, Microsoft 365):**
1. Open Outlook on the web, then **Settings ⚙ → Calendar → Shared calendars**.
2. Under **Publish a calendar**, choose the calendar and **Can view all details**, then click **Publish**.
3. Copy the **ICS** link. (Don't use the HTML link.)

> No "Publish a calendar" option? Marist IT may have turned it off. Ask them to allow publishing for these calendars. You must be an owner or editor of a calendar to publish it.

**Google Calendar:**
1. Open **Settings**. On the left, click the calendar.
2. Under **Integrate calendar**, copy the **Secret address in iCal format**. For a public calendar, you can use the **Public address in iCal format**.

**Club Events (Parijat Das's calendar):** ask Parijat to send you the link using the steps above, then add it as a shared calendar with owner `Parijat Das`.

> ICS links are like passwords. Anyone with the link can read the calendar. The app keeps shared links on the server only, and staff never see them.

---

## Daily use for the admin

Everything is done in the **Admin** tab. Every change is recorded under **Recent activity**, with who made it and when.

### Who can do what

| Role | Who | Can |
|---|---|---|
| **Super admin** | Set in `wrangler.toml` (`SUPERADMIN_EMAILS`) | Everything. Can't be removed, demoted or signed out by anyone from the website. |
| **Admin** | Made in **Admin → People** | Everything a super admin can, including making other admins, but can't change super admins. |
| **Staff** | Added in **Admin → People** | See all calendars, coverage, add private events. |
| **Student assistant** | Added in **Admin → People** | Same as staff, but can't see calendars marked "Staff only". Can have an **access until** date (e.g. end of semester). |
| **Anyone else** | — | Sees the public front page only. If they try to sign in they're told right away that it's for SCSM staff, and no email is sent. |

### Common tasks

| Task | How |
|---|---|
| Give someone access | **People**: paste their email, choose **Staff** or **Student assistant**, click **Add people**. |
| Add many people | Paste the whole list: one per line, comma-separated, copied from a spreadsheet, or "Name &lt;email&gt;" — names are kept. |
| Make someone an admin | **People**: change their role to **Admin**. It takes effect on their next click. |
| Student assistants for a semester | Add them as **Student assistant** with an **access until** date. After that day they can't sign in. |
| Remove someone | Click **Remove** next to them. They're signed out everywhere immediately. |
| Someone lost a phone | Click **Devices** next to them, then **Sign out** on that device. |
| Add a calendar | **Shared calendars → + Add**, paste the ICS link, then **Test link**. |
| Show a calendar on the public front page | Edit it and set **Who can see it** to **Public**. |
| Hide a calendar from student assistants | Set **Who can see it** to **Staff only**. |
| Change the order in the sidebar | Use the ▲ ▼ arrows. |
| Add a holiday or break | **Desk coverage → + Add closed dates**, then **Save**. |
| Email the gap list | **Coverage** tab, then **Copy list**, then paste it into Outlook. |
| Change the site title or front-page text | **Settings**. |
| Add another super admin | Edit `SUPERADMIN_EMAILS` in `wrangler.toml` on GitHub. It's live after the automatic deploy. |

**Events themselves** are still edited in Outlook or Google as usual. The website picks up changes within about 20 minutes.

---

## A short guide for staff

*(You can paste this into an email.)*

1. Open **https://&lt;project-id&gt;.web.app** and enter your work email. You'll get a 6-digit code by email (check junk). Enter it, and this device stays signed in for a year.
   **On a shared or public computer?** Untick "Keep me signed in", and sign out when you're done (click your initial at the top right, then **Sign out of this device**).
2. Use the switches on the left to show or hide calendars. On a phone, tap ☰. Your choices are saved for all your devices.
3. **+ Add event** creates a private event that only you can see.
4. **+ Add my Outlook or Google calendar** shows your own calendar here as well. It's private to you.
5. Click any event to see where it comes from (for example, "From Outlook — Student Work Schedule").
6. The **Coverage** tab shows who's at the front desk now, who's next, and this week's gaps.

---

## Free-plan limits with ~100 staff

Rough numbers, assuming each person opens the site about 3 times a workday. Check each provider's current limits, because they change.

| Service | Free limit | What 100 staff use | Notes |
|---|---|---|---|
| Cloudflare Workers | 100,000 requests/day | ~2,000–3,000/day | Each visit is about 6–8 requests. |
| D1 reads | 5 million rows/day | ~20,000–50,000/day | Sessions and settings are looked up by key. |
| D1 writes | 100,000 rows/day | ~1,000–3,000/day | Mostly feed refreshes (at most 72 per calendar per day, and only when someone is looking). "Last seen" is saved at most twice a day per device. |
| D1 storage | 5 GB | under 50 MB | Feeds are stored compressed. |
| EmailJS | **200 emails/month** | ~5–20/day at the start, then a few a week | Emails go out only when a device signs in for the first time, or when welcome emails are sent. **This is the tightest limit.** Launch month can use most of it, so keep welcome emails to a minimum. |
| Firebase Hosting | 10 GB stored, 360 MB/day transfer | ~20–50 MB/day | FullCalendar and ical.js load from the jsDelivr CDN, which doesn't count. |
| GitHub Actions | 2,000 min/month (private repo) | ~2 min per push | Public repos are unlimited. |

**Built to stay small:** feeds are cached for 20 minutes on the server and 5 minutes in the browser. Coverage is calculated in the browser. Toggle changes are saved once, after you stop clicking. Admin changes are grouped into one database write where possible.

---

## Security

- **Sign-in:**
  - Codes expire after **10 minutes**, and 5 wrong tries cancel a code.
  - Each email can request at most **3 codes an hour**.
  - Codes are stored **hashed**.
  - Emails that aren't on the list are refused immediately, and no email is sent. (This means someone could check whether an address is on the list; that was a deliberate choice for clearer messages.)
- **Sessions:** one database row per device, and it stores only a hash of the device's token.
  - Sessions last 365 days, or 12 hours if "Keep me signed in" is unticked.
  - Removing a person, or revoking their devices, takes effect on their next click.
- **Every helper request checks the session and the person's current role.** Admin requests need the Admin or Super admin role. Super admins (`SUPERADMIN_EMAILS`) can't be changed from the website at all.
- **Calendar visibility is enforced on the server.** Student assistants can't load "Staff only" calendars, and signed-out visitors can only load calendars marked "Public".
- **Private data is scoped on the server.** Personal events, choices and calendar links are always looked up by the signed-in person's email, so one person can never read or change another's. There are tests for this.
- **Shared ICS links never reach the browser.**
- **CORS allows only your website address**, from `ALLOWED_ORIGINS` in `wrangler.toml`.
- **Inputs are checked and size-limited.** Text people type is always shown as plain text, never as HTML.
- **The website sends strict security headers** (Content-Security-Policy and others), and the CDN scripts are pinned with integrity hashes.
- **Secrets stay out of the repo.** `EMAILJS_PRIVATE_KEY` and `SESSION_SECRET` live in Cloudflare secrets only. Emails are sent by the helper, never from the web page, so the code and the key never reach the browser. `.gitignore` blocks `.dev.vars`, `.env` files and key files.
- **Personal events are kept when someone is removed**, in case they come back. To delete someone's data completely, ask a developer to run a delete on the D1 tables for that email.

---

## Troubleshooting

| Problem | What to check |
|---|---|
| The page says *"isn't connected to its Worker yet"* | `public/config.js` still has `YOUR-NAME` (Part D, step 7). |
| *"This site isn't allowed to use the calendar service"* | `ALLOWED_ORIGINS` in `wrangler.toml` must be exactly your site address, with no slash at the end. |
| *"The server isn't set up yet: SESSION_SECRET is missing"* | Part E, step 2. |
| No code email arrives | Check junk. Open **Admin → Settings**: a yellow warning there shows the exact problem. In EmailJS, the **Email History** page shows each send. The usual causes are: the monthly limit is reached, "Allow EmailJS API for non-browser applications" is off, or the template's **To Email** isn't `{{to_email}}`. |
| *"Couldn't load Club Events right now. Showing the last saved copy."* | The Outlook or Google link is down or was unpublished. In **Admin → Shared calendars → Edit → Test link**, check the error. |
| A GitHub Actions run is red | Click it, then open the red step. The first lines say what's missing. |
| Coverage says "No shift calendar yet" | Edit the Student Work Schedule and tick **Shift calendar**. |

---

## For developers

- **Run the tests:** `npm test`. This covers:
  - **Coverage and ICS** (`test/coverage.test.js`): overlapping and odd-time shifts, closed dates, cancelled and moved occurrences, and the switch back from daylight saving time.
  - **The Worker** (`test/worker.test.js`): sign-in, sessions, keeping each person's data private, admin-only access, feed caching and CORS. These tests run against real SQLite (Node's `node:sqlite`) through a small D1 stand-in.
- **Shared code:** `public/js/tz.js`, `ics.js` and `coverage.js` are plain ES modules. The browser, the Worker (bundled by wrangler) and the tests all use the same files.
- **Changing the database:** add a new numbered file such as `worker/migrations/0002_something.sql`. The deploy applies it automatically.
- **Main routes:**
  - Sign-in: `POST /api/auth/request`, `POST /api/auth/verify`, `POST /api/auth/signout`.
  - Signed-in person: `GET /api/bootstrap`, `PUT /api/prefs`, `GET /api/feeds/shared/:id`, `GET /api/feeds/mine/:id`, `/api/my-agenda[/:id]` (personal events), `/api/my-feeds[/:id]`.
  - Admin: `/api/admin/*`.
  - Access rules are listed in one table in `worker/src/index.js`.
- **Times:** office hours, personal events and closed dates are wall-clock times in **America/New_York**. The calendar grid shows times in the viewer's own time zone.
