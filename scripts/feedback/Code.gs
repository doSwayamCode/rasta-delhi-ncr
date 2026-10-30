/**
 * Ghar Tak feedback receiver: a Google Apps Script web app bound to the feedback Google Sheet.
 *
 * Setup (once):
 *   1. Open the sheet > Extensions > Apps Script, paste this file, save.
 *   2. Project Settings > Script properties > add SECRET = <a long random string>.
 *   3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   4. Put the web app URL in FEEDBACK_WEBHOOK_URL and the same secret in FEEDBACK_SECRET.
 *
 * It also answers {"action": "list"} with every row, which the app's /admin page uses.
 * Rows go to the "responses" tab (or the first tab); the header row is created from the first submission and new
 * columns are appended if the app starts sending more fields.
 */
function doPost(e) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  };
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: "bad json" });
  }
  var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret || body.secret !== secret) return out({ ok: false, error: "forbidden" });
  if (body.action === "list") return out({ ok: true, rows: listRows() });
  var row = body.row || {};

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("responses") || ss.getSheets()[0];
    var header = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
    Object.keys(row).forEach(function (k) {
      if (header.indexOf(k) < 0) header.push(k);
    });
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    sheet.appendRow(header.map(function (k) {
      var v = row[k];
      return v === null || v === undefined ? "" : v;
    }));
  } finally {
    lock.releaseLock();
  }
  return out({ ok: true });
}

/** Every response row as an object keyed by the header, for the app's /admin page and CSV export. */
function listRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("responses") || ss.getSheets()[0];
  if (sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var header = values[0];
  return values.slice(1).map(function (r) {
    var o = {};
    header.forEach(function (k, i) {
      o[k] = r[i] instanceof Date ? r[i].toISOString() : r[i];
    });
    return o;
  });
}
