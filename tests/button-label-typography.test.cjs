const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const targetIds = ["resume-stream", "end-stream", "preview-inventory", "start-stream"];
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selectors, declarations]) => ({
    selectors: selectors.split(",").map((selector) => selector.trim()),
    declarations: Object.fromEntries(declarations.trim().split(";").filter((item) => item.trim())
      .map((item) => item.split(":").map((part) => part.trim()))),
  }));

test("the four button labels use their original shared typography without individual overrides", () => {
  const matches = rules.filter((rule) =>
    rule.selectors.some((selector) => targetIds.some((id) => selector === `#${id}`)));
  assert.equal(matches.length, 0, "Original shared font size, weight and line height apply");
});

test("shared button and status badge styles retain their original typography and spacing", () => {
  const shared = rules.find((rule) => [".primary-action", ".secondary-action", ".danger-action"]
    .every((selector) => rule.selectors.includes(selector)));
  assert.ok(shared);
  assert.deepEqual(shared.declarations, {
    width: "100%", padding: "9px 11px", "border-radius": "9px",
    "font-size": "11px", "font-weight": "760", cursor: "pointer",
  });
  for (const [selector, size] of [
    [".inventory-import-badge", "9px"], [".stream-session-badge", "10px"],
  ]) {
    const badge = rules.find((rule) => rule.selectors.includes(selector));
    assert.equal(badge.declarations["font-size"], size);
    assert.equal(badge.declarations["font-weight"], "760");
  }
});

test("requested labels and separate confirmation controls retain their markup and classes", () => {
  for (const [id, label, className] of [
    ["resume-stream", "Resume stream tracking", "primary-action"],
    ["end-stream", "End Stream Tracking", "danger-action"],
    ["preview-inventory", "Connect and preview", "primary-action"],
    ["start-stream", "Start stream tracking", "primary-action"],
    ["confirm-end-stream", "End and create report", "danger-action stream-session-full-end-action"],
    ["confirm-end-stream-without-report", "End without report", "danger-action"],
    ["cancel-end-stream", "Keep stream active", "secondary-action"],
    ["confirm-inventory-import", "Confirm inventory baseline", "primary-action"],
  ]) {
    const buttons = [...html.matchAll(new RegExp(`<button\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/button>`, "g"))];
    assert.equal(buttons.length, 1, id);
    assert.equal(buttons[0][1].trim(), label);
    assert.ok(buttons[0][0].includes(`class="${className}"`), id);
    assert.ok(buttons[0][0].includes(`type="${id === "preview-inventory" ? "submit" : "button"}"`), id);
  }
});
