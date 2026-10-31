/**
 * Full smoke + layout + envelope flow tests.
 * Run: npm install puppeteer-core@23 --no-save && node test-full.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdir } from "fs/promises";
import path from "path";

const BASE = "http://127.0.0.1:8080";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const OUT = path.join(process.cwd(), "test-screenshots");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const viewports = [
  { w: 320, h: 568, name: "iphone-se" },
  { w: 390, h: 844, name: "iphone-14" },
  { w: 412, h: 915, name: "pixel-7" },
];

function overlaps(a, b, gap = 6) {
  if (!a || !b) return false;
  return !(a.right <= b.left + gap || a.left >= b.right - gap || a.bottom <= b.top + gap || a.top >= b.bottom - gap);
}

async function auditSlide(page) {
  return page.evaluate(() => {
    const slide = document.querySelector(".slide.active");
    const doc = document.documentElement;
    const horiz = Math.max(document.body.scrollWidth, doc.scrollWidth) - window.innerWidth;
    const pick = (sel) => {
      const el = slide?.querySelector(sel) || document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return null;
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
    };
    return {
      horiz,
      vh: window.innerHeight,
      hash: location.hash,
      rects: {
        card: pick(".card"),
        dots: pick(".dots") || (() => {
          const d = document.querySelector(".dots");
          if (!d) return null;
          const r = d.getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
        })(),
        hint: pick("#env-hint"),
        photo: pick("#photo-card.photo-card--revealed"),
        envelope: pick(".envelope-wrap"),
        seal: pick("#seal"),
      },
      cfgMonogram: document.getElementById("seal-letter")?.textContent?.includes("H"),
    };
  });
}

async function testEnvelopeFlow(page, vpName) {
  const issues = [];
  await page.goto(`${BASE}/#0`, { waitUntil: "networkidle0" });
  await delay(400);

  let state = await page.evaluate(() => ({
    sealVisible: !!document.querySelector("#seal") && getComputedStyle(document.querySelector("#seal")).opacity !== "0",
    wrapVisible: getComputedStyle(document.querySelector(".envelope-wrap")).opacity,
    photoRevealed: document.querySelector("#photo-card")?.classList.contains("photo-card--revealed"),
    coupleImg: document.getElementById("couple-photo")?.complete && document.getElementById("couple-photo")?.naturalWidth > 0,
  }));

  if (!state.coupleImg) issues.push("couple image failed to load");
  if (state.photoRevealed) issues.push("photo should not be revealed initially");
  if (parseFloat(state.wrapVisible) < 0.9) issues.push("envelope should be visible initially");

  await page.evaluate(() => document.getElementById("seal")?.click());
  await delay(1500);

  state = await page.evaluate(() => ({
    sealBroken: document.getElementById("envelope-scene")?.classList.contains("is-open"),
    photoRevealed: document.querySelector("#photo-card")?.classList.contains("photo-card--revealed"),
    wrapOpacity: parseFloat(getComputedStyle(document.querySelector(".envelope-wrap")).opacity),
    wrapHeight: document.querySelector(".envelope-wrap").getBoundingClientRect().height,
    caption: document.getElementById("photo-caption")?.textContent,
    captionOneLine: getComputedStyle(document.getElementById("photo-caption")).whiteSpace === "nowrap",
    monogram: document.querySelector(".seal-h")?.textContent + document.querySelector(".seal-amp")?.textContent + document.querySelector(".seal-s")?.textContent,
  }));

  if (!state.sealBroken) issues.push("envelope did not open on seal click");
  if (!state.photoRevealed) issues.push("photo not revealed after seal click");
  if (state.wrapOpacity > 0.15 && state.wrapHeight > 20) issues.push("envelope wrap should hide after open");
  if (!state.caption?.includes("Hammad")) issues.push("caption missing couple name");
  if (!state.captionOneLine) issues.push("caption should be nowrap");

  await page.evaluate(() => document.getElementById("btn-env-continue")?.click());
  await delay(500);

  const onSlide1 = await page.evaluate(() => document.querySelector("#slide-1")?.classList.contains("active"));
  if (!onSlide1) issues.push("Continue did not go to slide 1");

  await page.goto(`${BASE}/#2`, { waitUntil: "networkidle0" });
  await delay(200);
  const walima = await page.evaluate(() => ({
    time: document.getElementById("walima-time")?.textContent,
    venue: document.getElementById("walima-venue")?.textContent,
  }));
  if (!walima.time?.includes("12:00")) issues.push("walima time wrong");
  if (!walima.venue?.includes("Gujar")) issues.push("walima venue wrong");

  await page.goto(`${BASE}/#3`, { waitUntil: "networkidle0" });
  await delay(1100);
  const countdown = await page.evaluate(() => document.getElementById("cd-days")?.textContent);
  if (countdown == null) issues.push("countdown missing");

  return { vpName, issues };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  let failed = 0;
  await mkdir(OUT, { recursive: true });

  for (const vp of viewports) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 2 });

    const flow = await testEnvelopeFlow(page, vp.name);
    if (flow.issues.length) {
      failed += flow.issues.length;
      console.error("FAIL flow", vp.name, flow.issues.join("; "));
    } else {
      console.log("PASS flow", vp.name);
    }

    for (const hash of ["0", "1", "2", "3"]) {
      await page.goto(`${BASE}/#${hash}`, { waitUntil: "networkidle0" });
      await delay(300);
      if (hash === "0") {
        await page.evaluate(() => {
          const scene = document.getElementById("envelope-scene");
          scene?.classList.add("is-open", "is-revealed");
          document.getElementById("photo-card")?.classList.add("photo-card--revealed");
        });
        await delay(100);
      }
      await page.evaluate(() => {
        const s = document.querySelector(".slide.active");
        if (s) s.scrollTop = s.scrollHeight;
      });
      const audit = await auditSlide(page);
      const issues = [];
      if (audit.horiz > 2) issues.push(`horizontal overflow ${audit.horiz}px`);
      const dots = audit.rects.dots;
      const card = audit.rects.card;
      const hint = audit.rects.hint;
      if (dots && card && overlaps(card, dots)) issues.push("card overlaps dots");
      if (dots && hint && overlaps(hint, dots)) issues.push("hint overlaps dots");

      const shot = path.join(OUT, `${vp.name}-slide${hash}.png`);
      await page.screenshot({ path: shot, fullPage: false });

      if (issues.length) {
        failed += issues.length;
        console.error("FAIL layout", `${vp.name} #${hash}`, issues.join("; "));
      } else {
        console.log("PASS layout", `${vp.name} #${hash}`);
      }
    }
    await page.close();
  }

  await browser.close();
  console.log(failed ? `\n${failed} issue(s) found` : "\nAll tests passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
