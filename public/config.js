// ─── Website settings ────────────────────────────────────────────────
// After your first deploy, paste your Worker's address below (README, Part C, step 9).
// It looks like https://scsm-calendar-api.YOUR-NAME.workers.dev — no slash at the end.

window.SCSM_CONFIG = {
  apiUrl: "https://scsm-calendar-api.boris0sargsyan.workers.dev",
};

// Local testing (npm run site + npx wrangler dev) talks to the Worker on your computer.
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  window.SCSM_CONFIG.apiUrl = "http://localhost:8787";
}
