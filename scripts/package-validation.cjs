"use strict";

const path = require("node:path").posix;

const PDF_RESOURCES = Object.freeze([
  "vendor/jspdf/jspdf.umd.min.js",
  "vendor/jspdf/LICENSE",
  "vendor/jspdf-autotable/jspdf.plugin.autotable.min.js",
  "vendor/jspdf-autotable/LICENSE.txt",
  "vendor/fonts/DejaVuSans.ttf",
  "vendor/fonts/DejaVuSans-Bold.ttf",
  "vendor/fonts/LICENSE-DejaVu.txt",
]);

function fail(message) {
  throw new Error(message);
}

function validateArchivePath(relativePath) {
  // These names must extract identically on Windows, macOS and Linux. Do not
  // silently normalize archive entries: that can conceal collisions/traversal.
  if (typeof relativePath !== "string" || !relativePath ||
      /[\\:<>"|?*\x00-\x1f\x7f]/.test(relativePath) ||
      relativePath.startsWith("/") || relativePath.normalize("NFC") !== relativePath) {
    fail("Unsafe or nonportable archive path.");
  }
  for (const segment of relativePath.split("/")) {
    if (!segment || segment === "." || segment === ".." || /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(segment)) {
      fail("Unsafe or nonportable archive path segment.");
    }
  }
  return relativePath;
}

function isOsJunk(name) {
  const base = String(name).split(/[\\/]/).pop();
  return /^(?:\.ds_store|\._.*|thumbs\.db|desktop\.ini|__macosx)$/i.test(base);
}

function assertSafeFile(relativePath, bytes) {
  validateArchivePath(relativePath);
  const segments = relativePath.split("/");
  const unsafeName = segments.some((name) =>
    /^(?:\.?tokens?(?:\.json)?|oauth[_-]tokens?\.json)$/i.test(name) ||
    /^(?:\.env(?:[.-].*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.aws|\.ssh)$/i.test(name) ||
    /(?:^|[._-])(?:credentials?|secrets?|client[_-]?secrets?|service[_-]?accounts?)(?:[._-]|$)/i.test(name) ||
    /\.env(?:[.-].*)?$/i.test(name) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?!\.pub$)(?:\..*)?$/i.test(name) ||
    /(?:\.(?:pem|key|p12|pfx|ppk)|(?:^|[._-])private[_-]?key(?:\..*)?)$/i.test(name));
  if (unsafeName) fail(`Refusing potentially sensitive file: ${relativePath}`);
  const source = Buffer.from(bytes).toString("utf8");
  const secretPatterns = [
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
    /PuTTY-User-Key-File-[23]:/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    /\b(?:xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{35})\b/,
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
    /\bauthorization["']?\s*[:=]\s*["'](?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{12,}["']/i,
    /["']?(?:client[_-]?secret|private[_-]?key|api[_-]?(?:key|secret)|access[_-]?token|refresh[_-]?token|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key)|password|passwd)["']?\s*[:=]\s*["'][^"'\r\n]+["']/i,
    /(?:^|\n)\s*(?:export\s+)?(?:[A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|API_KEY))\s*=\s*\S+/,
  ];
  const staticTemplateSecret = [...source.matchAll(/["']?(?:client[_-]?secret|private[_-]?key|api[_-]?(?:key|secret)|access[_-]?token|refresh[_-]?token|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key)|password|passwd)["']?\s*[:=]\s*`((?:\\.|[^`\\])+)`/gi)]
    .some((match) => !/(?:^|[^\\])(?:\\\\)*\$\{/.test(match[1]));
  if (staticTemplateSecret || secretPatterns.some((pattern) => pattern.test(source))) {
    // Never include a matching value or source excerpt in diagnostics.
    fail(`Potential secret content detected in: ${relativePath}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.manifest_version !== 3) {
    fail("manifest.json must declare manifest_version 3.");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail("manifest.json must contain a nonempty name.");
  }
  // Chrome accepts one to four 0..65535 components, no leading zeroes, and
  // requires at least one nonzero component (not SemVer prerelease syntax).
  if (typeof manifest.version !== "string" ||
      !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(manifest.version) ||
      manifest.version.split(".").some((part) => Number(part) > 65535) ||
      !manifest.version.split(".").some((part) => Number(part) > 0)) {
    fail("manifest.json version must be a valid Chrome extension version.");
  }
  if (manifest.minimum_chrome_version !== undefined &&
      (typeof manifest.minimum_chrome_version !== "string" ||
       !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(manifest.minimum_chrome_version))) {
    fail("manifest.json minimum_chrome_version must be a Chrome version string.");
  }
}

function decodeHtml(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const name = entity.slice(1, -1).toLowerCase();
    if (name.startsWith("#")) {
      const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\0";
    }
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[name];
  });
}

function createRequireResource(files) {
  return (rawReference, owner, { root = false, external = true, glob = false } = {}) => {
    if (typeof rawReference !== "string" || !rawReference.trim()) {
      fail(`Invalid local resource reference in ${owner}.`);
    }
    let reference = rawReference.trim();
    if (/^[a-z]:/i.test(reference) || reference.includes("\\")) fail(`Unsafe resource path in ${owner}.`);
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
      if (!external || /^file:/i.test(reference)) fail(`Invalid external resource reference in ${owner}.`);
      return;
    }
    if (/^[?#]/.test(reference)) {
      if (!external) fail(`Invalid local resource reference in ${owner}.`);
      return;
    }
    reference = reference.split(/[?#]/, 1)[0];
    try { reference = decodeURIComponent(reference); } catch { fail(`Invalid encoded resource path in ${owner}.`); }
    if (reference.includes("\\") || /[\x00-\x1f\x7f]/.test(reference)) {
      fail(`Unsafe resource path in ${owner}.`);
    }
    const parts = reference.startsWith("/") || root ? [] : path.dirname(owner).split("/").filter((part) => part !== ".");
    for (const segment of reference.split("/")) {
      if (segment === "..") {
        if (!parts.length) fail(`Resource reference escapes extension root in ${owner}.`);
        parts.pop();
      } else if (segment && segment !== ".") parts.push(segment);
    }
    const target = parts.join("/");
    validateArchivePath(glob ? target.replaceAll("*", "wildcard") : target);
    if (glob && target.includes("*")) {
      const pattern = new RegExp(`^${target.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      if (![...files.keys()].some((name) => pattern.test(name))) fail(`Resource pattern has no matching files in ${owner}: ${target}`);
    } else if (!files.has(target)) {
      fail(`Missing local resource referenced by ${owner}: ${target}`);
    }
  };
}

function manifestResources(manifest, requireResource) {
  const local = (value) => requireResource(value, "manifest.json", { root: true, external: false });
  const object = (value, label) => {
    if (!isObject(value)) fail(`Invalid ${label} in manifest.json.`);
    return value;
  };
  const list = (value, label) => {
    if (!Array.isArray(value)) fail(`Invalid ${label} in manifest.json.`);
    return value;
  };
  const icons = (value) => {
    if (typeof value === "string") local(value);
    else Object.values(object(value, "icons")).forEach(local);
  };
  if (manifest.icons !== undefined) icons(manifest.icons);
  if (manifest.background !== undefined) {
    const background = object(manifest.background, "background");
    if (background.scripts !== undefined || background.page !== undefined) fail("Manifest V3 background must use service_worker.");
    local(background.service_worker);
  }
  if (manifest.content_scripts !== undefined) {
    for (const entry of list(manifest.content_scripts, "content_scripts")) {
      object(entry, "content_scripts entry");
      for (const kind of ["js", "css"]) {
        if (entry[kind] !== undefined) list(entry[kind], `content_scripts.${kind}`).forEach(local);
      }
    }
  }
  for (const name of ["action", "browser_action", "page_action"]) {
    if (manifest[name] !== undefined) {
      const action = object(manifest[name], name);
      if (action.default_popup !== undefined && action.default_popup !== "") local(action.default_popup);
      if (action.default_icon !== undefined) icons(action.default_icon);
    }
  }
  for (const [key, field] of [["side_panel", "default_path"], ["options_ui", "page"], ["storage", "managed_schema"]]) {
    if (manifest[key] !== undefined) {
      const value = object(manifest[key], key)[field];
      if (value !== undefined) local(value);
      else if (key !== "storage") fail(`Missing ${key}.${field} in manifest.json.`);
    }
  }
  for (const key of ["options_page", "devtools_page"]) if (manifest[key] !== undefined) local(manifest[key]);
  if (manifest.chrome_url_overrides !== undefined) Object.values(object(manifest.chrome_url_overrides, "chrome_url_overrides")).forEach(local);
  if (manifest.sandbox !== undefined) list(object(manifest.sandbox, "sandbox").pages, "sandbox.pages").forEach(local);
  if (manifest.declarative_net_request !== undefined) {
    list(object(manifest.declarative_net_request, "declarative_net_request").rule_resources, "rule_resources")
      .forEach((entry) => local(object(entry, "rule_resources entry").path));
  }
  if (manifest.web_accessible_resources !== undefined) {
    for (const entry of list(manifest.web_accessible_resources, "web_accessible_resources")) {
      list(object(entry, "web_accessible_resources entry").resources, "web_accessible_resources.resources")
        .forEach((value) => requireResource(value, "manifest.json", { root: true, external: false, glob: true }));
    }
  }
  if (manifest.default_locale !== undefined) {
    if (typeof manifest.default_locale !== "string" || !/^[a-zA-Z0-9_@-]+$/.test(manifest.default_locale)) fail("Invalid default_locale in manifest.json.");
    local(`_locales/${manifest.default_locale}/messages.json`);
  }
}

function decodeJsString(value) {
  return value.replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|\r?\n|([\s\S]))/gi,
    (_, wide, unicode, hex, escaped) => {
      if (wide || unicode || hex) {
        const code = parseInt(wide || unicode || hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "\0";
      }
      if (escaped === undefined) return "";
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" })[escaped] ?? escaped;
    });
}

// A small non-evaluating lexer, not a general dynamic JavaScript analyzer. It
// keeps strings/comments separate so prose cannot masquerade as an import.
function jsTokens(source) {
  const tokens = [];
  const parentheses = [];
  let index = 0;
  function quoted(quote) {
    index += 1;
    const start = index;
    while (index < source.length) {
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === quote) break;
      index += 1;
    }
    const value = decodeJsString(source.slice(start, index));
    index += 1;
    return value;
  }
  function template() {
    index += 1;
    const start = index;
    let prefix;
    while (index < source.length) {
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === "`") {
        const value = prefix === undefined ? decodeJsString(source.slice(start, index)) : prefix;
        index += 1;
        return { type: "string", value, dynamic: prefix !== undefined };
      }
      if (source.slice(index, index + 2) === "${") {
        if (prefix === undefined) prefix = decodeJsString(source.slice(start, index));
        index += 2;
        let depth = 1;
        while (index < source.length && depth) {
          if (source[index] === '"' || source[index] === "'") quoted(source[index]);
          else if (source[index] === "`") template();
          else {
            if (source[index] === "{") depth += 1;
            if (source[index] === "}") depth -= 1;
            index += 1;
          }
        }
      } else index += 1;
    }
    return { type: "string", value: prefix ?? "", dynamic: true };
  }
  function regexLiteral() {
    // Slash is ambiguous in JS. Only enter a regexp where an expression can
    // begin; division after identifiers/literals/calls must remain punctuation.
    const previous = tokens.at(-1);
    const canStart = !previous || previous.regexAfter ||
      (previous.type === "word" && /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(previous.value)) ||
      (previous.type === "punct" && /^[=(,:;!&|?+*%~^<>\[\{\/-]$/.test(previous.value));
    if (!canStart) return false;
    let cursor = index + 1;
    let characterClass = false;
    while (cursor < source.length && !/[\r\n]/.test(source[cursor])) {
      if (source[cursor] === "\\") { cursor += 2; continue; }
      if (source[cursor] === "[") characterClass = true;
      else if (source[cursor] === "]") characterClass = false;
      else if (source[cursor] === "/" && !characterClass) {
        cursor += 1;
        while (cursor < source.length && /[a-z]/i.test(source[cursor])) cursor += 1;
        index = cursor;
        tokens.push({ type: "regex", value: "" });
        return true;
      }
      cursor += 1;
    }
    return false;
  }
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === "/" && regexLiteral()) continue;
    if (char === '"' || char === "'") { tokens.push({ type: "string", value: quoted(char) }); continue; }
    if (char === "`") { tokens.push(template()); continue; }
    if (/[\w$]/.test(char)) {
      const start = index++;
      while (index < source.length && /[\w$]/.test(source[index])) index += 1;
      tokens.push({ type: "word", value: source.slice(start, index) });
      continue;
    }
    if (["++", "--"].includes(source.slice(index, index + 2))) {
      tokens.push({ type: "punct", value: source.slice(index, index + 2) });
      index += 2;
      continue;
    }
    if (char === "(") parentheses.push(tokens.at(-1)?.type === "word" && /^(?:if|while|for|with|switch|catch)$/.test(tokens.at(-1).value));
    const regexAfter = char === ")" ? parentheses.pop() : false;
    if (char !== "?" || source[index + 1] !== ".") tokens.push({ type: "punct", value: char, regexAfter });
    index += 1;
  }
  return tokens;
}

function javascriptResources(source, owner, requireResource) {
  const tokens = jsTokens(source);
  const value = (index) => tokens[index]?.value;
  const literal = (index, root = false) => {
    const token = tokens[index];
    if (token?.type !== "string") return;
    // A dynamic query/hash does not change a literal local pathname. Other
    // interpolated pathnames are outside static analysis (PDF fonts below).
    if (token.dynamic && !/[?#]/.test(token.value)) return;
    requireResource(token.value, owner, { root, external: !root });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "word") continue;
    if (value(index) === "getURL" && value(index - 1) === "." && value(index - 2) === "runtime" && value(index + 1) === "(") {
      if ([")", ","].includes(value(index + 3))) literal(index + 2, true);
    }
    if (value(index) === "importScripts" && value(index + 1) === "(") {
      let depth = 0;
      let argumentStart = index + 2;
      for (let cursor = argumentStart; cursor < tokens.length; cursor += 1) {
        const current = value(cursor);
        if (depth === 0 && [",", ")"].includes(current)) {
          if (cursor === argumentStart + 1) literal(argumentStart);
          argumentStart = cursor + 1;
          if (current === ")") break;
        } else if (["(", "[", "{"].includes(current)) depth += 1;
        else if ([")", "]", "}"].includes(current)) depth -= 1;
      }
    }
    if (!["import", "export"].includes(value(index)) || value(index - 1) === ".") continue;
    if (value(index + 1) === "(") {
      if ([")", ","].includes(value(index + 3))) literal(index + 2);
    } else if (tokens[index + 1]?.type === "string") literal(index + 1);
    else {
      for (let cursor = index + 1; cursor < Math.min(index + 100, tokens.length); cursor += 1) {
        if (value(cursor) === ";" || value(cursor) === "(") break;
        if (value(cursor) === "from") { literal(cursor + 1); break; }
      }
    }
  }
}

function cssResources(source, owner, requireResource) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|@import\s+(?:"([^"]+)"|'([^']+)')/gi)) {
    const reference = match.slice(1).find((part) => part !== undefined)?.trim();
    if (reference) requireResource(reference, owner);
  }
}

function htmlResources(source, owner, requireResource) {
  const html = source.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of html.matchAll(/<(script|link|img|source|audio|video|iframe|embed)\b([^>]*)>/gi)) {
    const attribute = match[1].toLowerCase() === "link" ? "href" : "src";
    const attributes = match[2];
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const attr of attributes.matchAll(attrPattern)) {
      if (attr[1].toLowerCase() === attribute) requireResource(decodeHtml(attr[2] ?? attr[3] ?? attr[4] ?? ""), owner);
    }
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) cssResources(match[1], owner, requireResource);
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) javascriptResources(match[1], owner, requireResource);
}

function validateExtension(files) {
  if (!(files instanceof Map)) fail("Extension files must be supplied as a Map.");
  const caseFolded = new Set();
  for (const [relativePath, bytes] of files) {
    assertSafeFile(relativePath, bytes);
    const folded = relativePath.toLowerCase();
    if (caseFolded.has(folded)) fail("Extension paths collide on a case-insensitive filesystem.");
    caseFolded.add(folded);
  }
  if (!files.has("manifest.json")) fail("Extension root is missing manifest.json.");
  let manifest;
  try { manifest = JSON.parse(Buffer.from(files.get("manifest.json")).toString("utf8")); }
  catch { fail("manifest.json must contain valid JSON."); }
  validateManifest(manifest);
  const requireResource = createRequireResource(files);
  manifestResources(manifest, requireResource);
  for (const [name, bytes] of files) {
    if (!/\.(?:[cm]?js|html?|css)$/i.test(name)) continue;
    const source = Buffer.from(bytes).toString("utf8");
    if (/\.[cm]?js$/i.test(name)) javascriptResources(source, name, requireResource);
    else if (/\.css$/i.test(name)) cssResources(source, name, requireResource);
    else htmlResources(source, name, requireResource);
  }
  // report-pdf.js constructs the font names at runtime. Keep its complete
  // vendored runtime and attribution set explicit; this is not a file whitelist.
  if (files.has("report/report-pdf.js")) {
    for (const name of PDF_RESOURCES) requireResource(name, "report/report-pdf.js", { root: true, external: false });
  }
  return manifest;
}

module.exports = { validateArchivePath, isOsJunk, assertSafeFile, validateExtension };
