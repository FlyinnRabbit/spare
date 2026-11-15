/* Spare — bank statement import for European banks.
   Reads CSV/TXT (any delimiter, header or not, EU number & date formats), CAMT.053 XML (ISO 20022),
   OFX/QFX, and Excel (converted to CSV by the app with SheetJS).
   Exposes window.SpareBank = { parse(text, opts), parseWithMapping(text, mapping), guess(desc), clean(desc), sample(text) } */
(function (G) {
  "use strict";
  const strip = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

  /* ---------- column keywords (normalised: lowercase, no accents) ---------- */
  const K = {
    date: ["date d'execution", "date de comptabilisation", "date comptable", "date operation", "date de l'operation", "date de transaction", "boekingsdatum", "boekdatum", "uitvoeringsdatum", "verrichtingsdatum", "transactiedatum", "buchungstag", "buchungsdatum", "booking date", "transaction date", "completed date", "started date", "data contabile", "data operazione", "fecha operacion", "fecha", "datum", "date", "data", "dateop", "date valeur", "valutadatum", "value date", "data valuta", "wertstellung"],
    amount: ["montant de l'operation", "montant", "bedrag (eur)", "bedrag", "amount (eur)", "amount", "betrag", "importe", "importo", "valor", "kwota", "belopp", "beløb", "summe", "net", "gross", "umsatz"],
    debit: ["debit euros", "debit", "debet", "uitgaven", "soll", "ausgang", "cargo", "addebiti", "addebito", "money out", "paid out", "withdrawal", "af"],
    credit: ["credit euros", "credit", "inkomsten", "haben", "eingang", "abono", "accrediti", "accredito", "money in", "paid in", "deposit", "bij"],
    sign: ["af bij", "af/bij", "debit/credit", "credit/debit", "d/c", "cd", "sens", "soll/haben"],
    party: ["nom de la contrepartie", "nom contrepartie contient", "nom contrepartie", "naam tegenpartij bevat", "naam tegenpartij", "naam / omschrijving", "counterparty name", "counterparty", "payee", "merchant", "beguenstigter/zahlungspflichtiger", "beguenstigter", "begunstigter", "zahlungspflichtiger", "empfanger", "auftraggeber", "beneficiaire", "begunstigde", "beneficiary", "supplierfound", "name", "naam", "nom", "contrepartie", "tegenpartij"],
    desc: ["libelle", "libelles", "label", "omschrijving", "omschrijving-1", "description", "beschrijving", "details du mouvement", "details", "detail de l'ecriture", "mededelingen", "mededeling", "communications", "communication", "message", "verwendungszweck", "buchungstext", "concepto", "descrizione", "causale", "descricao", "transaction", "transactie", "memo", "text", "reference"],
  };
  const EXCLUDE = {
    all: ["solde", "saldo", "balance", "kontostand", "iban", "bic", "swift", "nummer", "number", "numero", "nr", "n°", "no.", "rekening", "compte", "account", "konto", "postcode", "code postal", "straat", "rue", "street", "landcode", "pays", "country", "devise", "munt", "currency", "wahrung", "waehrung", "divisa", "moneda", "fee", "frais", "kosten", "exchange", "taux", "foreign", "status", "statut", "state", "categor"],
    amount: ["date", "datum", "fecha", "data "],
    desc: ["type", "soort", "art", "tipo"],
  };
  const excluded = (h, role) => [...EXCLUDE.all, ...(EXCLUDE[role] || [])].some((x) => (x.length <= 3 ? h.split(/[^a-z0-9°.]+/).includes(x) : h.includes(x)));

  function scoreHeader(h, role) {
    const list = K[role];
    let best = 0;
    for (let i = 0; i < list.length; i++) {
      const kw = list[i];
      let sc = 0;
      if (h === kw) sc = 1000 - i * 3;
      else if (kw.length > 3 && (h.startsWith(kw) || h.includes(kw))) sc = 500 - i * 3;
      if (sc > best) best = sc;
    }
    if (best && role !== "sign" && excluded(h, role)) {
      // "date valeur" contains no excluded word; but "Rekening tegenpartij" (an account number) does → drop
      if (!(role === "party" && /naam|nom|name/.test(h))) best = 0;
    }
    return best;
  }

  /* ---------- low-level parsing ---------- */
  function splitCSV(text, d) {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell.trim() === "") { q = true; cell = ""; }
      else if (c === d) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ""));
  }
  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 40);
    let best = ",", bestScore = -1;
    for (const d of [";", ",", "\t", "|"]) {
      const counts = splitCSV(lines.join("\n"), d).map((r) => r.length);
      const freq = {}; counts.forEach((c) => { if (c >= 3) freq[c] = (freq[c] || 0) + 1; });
      const [cols, n] = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [0, 0];
      const score = n * 10 + Math.min(+cols, 15);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function parseAmount(raw, commaDecimal) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[\s  ']/g, "").replace(/(EUR|CHF|GBP|USD|PLN|SEK|DKK|NOK|CZK|HUF|RON|€|\$|£)/gi, "");
    if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (/^\+/.test(s)) s = s.slice(1);
    if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
    const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
    if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (lc > -1) s = /,\d{1,2}$/.test(s) || (commaDecimal && /,\d+$/.test(s) && s.split(",").length === 2) ? s.replace(",", ".") : s.replace(/,/g, "");
    else if (ld > -1 && commaDecimal && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const v = parseFloat(s);
    return neg ? -v : v;
  }

  function dateParts(raw) {
    const s = String(raw || "").trim();
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return { y: +m[1], a: +m[2], b: +m[3], ymd: true };
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/))) return { y: +m[1], a: +m[2], b: +m[3], ymd: true };
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\D|$)/))) return { y: m[3].length === 2 ? 2000 + +m[3] : +m[3], a: +m[1], b: +m[2], ymd: false };
    return null;
  }
  function toISO(p, mdy) {
    if (!p) return null;
    let y = p.y, mo, d;
    if (p.ymd) { mo = p.a; d = p.b; } else if (mdy) { mo = p.a; d = p.b; } else { d = p.a; mo = p.b; }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  /* ---------- merchant clean-up & category guess ---------- */
  const NOISE = [
    /\b(aankoop|betaling|achat|paiement|payment|kartenzahlung|compra|pagamento|zahlung)\b.{0,40}?\b(bancontact|maestro|debetkaart|debitkaart|carte|card|kaart|visa|mastercard|contactless|sans contact|girocard|debit)\b/gi,
    /\b(bancontact|maestro|visa debit|mastercard|contactless|sans contact|apple pay|google pay|payconiq)\b/gi,
    /\b(met kaart|avec la carte|with card|mit karte|kaart nr|carte n[°o]?)\s*[\dx* ]{4,}/gi,
    /\b\d{4}[ x*]{1,3}[x*]{4}[ x*]{1,3}[x*]{4}[ x*]{1,3}\d{4}\b/gi,
    /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, // IBAN
    /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, /\b(om|à|a|at|um)\s*\d{1,2}[.:h]\d{2}(\s*uur)?\b/gi, /\b\d{1,2}[.:]\d{2}\b/g,
    /\b(uitvoeringsdatum|valutadatum|date valeur|date d'execution|ref(erence)?|referentie|réf)\b[:\s]*\S*/gi,
    /\b(domiciliering|domiciliation|lastschrift|sepa)\b/gi,
  ];
  function clean(desc) {
    let s = String(desc || "");
    for (const r of NOISE) s = s.replace(r, " ");
    s = s.replace(/\s{2,}/g, " ").replace(/^[\s\-–:/,.]+|[\s\-–:/,.]+$/g, "").trim();
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }
  const BRANDS = [
    ["cat", ["zooplus", "tom&co", "tom & co", "maxi zoo", "maxizoo", "fressnapf", "zoomalia", "animalis", "jumbo pets", "pets place", "dierenspeciaal", "medpets", "bitiba"]],
    ["groceries", ["colruyt", "okay ", "bio-planet", "delhaize", "ad delhaize", "aldi", "lidl", "carrefour", "albert heijn", "intermarche", "spar ", "cora ", "match ", "smatch", "jumbo", "proxy", "rewe", "edeka", "kaufland", "penny", "netto", "auchan", "leclerc", "monoprix", "franprix", "casino", "mercadona", "dia ", "coop", "migros", "esselunga", "conad", "picnic", "crf ", "louis delhaize", "aldi süd", "aldi nord", "plus ", "dirk", "hoogvliet", "biedronka", "tesco", "sainsbury", "asda"]],
    ["household", ["action", "hema", "ikea", "brico", "gamma", "hubo", "leroy merlin", "blokker", "wibra", "casa ", "maisons du monde", "obi ", "bauhaus", "hornbach", "xenos"]],
    ["hygiene", ["kruidvat", "ici paris", "douglas", "rossmann", "dm-drogerie", "dm drogerie", "etos", "trekpleister", "pharmacie", "apotheek", "farmacia", "apotheke", "multipharma", "di "]],
    ["eatout", ["restaurant", "resto", "deliveroo", "uber eats", "ubereats", "takeaway", "just eat", "thuisbezorgd", "lieferando", "mcdonald", "mc donald", "burger king", "quick ", "kfc", "domino", "pizza", "sushi", "exki", "starbucks", "panos", "brasserie", "frituur", "friterie", "snack", "kebab", "cafe", "café", "bistro", "tavern"]],
    ["clothing", ["zalando", "h&m", "h & m", "zara", "primark", "c&a", "jbc", "uniqlo", "vinted", "shein", "kiabi", "bershka", "pull&bear", "zeeman", "e5 mode", "about you", "asos"]],
    ["tech", ["amazon prime", "coolblue", "mediamarkt", "media markt", "fnac", "vanden borre", "krefel", "apple.com", "apple ", "google ", "microsoft", "steam", "playstation", "nintendo", "xbox", "netflix", "spotify", "disney", "tidal", "anthropic", "claude.ai", "discord", "cloudflare", "openai", "youtube", "dazn", "proximus", "telenet", "orange", "base ", "scarlet", "mobile vikings"]],
    ["leisure", ["kinepolis", "ugc", "cinema", "decathlon", "ticketmaster", "fitness", "basic-fit", "basic fit", "jims", "bowling", "museum", "musee", "pathé", "pathe", "theatre", "concert"]],
    ["drinks", ["drankencenter", "drinks", "nicolas ", "vins ", "wijn", "brewery", "brasserie de"]],
  ];
  function guess(desc) {
    const s = " " + strip(desc) + " ";
    for (const [cat, list] of BRANDS) for (const b of list) if (s.includes(" " + strip(b)) || s.includes(strip(b) + " ")) return { cat, brand: b.trim() };
    return { cat: "other", brand: null };
  }
  const TRANSFER = /\b(epargne|spaar|spaarrekening|savings|sparen|sparkonto|virement interne|interne overschrijving|eigen rekening|propre compte|own account|vers votre compte|naar uw|tagesgeld|livret)\b/;
  const CASH = /\b(retrait|geldopname|cash withdrawal|abhebung|bargeld|atm|distributeur|geldautomaat|bancontact cash|prelevement especes)\b/;

  /* ---------- structured formats ---------- */
  const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`)); return m ? m[1] : null; };
  const tags = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>[\\s\\S]*?</(?:\\w+:)?${name}>`, "g")) || [];
  const unxml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, " ").trim();

  function parseCAMT(xml) {
    const rows = [];
    for (const e of tags(xml, "Ntry")) {
      const amt = parseFloat(unxml(tag(e, "Amt")));
      const ind = unxml(tag(e, "CdtDbtInd"));
      const bd = tag(e, "BookgDt") || tag(e, "ValDt") || "";
      const date = unxml(tag(bd, "Dt") || tag(bd, "DtTm") || "").slice(0, 10);
      const debit = ind === "DBIT";
      const party = unxml(tag(tag(e, debit ? "Cdtr" : "Dbtr") || "", "Nm") || "");
      const ustrd = tags(e, "Ustrd").map(unxml).join(" ");
      const info = unxml(tag(e, "AddtlNtryInf") || tag(e, "AddtlTxInf") || "");
      if (!isNaN(amt) && date) rows.push({ date, amount: debit ? -amt : amt, party, desc: [ustrd, info].filter(Boolean).join(" ") });
    }
    return rows;
  }
  function parseOFX(text) {
    const rows = [];
    const blocks = text.split(/<STMTTRN>/i).slice(1);
    const f = (b, n) => { const m = b.match(new RegExp(`<${n}>([^<\\r\\n]*)`, "i")); return m ? m[1].trim() : ""; };
    for (const b of blocks) {
      const amt = parseAmount(f(b, "TRNAMT"), false);
      const d = f(b, "DTPOSTED");
      const date = d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
      if (amt != null && date) rows.push({ date, amount: amt, party: unxml(f(b, "NAME")), desc: unxml(f(b, "MEMO")) });
    }
    return rows;
  }

  /* ---------- CSV ---------- */
  function analyse(text) {
    const delim = detectDelimiter(text);
    const rows = splitCSV(text, delim);
    const width = (() => { const f = {}; rows.forEach((r) => { if (r.length >= 3) f[r.length] = (f[r.length] || 0) + 1; }); return +(Object.entries(f).sort((a, b) => b[1] - a[1])[0] || [0])[0]; })();
    // header = the row (in the first 30) whose cells best match our keywords
    let headerRow = -1, best = 0;
    rows.slice(0, 30).forEach((r, i) => {
      const hs = r.map(strip);
      const sc = ["date", "amount", "debit", "credit", "party", "desc"].reduce((a, role) => a + (hs.some((h) => scoreHeader(h, role) > 0) ? 1 : 0), 0);
      if (sc > best && r.length >= 3) { best = sc; headerRow = i; }
    });
    if (best < 2) headerRow = -1;
    return { delim, rows, width, headerRow };
  }

  function pickColumns(headers, data) {
    const hs = headers.map(strip), used = new Set(), cols = {};
    const pick = (role, valueTest) => {
      let bi = -1, bs = 0;
      hs.forEach((h, i) => { if (used.has(i)) return; const s = scoreHeader(h, role); if (s > bs && (!valueTest || valueTest(i))) { bs = s; bi = i; } });
      if (bi >= 0) { used.add(bi); cols[role] = bi; }
    };
    const share = (i, fn) => { const v = data.map((r) => r[i]).filter((x) => x != null && String(x).trim() !== ""); return v.length ? v.filter(fn).length / v.length : 0; };
    const isDate = (i) => share(i, (x) => !!dateParts(x)) > 0.7;
    const isNum = (i) => share(i, (x) => parseAmount(x, true) != null) > 0.6;
    const isText = (i) => share(i, (x) => /[a-z]{3}/i.test(x) && !/^[A-Z]{2}\d{2}[A-Z0-9 ]{8,}$/.test(String(x).trim())) > 0.5;
    const constant = (i) => { const v = data.map((r) => strip(r[i])).filter(Boolean); return v.length >= 3 && v.filter((x) => x === v[0]).length / v.length > 0.9; };
    pick("date", isDate);
    pick("amount", isNum);
    if (cols.amount == null) { pick("debit", (i) => share(i, (x) => parseAmount(x, true) != null) > 0.05); pick("credit", (i) => share(i, (x) => parseAmount(x, true) != null) > 0.05); }
    pick("sign", (i) => share(i, (x) => /^(af|bij|d|c|debit|credit|dbit|crdt|s|h|soll|haben|-|\+)$/i.test(String(x).trim())) > 0.8);
    cols.desc = [];
    for (const role of ["party", "desc"]) {
      hs.map((h, i) => [i, scoreHeader(h, role)]).filter(([i, s]) => s > 0 && !used.has(i) && isText(i) && !constant(i)).sort((a, b) => b[1] - a[1]).forEach(([i]) => { used.add(i); cols.desc.push(i); });
    }
    // headerless or unmatched: fall back on the data itself
    if (cols.date == null) { const i = headers.findIndex((_, i) => !used.has(i) && isDate(i)); if (i >= 0) { cols.date = i; used.add(i); } }
    if (cols.amount == null && cols.debit == null) {
      const cands = headers.map((_, i) => i).filter((i) => !used.has(i) && isNum(i) && share(i, (x) => /[.,]\d{2}\b/.test(x)) > 0.5);
      if (cands.length) { cols.amount = cands[0]; used.add(cands[0]); }
    }
    if (!cols.desc.length) {
      const t = headers.map((_, i) => i).filter((i) => !used.has(i) && isText(i)).sort((a, b) => avgLen(data, b) - avgLen(data, a));
      if (t.length) cols.desc.push(t[0]);
    }
    return cols;
  }
  const avgLen = (data, i) => data.reduce((a, r) => a + String(r[i] || "").length, 0) / Math.max(1, data.length);

  function rowsFromCSV(text, mapping) {
    const a = analyse(text);
    const delim = mapping && mapping.delimiter ? mapping.delimiter : a.delim;
    const rows = mapping && mapping.delimiter ? splitCSV(text, delim) : a.rows;
    const hr = mapping && mapping.headerRow != null ? mapping.headerRow : a.headerRow;
    const headers = hr >= 0 ? rows[hr] : rows.find((r) => r.length === a.width) || [];
    const data = rows.slice(hr + 1).filter((r) => r.length >= Math.min(3, headers.length));
    const cols = mapping && mapping.columns ? mapping.columns : pickColumns(headers, data.slice(0, 60));
    if (cols.date == null || (cols.amount == null && cols.debit == null && cols.credit == null)) return { ok: false, headers, delim, cols };
    const commaDecimal = [cols.amount, cols.debit, cols.credit].filter((i) => i != null).some((i) => data.some((r) => /,\d{1,2}$/.test(String(r[i] || "").trim())));
    const parts = data.map((r) => dateParts(r[cols.date])).filter(Boolean);
    const mdy = !parts.some((p) => !p.ymd && p.a > 12) && parts.some((p) => !p.ymd && p.b > 12);
    const out = [];
    for (const r of data) {
      const date = toISO(dateParts(r[cols.date]), mdy);
      if (!date) continue;
      let amount;
      if (cols.amount != null) amount = parseAmount(r[cols.amount], commaDecimal);
      else {
        const d = cols.debit != null ? parseAmount(r[cols.debit], commaDecimal) : null;
        const c = cols.credit != null ? parseAmount(r[cols.credit], commaDecimal) : null;
        amount = d ? -Math.abs(d) : c ? Math.abs(c) : null;
      }
      if (amount == null) continue;
      if (cols.sign != null) {
        const s = strip(r[cols.sign]);
        if (/^(af|d|debit|dbit|s|soll|-)$/.test(s)) amount = -Math.abs(amount);
        else if (/^(bij|c|credit|crdt|h|haben|\+)$/.test(s)) amount = Math.abs(amount);
      }
      const texts = cols.desc.map((i) => r[i]).filter((x) => x && x.trim());
      const u = [...new Set(texts)];
      out.push({ date, amount, party: u[0] || "", desc: u.slice(1).join(" · ") });
    }
    return { ok: out.length > 0, rows: out, headers, delim, cols };
  }

  /* ---------- public ---------- */
  function finish(rows, format) {
    return rows.map((r) => {
      const full = [r.party, r.desc].filter(Boolean).join(" · ");
      const g = guess(full);
      const label = g.brand ? g.brand.replace(/\b\w/g, (c) => c.toUpperCase()) : clean(r.party || r.desc) || clean(full) || "—";
      const s = strip(full);
      return { date: r.date, amount: Math.round(r.amount * 100) / 100, label, desc: full.slice(0, 200), cat: g.cat, transfer: TRANSFER.test(s), cash: CASH.test(s) };
    }).sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  function parse(text) {
    const t = String(text || "").replace(/^﻿/, "");
    if (/<(\w+:)?BkToCstmrStmt\b|<(\w+:)?Ntry\b/.test(t)) return { ok: true, format: "CAMT.053", rows: finish(parseCAMT(t)) };
    if (/<OFX>|<STMTTRN>/i.test(t)) return { ok: true, format: "OFX", rows: finish(parseOFX(t)) };
    const r = rowsFromCSV(t);
    return { ok: r.ok, format: "CSV", rows: r.ok ? finish(r.rows) : [], headers: r.headers, delim: r.delim, cols: r.cols };
  }
  function parseWithMapping(text, mapping) {
    const r = rowsFromCSV(String(text || "").replace(/^﻿/, ""), mapping);
    return { ok: r.ok, format: "CSV", rows: r.ok ? finish(r.rows) : [] };
  }
  const sample = (text) => String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 25).map((l, i) => `${i}: ${l.slice(0, 300)}`).join("\n");

  G.SpareBank = { parse, parseWithMapping, guess, clean, sample, _t: { parseAmount, dateParts, toISO, detectDelimiter, strip } };
})(typeof window !== "undefined" ? window : globalThis);
