const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "app.js"),
  "utf8",
);

function functionSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain defined`);
  const nextFunction = appSource.indexOf("\nfunction ", start + 1);
  return appSource.slice(start, nextFunction === -1 ? appSource.length : nextFunction);
}

test("home keeps the household calendar as the first view and preserves split creation", () => {
  const renderSource = functionSource("render");
  const homeSource = functionSource("renderHome");

  assert.match(renderSource, /currentProject\(\) \? renderProject\(\) : renderHome\(\)/);
  assert.match(homeSource, /renderHouseholdCalendar\(\)/);
  assert.match(homeSource, /data-create-mode="split"/);
  assert.doesNotMatch(homeSource, /data-create-mode="household"/);
  assert.match(appSource, /function renderCreateSplitForm\(\)/);
});

test("calendar always renders a six-week grid", () => {
  const calendarSource = functionSource("renderHouseholdCalendar");

  assert.match(calendarSource, /while \(cells\.length < 42\)/);
  assert.match(calendarSource, /class="calendar-grid"/);
  assert.match(calendarSource, /data-calendar-day="\$\{value\}"/);
});

test("calendar entry keeps the selected local day and month in sync", () => {
  const entrySource = functionSource("addCalendarTransaction");
  const dateSource = functionSource("today");

  assert.match(
    dateSource,
    /date\.getTime\(\) - date\.getTimezoneOffset\(\) \* 60_000\)\.toISOString\(\)\.slice\(0, 10\)/,
  );
  assert.match(entrySource, /occurred_at: data\.get\("occurred_at"\) \|\| ui\.calendarDay/);
  assert.match(entrySource, /ui\.calendarDay = String\(data\.get\("occurred_at"\) \|\| ui\.calendarDay\)/);
  assert.match(entrySource, /ui\.calendarMonth = ui\.calendarDay\.slice\(0, 7\)/);
});

test("calendar totals include provisional transactions and retain status tags", () => {
  const calendarSource = functionSource("renderHouseholdCalendar");
  assert.doesNotMatch(calendarSource, /filter\(\(transaction\) => transaction\.status !== "provisional"\)/);
  assert.match(calendarSource, /const total = rows\.reduce\(/);
  assert.match(calendarSource, /const monthTotal = monthTransactions\.reduce\(/);
  assert.match(appSource, /function statusTag\(status\)/);
  assert.match(appSource, /provisional: /);
  assert.match(appSource, /statusTag\(transaction\.status\)/);
});
