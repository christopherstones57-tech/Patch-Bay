# What this repository does, and what it does not

Someone scanning this repository may have flagged it. This page is the answer to
that, written so it can be checked line by line rather than taken on trust.

Patch Bay is a static website: HTML, CSS and JavaScript, served by GitHub Pages
straight from this branch. There is no build step, no server, no database, no
backend of any kind, and no executable file in the repository — no `.exe`,
`.dmg`, `.msi`, `.jar`, `.zip` or installer. Nothing here ever runs on a visitor's
computer as a program; it runs inside the browser tab, in the browser's sandbox,
with the permissions the browser gives any web page.

## The only network requests the page makes

Static files from this GitHub Pages site (`index.html`, `css/app.css`, the `js/`
files, `manifest.json`).

And, once per visit, the visitor counter in the title row:

| What | Where |
| --- | --- |
| Add one to the visit count | `GET https://abacus.jasoncameron.dev/hit/patch-bay-fm3w/views` |
| Add or read the visitor count | `GET https://abacus.jasoncameron.dev/hit/patch-bay-fm3w/users` or `/get/...` |

That is all of it — see `js/counter.js`, which does nothing else. Abacus is a
free public counter service; the request carries no data beyond the URL itself,
and the service stores two integers. The page keeps two values in the browser's
own `localStorage` (`patchbay.seen.v1`, `patchbay.count.v1`) so it can show the
last numbers it saw. Nothing about the visitor — no name, no fingerprint, no
recording, no file — is sent anywhere.

There are no remote scripts, no fonts or images loaded from another host, no
iframes, no `document.write`, no `eval`, no `new Function`, no `unescape`, no
cookies, no service worker, no `indexedDB`, no analytics, no ads, no affiliate
tags, and no redirects.

## The microphone

`navigator.mediaDevices.getUserMedia({ audio: true })` is called only when the
player presses **Mic**, **Rec sample** or the lyric channel themselves, and the
browser shows its own permission prompt first. The audio captured is held in
memory as an `AudioBuffer`, played back, and written into the exported WAV/FLAC/
OGG/song file on the visitor's own device. It is never uploaded — the page has no
API to upload it to.

## Files the page writes

Exports (`WAV`, `FLAC`, `OGG`, `Song file`) are built in the browser and handed to
the browser's normal download mechanism (`js/export.js`). They land where the
visitor's downloads go, like any downloaded file.

## The three minified files in `js/lib/`

`flac-decoder.min.js`, `ogg-opus-decoder.min.js` and `ogg-vorbis-decoder.min.js`
are the most likely reason for a "trojan" reading. They are third-party,
unmodified builds of **wasm-audio-decoders** by Ethan Halsall, MIT licensed:

- Source: <https://github.com/eshaz/wasm-audio-decoders>
- Packages: <https://www.npmjs.com/package/ogg-vorbis-decoder>,
  <https://www.npmjs.com/package/ogg-opus-decoder>,
  <https://www.npmjs.com/package/flac-decoder>

Patch Bay bundles them because iOS Safari before 18.4 cannot decode Ogg at all
and other browsers are patchy about Ogg and FLAC — see the comment at the top of
`js/decode-audio.js`. Each bundle is minified and carries its WebAssembly code
embedded as a string of bytes, which is why the files look dense, machine-made,
and contain non-ASCII characters. Minified bundles with embedded binary payloads
are a well-known false positive for heuristic scanners: no human wrote them, and
they pattern-match the shapes scanners look for.

They can be verified without trusting this page: fetch the same version from
npm or unpkg and compare, or simply delete all three — the app keeps working and
falls back to the browser's own decoder, losing only guaranteed Ogg/FLAC support
in Safari.

## How to check all of this in a minute

1. Open the site, open the browser's developer tools, and watch the **Network**
   tab while using it: the only third-party request is the counter.
2. Search the source for `http` — every hit is a comment, an SVG namespace, a
   link on the promo pages, or the counter's address.
3. There is no `package.json`, no dependency install, and no workflow that runs
   anything: `.github/workflows/` is empty, and publishing is GitHub Pages
   building the branch as static files (`.nojekyll`).

If a scanner still reports something, the report will name a file and a rule —
that is what to look at, and this page says what each file is for.
