/**
 * The Google Sheet that collects feedback answers.
 *
 * WEBHOOK is the sheet's Apps Script web-app URL (scripts/feedback/Code.gs, deployed once by the
 * sheet's owner). Rows are written through it; it only appends, and reading rows back needs the
 * script's own SECRET property, which never leaves Google. SHEET_ID is used by /admin to embed the
 * sheet: Google itself decides who may view it, so only people the sheet is shared with see data.
 *
 * Both can be overridden with FEEDBACK_WEBHOOK_URL / FEEDBACK_SHEET_ID on the host.
 */
const DEFAULT_SHEET_ID = "1H0kaT8fa2UOtFvZdNi6w6CojxDEMfGKe8qhQyNiGdMg"; // "Ghar Tak metadata"
const DEFAULT_WEBHOOK =
  "https://script.google.com/macros/s/AKfycbwwoMpIoItTwKDbDs0tif0iO0c3ywPIm74nEQ0NG79OFxroru0ZRmaDO65nROn96__DDQ/exec";

export const SHEET_ID = process.env.FEEDBACK_SHEET_ID || DEFAULT_SHEET_ID;
export const SHEET_WEBHOOK = process.env.FEEDBACK_WEBHOOK_URL || DEFAULT_WEBHOOK;
