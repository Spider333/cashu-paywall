// The Lightning / token top-up page. Server-rendered, no framework, one inline script under a CSP nonce.
import { renderSVG } from "uqr";
import type { Ctx } from "../core/context.js";
import { hostOf, topupUrl } from "../core/context.js";
import { base64urlEncode } from "../core/crypto.js";
import { paymentRequest } from "../core/requests.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function qrSvg(data: string): string {
  return renderSVG(data, { border: 2, ecc: "L" });
}

export function pageResponse(ctx: Ctx): Response {
  const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const base = topupUrl(ctx);
  const mint = ctx.mints[0]!;
  const pr = paymentRequest(ctx, ctx.suggestedTopupSats, { description: "Top up an ecash key" });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Top up with ecash</title>
<style nonce="${nonce}">
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem}section{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
input,button{font:inherit;padding:.4rem .6rem}input[type=text],textarea{width:100%;box-sizing:border-box}
textarea{min-height:5rem}code,.mono{font-family:ui-monospace,monospace;word-break:break-all}
.qr{width:220px;height:220px}.small{font-size:.85rem;color:#555}.ok{color:#0a6b2d;font-weight:600}.bad{color:#a40000;font-weight:600}
.key{background:#fff7d6;padding:.5rem;border-radius:6px}
</style></head><body>
<h1>Top up an ecash key</h1>
<p>Price: <b>${ctx.priceSats} sat</b> per paid call. Accepted mint: <code>${esc(mint)}</code>.</p>
<p class="small">Your credit is held as ecash at ${esc(hostOf(mint))} until it is spent; keep balances small. A key is shown once and can't be
recovered: save it. Refund any unused balance as a Cashu token before you lose the key. No accounts, no cookies, no analytics.</p>

<section><h2>Pay with Lightning</h2>
<form id="ln"><label>Amount (sats) <input id="amount" type="number" min="${ctx.limits.minTopupSats}" max="${ctx.limits.maxTopupSats}" value="${ctx.suggestedTopupSats}" required></label>
<button type="submit">Get invoice</button></form>
<div id="lnout" hidden>
<p class="key">Your key (save it; it activates when the invoice is paid):<br><code id="lnkey"></code></p>
<p><a id="lnlink" href="#">Open in a Lightning wallet</a></p>
<p><img id="lnqr" class="qr" alt="Lightning invoice QR code"></p>
<p class="mono small" id="lninv"></p>
<p id="lnstatus">Waiting for payment…</p></div></section>

<section><h2>Paste a Cashu token</h2>
<form id="tok"><textarea id="token" placeholder="cashuB…" required></textarea>
<p class="small">Existing key (optional, to top it up): <input id="existing" type="text" autocomplete="off" placeholder="eck_…"></p>
<button type="submit">Top up</button></form>
<p id="tokout"></p>
<p class="small">Payment request (NUT-18) for wallets that read one; make a token with it and paste it above:</p>
<div class="qr">${qrSvg(pr)}</div>
<p class="mono small">${esc(pr)}</p></section>
<noscript><p>This page needs JavaScript to talk to the server. Without it, use <code>POST ${esc(base)}/topup</code> with an <code>X-Cashu</code> header.</p></noscript>

<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const base = ${JSON.stringify(ctx.basePath)}; // same-origin paths only (CSP connect-src 'self')
  $("ln").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const res = await fetch(base + "/lightning", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_sats: Number($("amount").value) }) });
    const j = await res.json();
    if (!res.ok) { $("lnout").hidden = false; $("lnstatus").textContent = j.error || "Failed"; $("lnstatus").className = "bad"; return; }
    $("lnout").hidden = false;
    $("lnkey").textContent = j.key || "(your existing key)";
    $("lninv").textContent = j.invoice;
    $("lnlink").href = "lightning:" + j.invoice;
    $("lnqr").src = "data:image/svg+xml;base64," + btoa(j.qr_svg);
    const started = Date.now();
    const poll = async () => {
      if (Date.now() - started > 10 * 60 * 1000) { $("lnstatus").textContent = "Expired, start again."; $("lnstatus").className = "bad"; return; }
      try {
        const s = await (await fetch(base + "/lightning/" + j.op_id)).json();
        if (s.state === "CREDITED") { $("lnstatus").textContent = "Credited: " + s.balance_sats + " sats"; $("lnstatus").className = "ok"; return; }
        if (s.state === "EXPIRED") { $("lnstatus").textContent = "Expired, start again."; $("lnstatus").className = "bad"; return; }
      } catch (e) {}
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  });
  $("tok").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const headers = { "Content-Type": "application/json" };
    const k = $("existing").value.trim();
    if (k) headers["Authorization"] = "Bearer " + k;
    const res = await fetch(base + "/topup", { method: "POST", headers, body: JSON.stringify({ token: $("token").value.trim() }) });
    const j = await res.json();
    $("tokout").className = res.ok ? "ok" : "bad";
    $("tokout").textContent = res.ok
      ? (j.key ? "New key (save it now, shown once): " + j.key + ". " : "") + "Credited " + j.credited_sats + " sats; balance " + j.balance_sats + " sats."
      : (j.error || "Failed");
  });
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
