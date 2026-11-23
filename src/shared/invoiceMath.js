// invoiceMath.js — десятичные числа и проверки сумм счёта (задача #8).
//
// Один и тот же файл работает в трёх местах:
//  - главный процесс: разбор PDF (src/shared/invoiceParser.js);
//  - окно приложения: живые предупреждения, пока оператор правит распознанное
//    (подключается тегом <script>, глобальный объект InvoiceMath);
//  - процесс, владеющий базой (в т. ч. выделенный сервер): проверка перед записью.
// Поэтому — без зависимостей и в стиле UMD.
//
// Деньги в float не считаем: 0,1 + 0,2 ≠ 0,3, а сравниваем мы именно равенство сумм.
// Числа хранятся каноническими строками ("1234.50", "-3", "0.125") — точно так, как
// в документе, только с точкой и без разделителей разрядов; арифметика — на BigInt с
// фиксированным масштабом.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvoiceMath = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const SCALE = 6;                 // знаков после запятой во внутреннем представлении
  const ONE = 10n ** BigInt(SCALE);
  const CANONICAL = /^-?(0|[1-9]\d{0,14})(\.\d{1,6})?$/;

  /**
   * Число из текста документа или поля ввода → каноническая строка, либо null.
   * Понимает «1 234,56», «1234.56», «1,234.56», «1 234 567», « -3,5 », «1 959 083,75 руб.»,
   * неразрывные и узкие пробелы как разделители разрядов. Буквы (кроме обозначения
   * валюты в конце) — не число: «12 мес» числом не считается.
   */
  function parseDecimal(input) {
    if (input === null || input === undefined) return null;
    let s = String(input).trim();
    if (!s) return null;
    s = s.replace(/\s*(руб\.?|р\.|₽|rub|usd|eur|\$|€)$/i, '').trim();
    s = s.replace(/[    ']/g, '');
    s = s.replace(/^−/, '-');               // типографский минус
    if (!/^-?[\d.,]+$/.test(s)) return null;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    let intPart;
    let frac = '';
    if (lastComma >= 0 && lastDot >= 0) {
      // оба знака есть: последний — десятичный, первый — разделитель разрядов
      const dec = Math.max(lastComma, lastDot);
      const thousands = dec === lastComma ? '.' : ',';
      intPart = s.slice(0, dec).split(thousands).join('');
      frac = s.slice(dec + 1);
      if (/[.,]/.test(intPart) || /[.,]/.test(frac)) return null;
    } else {
      const sep = lastComma >= 0 ? ',' : (lastDot >= 0 ? '.' : null);
      if (sep) {
        const parts = s.split(sep);
        if (parts.length > 2) {
          // «1.234.567» — разделители разрядов, дробной части нет
          if (!parts.slice(1).every((p) => p.length === 3)) return null;
          intPart = parts.join('');
        } else {
          [intPart, frac] = parts;
        }
      } else {
        intPart = s;
      }
    }
    const neg = intPart.startsWith('-');
    intPart = intPart.replace(/^-/, '');
    if (!/^\d+$/.test(intPart || '0') || (frac && !/^\d+$/.test(frac))) return null;
    if (frac.length > SCALE) return null;
    intPart = intPart.replace(/^0+(?=\d)/, '') || '0';
    const out = `${neg ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
    if (!CANONICAL.test(out)) return null;
    return out === '-0' ? '0' : out;
  }

  function isCanonical(s) { return typeof s === 'string' && CANONICAL.test(s); }

  function toScaled(s) {
    if (!isCanonical(s)) throw new Error(`Некорректное число: ${s}`);
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace('-', '').split('.');
    const v = BigInt(i) * ONE + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE));
    return neg ? -v : v;
  }

  function fromScaled(v, places) {
    const neg = v < 0n;
    let a = neg ? -v : v;
    let p = places;
    if (p === undefined) {
      // без лишних нулей, но не меньше 2 знаков, если дробная часть есть
      const frac = (a % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
      p = frac ? Math.max(2, frac.length) : 0;
    } else {
      // округление половина — от нуля
      const unit = 10n ** BigInt(SCALE - p);
      a = ((a + unit / 2n) / unit) * unit;
    }
    const i = a / ONE;
    const f = (a % ONE).toString().padStart(SCALE, '0').slice(0, p);
    const out = `${neg && a !== 0n ? '-' : ''}${i}${p ? `.${f}` : ''}`;
    return out;
  }

  const add = (a, b) => fromScaled(toScaled(a) + toScaled(b));
  const sub = (a, b) => fromScaled(toScaled(a) - toScaled(b));
  function mul(a, b) {
    const p = toScaled(a) * toScaled(b);           // масштаб 2×SCALE
    const neg = p < 0n;
    const abs = neg ? -p : p;
    const v = (abs + ONE / 2n) / ONE;              // обратно к SCALE, половина — от нуля
    return fromScaled(neg ? -v : v);
  }
  const round2 = (a) => fromScaled(toScaled(a), 2);
  const eqMoney = (a, b) => toScaled(round2(a)) === toScaled(round2(b));
  const sum = (list) => fromScaled(list.reduce((s, x) => s + toScaled(x), 0n));

  /** «1 234 567,5» — как пишут в русских документах; дробных знаков ровно столько,
   *  сколько в самом числе. */
  function formatRu(s) {
    if (!isCanonical(s)) return s == null ? '' : String(s);
    const neg = s.startsWith('-');
    const [i, f] = s.replace('-', '').split('.');
    const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${neg ? '−' : ''}${grouped}${f ? `,${f}` : ''}`;
  }

  // --- ИНН/КПП ---
  function innValid(inn) {
    if (typeof inn !== 'string' || !/^(\d{10}|\d{12})$/.test(inn)) return false;
    const d = inn.split('').map(Number);
    const ctl = (w, n) => (w.reduce((s, k, idx) => s + k * d[idx], 0) % 11) % 10 === d[n];
    if (inn.length === 10) return ctl([2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
    return ctl([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && ctl([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
  }
  const kppValid = (kpp) => typeof kpp === 'string' && /^\d{4}[\dA-Z]{2}\d{3}$/.test(kpp);

  /**
   * Предупреждения о расхождениях. Ничего не исправляет и не «угадывает» — только
   * сообщает, что не сходится, чтобы оператор проверил и поправил сам.
   * inv: { items: [{ quantity, price, amount, vat_amount }], total_amount, vat_amount,
   *        amount_due, items_declared, supplier_inn, buyer_inn }
   * → [{ code, message, index? }]
   */
  function validateInvoice(inv) {
    const out = [];
    const items = Array.isArray(inv.items) ? inv.items : [];
    const ok = (x) => isCanonical(x);

    items.forEach((it, idx) => {
      if (!ok(it.quantity) || !ok(it.price) || !ok(it.amount)) return;
      const base = mul(it.quantity, it.price);
      // Цена бывает без НДС, а сумма строки — с НДС: тогда сходится «кол-во × цена + НДС»
      const matches = eqMoney(base, it.amount) || (ok(it.vat_amount) && eqMoney(add(base, it.vat_amount), it.amount));
      if (!matches) {
        out.push({ code: 'line_amount', index: idx,
          message: `Строка ${idx + 1}: ${formatRu(it.quantity)} × ${formatRu(it.price)} = ${formatRu(round2(base))}, а в сумме строки ${formatRu(it.amount)}.` });
      }
    });

    const amounts = items.map((it) => it.amount).filter(ok);
    if (amounts.length && amounts.length === items.length) {
      const s = sum(amounts);
      const targets = [inv.total_amount, inv.amount_due].filter(ok);
      if (targets.length && !targets.some((t) => eqMoney(s, t))) {
        out.push({ code: 'items_total',
          message: `Сумма позиций ${formatRu(round2(s))} не совпадает с итогом счёта ${targets.map(formatRu).join(' / ')}.` });
      }
    }

    if (ok(inv.total_amount) && ok(inv.amount_due) && !eqMoney(inv.total_amount, inv.amount_due)) {
      // «Итого без НДС» + НДС = «К оплате» — тоже нормальный счёт
      const onTop = ok(inv.vat_amount) && eqMoney(add(inv.total_amount, inv.vat_amount), inv.amount_due);
      if (!onTop) {
        out.push({ code: 'totals_relation',
          message: `Итог ${formatRu(inv.total_amount)} и сумма к оплате ${formatRu(inv.amount_due)} не сходятся${ok(inv.vat_amount) ? ` (НДС ${formatRu(inv.vat_amount)})` : ''}.` });
      }
    }

    const vats = items.map((it) => it.vat_amount).filter(ok);
    if (vats.length && vats.length === items.length && ok(inv.vat_amount) && !eqMoney(sum(vats), inv.vat_amount)) {
      out.push({ code: 'vat_total',
        message: `НДС по строкам ${formatRu(round2(sum(vats)))} не совпадает с НДС в итогах ${formatRu(inv.vat_amount)}.` });
    }

    if (Number.isInteger(inv.items_declared) && inv.items_declared !== items.length) {
      out.push({ code: 'items_count',
        message: `В документе указано наименований: ${inv.items_declared}, а позиций в таблице: ${items.length}.` });
    }

    [['supplier_inn', 'поставщика'], ['buyer_inn', 'покупателя']].forEach(([f, who]) => {
      if (inv[f] && !innValid(inv[f])) {
        out.push({ code: f, message: `ИНН ${who} ${inv[f]} не проходит проверку контрольной суммы — проверьте цифры.` });
      }
    });
    return out;
  }

  return {
    parseDecimal, isCanonical, add, sub, mul, round2, eqMoney, sum, formatRu,
    innValid, kppValid, validateInvoice
  };
}));
