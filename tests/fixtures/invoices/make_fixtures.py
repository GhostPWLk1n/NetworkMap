#!/usr/bin/env python3
"""
Генератор ВЫМЫШЛЕННЫХ счетов поставщиков для проверки разбора PDF (задача #8).

Все организации, ИНН, банковские реквизиты и люди выдуманы; ИНН имеют верную
контрольную сумму только для того, чтобы проверка контрольных цифр в разборе
не помечала их как ошибочные. Реальные документы в репозиторий не кладём.

Каждый файл закрывает свой случай разбора:
  invoice-3pages.pdf       реквизиты, банковская сетка и условия с цифрами на 1-й
                           странице, таблица на 2-й, итоги — отдельно на 3-й
  invoice-long-table.pdf   таблица переходит со 2-й страницы на 3-ю: повтор
                           заголовка, колонтитул «Страница N из M», переносы
                           наименований на две строки, «Всего наименований N»
  invoice-vat-columns.pdf  другой порядок колонок, колонки НДС, «Плательщик»,
                           «ИНН/КПП a/b», дата цифрами, валюта USD
  invoice-mismatch.pdf     суммы не сходятся (строка и итог), «Без налога (НДС)»
  invoice-scan.pdf         только изображение — текстового слоя нет
  invoice-1c-centered.pdf  в стиле 1С: заголовки по центру, числа вправо, без артикула;
                           таблица переходит на 2-ю страницу БЕЗ повтора заголовка,
                           пустая единица измерения, «Счет» без «ё», «НДС не облагается»
  invoice-wordwise.pdf     тот же счёт, что invoice-3pages, но каждое слово записано
                           отдельной командой (так пишут многие генераторы PDF). pdf.js
                           сам склеивает такие слова в фразы, поэтому это не новый случай
                           разбора, а подтверждение, что результат не зависит от способа
                           записи текста в PDF

Запуск:  python3 tests/fixtures/invoices/make_fixtures.py
Нужны reportlab и Pillow, шрифт DejaVu Sans. Вывод детерминированный
(rl_config.invariant), поэтому повторный запуск даёт те же байты.
Ожидаемые результаты разбора — expected.json рядом (пишется этим же скриптом).
"""
import io
import json
import os
from decimal import Decimal, ROUND_HALF_UP

from reportlab import rl_config
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

rl_config.invariant = 1  # без даты создания и случайного ID — байты стабильны

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = '/usr/share/fonts/truetype/dejavu'
pdfmetrics.registerFont(TTFont('DV', os.path.join(FONT_DIR, 'DejaVuSans.ttf')))
pdfmetrics.registerFont(TTFont('DVB', os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')))

W, H = A4
Q2 = Decimal('0.01')


def inn10(base9):
    w = [2, 4, 10, 3, 5, 9, 4, 6, 8]
    s = sum(int(d) * k for d, k in zip(base9, w))
    return base9 + str(s % 11 % 10)


def inn12(base10):
    w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
    n11 = sum(int(d) * k for d, k in zip(base10, w1)) % 11 % 10
    s11 = base10 + str(n11)
    w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
    n12 = sum(int(d) * k for d, k in zip(s11, w2)) % 11 % 10
    return s11 + str(n12)


SUPPLIER = {'name': 'ООО «Вымышленная Техника»', 'inn': inn10('770100123'), 'kpp': '770101001'}
BUYER = {'name': 'ООО «Тестовый Заказчик»', 'inn': inn10('500300456'), 'kpp': '500301001'}
SUPPLIER2 = {'name': 'ИП Примеров Пример Примерович', 'inn': inn12('7712345678'), 'kpp': None}
BUYER2 = {'name': 'АО «Условный Завод»', 'inn': inn10('660200789'), 'kpp': '660201001'}


def ru(d, places=2):
    """Число как в документе: пробел — разделитель разрядов, запятая — десятичная."""
    q = Decimal(1).scaleb(-places) if places else Decimal(1)
    d = Decimal(d).quantize(q, rounding=ROUND_HALF_UP)
    sign = '-' if d < 0 else ''
    d = abs(d)
    whole, _, frac = f'{d:f}'.partition('.')
    groups = []
    while len(whole) > 3:
        groups.insert(0, whole[-3:])
        whole = whole[:-3]
    groups.insert(0, whole)
    s = ' '.join(groups)
    return sign + (s + ',' + frac if places else s)


def qty_str(q):
    q = Decimal(q)
    return ru(q, 0) if q == q.to_integral() else ru(q, 3).rstrip('0').rstrip(',')


class Doc:
    def __init__(self, name, wordwise=False):
        self.name = name
        # wordwise: каждое слово — отдельной командой (так пишут многие генераторы PDF)
        self.wordwise = wordwise
        self.buf = io.BytesIO()
        self.c = canvas.Canvas(self.buf, pagesize=A4)
        self.c.setTitle('Вымышленный счёт для тестов NetworkMap')
        self.c.setAuthor('NetworkMap tests')
        self.page = 1

    def text(self, x, y, s, size=9, bold=False, right=False):
        font = 'DVB' if bold else 'DV'
        self.c.setFont(font, size)
        if right:
            x -= pdfmetrics.stringWidth(s, font, size)
        if not self.wordwise:
            self.c.drawString(x, y, s)
            return
        space = pdfmetrics.stringWidth(' ', font, size)
        for word in s.split(' '):
            if word:
                self.c.drawString(x, y, word)
            x += pdfmetrics.stringWidth(word, font, size) + space

    def line(self, x1, y1, x2, y2):
        self.c.setLineWidth(0.5)
        self.c.line(x1, y1, x2, y2)

    def footer(self, total_pages):
        self.text(W / 2 - 30, 28, f'Страница {self.page} из {total_pages}', size=7)

    def next_page(self):
        self.c.showPage()
        self.page += 1

    def save(self):
        self.c.save()
        path = os.path.join(HERE, self.name)
        with open(path, 'wb') as f:
            f.write(self.buf.getvalue())
        return path


def wrap(s, width, font='DV', size=8.5):
    """Перенос по словам в пределах ширины колонки."""
    words, lines, cur = s.split(), [], ''
    for w in words:
        test = (cur + ' ' + w).strip()
        if pdfmetrics.stringWidth(test, font, size) <= width:
            cur = test
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def requisites_block(d, y, supplier, buyer, title, bank=True):
    """Шапка с банковской сеткой: в ней есть числа и строки, похожие на таблицу,
    но позициями счёта они стать не должны."""
    if bank:
        x0, x1, x2, x3 = 40, 300, 360, 555
        rows = [
            ('«Пример Банк» (АО), г. Условный', 'БИК', '044525999'),
            ('Банк получателя', 'Сч. №', '30101810400000000999'),
            (f'ИНН {supplier["inn"]}    КПП {supplier["kpp"] or ""}', 'Сч. №', '40702810900000000001'),
            (supplier['name'], '', ''),
            ('Получатель', '', ''),
        ]
        top = y
        for i, (a, b, cval) in enumerate(rows):
            yy = top - 14 * (i + 1) + 4
            d.text(x0 + 3, yy, a, size=8)
            if b:
                d.text(x1 + 3, yy, b, size=8)
            if cval:
                d.text(x2 + 3, yy, cval, size=8)
        bottom = top - 14 * len(rows)
        for xx in (x0, x1, x2, x3):
            d.line(xx, top, xx, bottom)
        d.line(x0, top, x3, top)
        d.line(x0, bottom, x3, bottom)
        y = bottom - 26
    d.text(40, y, title, size=13, bold=True)
    y -= 8
    d.line(40, y, 555, y)
    y -= 18
    sup = f'{supplier["name"]}, ИНН {supplier["inn"]}' + (f', КПП {supplier["kpp"]}' if supplier['kpp'] else '') + ', г. Условный'
    d.text(40, y, 'Поставщик', size=9)
    d.text(130, y, sup, size=9)
    y -= 16
    buy = f'{buyer["name"]}, ИНН {buyer["inn"]}' + (f', КПП {buyer["kpp"]}' if buyer['kpp'] else '') + ', г. Тестовск'
    d.text(40, y, 'Покупатель', size=9)
    d.text(130, y, buy, size=9)
    return y - 24


STD_COLS = [  # (заголовок, x левого края, ширина, выравнивание)
    ('№', 40, 22, 'c'), ('Артикул', 62, 70, 'l'), ('Товары (работы, услуги)', 132, 213, 'l'),
    ('Кол-во', 345, 45, 'r'), ('Ед.', 390, 30, 'l'), ('Цена', 420, 65, 'r'), ('Сумма', 485, 70, 'r'),
]


def table_header(d, y, cols):
    """Заголовок таблицы. Как в настоящих счетах, текст узкой колонки переносится
    на несколько строк («Цена без» / «НДС») — разбор должен это переварить."""
    top = y
    wrapped = [wrap(title, w - 4, font='DVB', size=8) for title, x, w, _a in cols]
    lines_max = max(len(wl) for wl in wrapped)
    for (title, x, w, _a), wl in zip(cols, wrapped):
        for k, ln in enumerate(wl):
            d.text(x + 2, y - 11 - 10 * k, ln, size=8, bold=True)
    bottom = y - 8 - 10 * lines_max
    d.line(cols[0][1], top, cols[-1][1] + cols[-1][2], top)
    d.line(cols[0][1], bottom, cols[-1][1] + cols[-1][2], bottom)
    return bottom


def table_row(d, y, cols, values, name_col):
    """Строка таблицы; длинное наименование переносится — высота строки растёт."""
    name_lines = wrap(values[name_col], cols[name_col][2] - 6)
    h = 12 * max(1, len(name_lines)) + 4
    for i, (title, x, w, a) in enumerate(cols):
        if i == name_col:
            for k, ln in enumerate(name_lines):
                d.text(x + 3, y - 11 - 12 * k, ln, size=8.5)
            continue
        v = values[i]
        if v in (None, ''):
            continue
        if a == 'r':
            d.text(x + w - 3, y - 11, v, size=8.5, right=True)
        elif a == 'c':
            d.text(x + w / 2 - pdfmetrics.stringWidth(v, 'DV', 8.5) / 2, y - 11, v, size=8.5)
        else:
            d.text(x + 3, y - 11, v, size=8.5)
    d.line(cols[0][1], y - h, cols[-1][1] + cols[-1][2], y - h)
    return y - h


ITEMS_MAIN = [  # (артикул, наименование, кол-во, ед., цена, вид)
    ('NB-1450', 'Ноутбук Вымышленный Pro 14, 16 ГБ ОЗУ, SSD 512 ГБ', '3', 'шт', '84500.00', 'equipment'),
    ('MN-2701', 'Монитор 27" Условный IPS 2560x1440', '3', 'шт', '23990.00', 'equipment'),
    ('SW-OS-11', 'Лицензия операционной системы, бессрочная, электронная поставка', '3', 'лиц', '17800.00', 'software'),
    ('SW-AV-1Y', 'Антивирус Пример на 1 год, продление', '10', 'лиц', '1450.50', 'software'),
    ('SRV-SET', 'Настройка рабочих мест и перенос данных', '6', 'ч', '2200.00', 'service'),
    ('', 'Доставка до склада покупателя', '1', 'усл', '3500.00', 'service'),
]


def compute(items, vat_mode='inclusive', vat_rate=Decimal('20')):
    rows, total = [], Decimal('0')
    for code, name, q, unit, price, kind in items:
        amount = (Decimal(q) * Decimal(price)).quantize(Q2, rounding=ROUND_HALF_UP)
        total += amount
        rows.append({'code': code or None, 'name': name, 'quantity': q, 'unit': unit,
                     'price': price, 'amount': f'{amount:.2f}', 'kind': kind})
    vat = None
    if vat_mode == 'inclusive':
        vat = (total * vat_rate / (100 + vat_rate)).quantize(Q2, rounding=ROUND_HALF_UP)
    return rows, total, vat


def std_values(i, r):
    return [str(i), r['code'] or '', r['name'], qty_str(r['quantity']), r['unit'],
            ru(r['price']), ru(r['amount'])]


def totals_block(d, y, total, vat, due, count, vat_label='В том числе НДС (20%):', words='Сумма прописью — для теста не используется.'):
    d.text(420, y, 'Итого:', size=9, bold=True)
    d.text(555, y, ru(total), size=9, bold=True, right=True)
    y -= 14
    if vat is None:
        d.text(420, y, 'Без налога (НДС)', size=9, bold=True)
        d.text(555, y, '—', size=9, bold=True, right=True)
    else:
        d.text(330, y, vat_label, size=9, bold=True)
        d.text(555, y, ru(vat), size=9, bold=True, right=True)
    y -= 14
    d.text(400, y, 'Всего к оплате:', size=9, bold=True)
    d.text(555, y, ru(due), size=9, bold=True, right=True)
    y -= 24
    d.text(40, y, f'Всего наименований {count}, на сумму {ru(due)} руб.', size=9)
    y -= 14
    d.text(40, y, words, size=9)
    return y - 20


def signatures(d, y):
    d.text(40, y, 'Руководитель', size=9)
    d.line(130, y - 2, 260, y - 2)
    d.text(265, y, 'Пробный П. П.', size=9)
    d.text(320, y - 30, 'Бухгалтер', size=9)
    d.line(390, y - 32, 480, y - 32)
    d.text(485, y - 30, 'Счётова С. С.', size=9)


def conditions(d, y, lines):
    for s in lines:
        d.text(40, y, s, size=8.5)
        y -= 13
    return y


def expected_entry(number, date, supplier, buyer, currency, rows, total, vat, due, vat_note=None, count=None, warnings=None, pages=None):
    return {
        'number': number, 'invoice_date': date,
        'supplier_name': supplier['name'], 'supplier_inn': supplier['inn'], 'supplier_kpp': supplier['kpp'],
        'buyer_name': buyer['name'], 'buyer_inn': buyer['inn'], 'buyer_kpp': buyer['kpp'],
        'currency': currency,
        'total_amount': None if total is None else f'{total:.2f}',
        'vat_amount': None if vat is None else f'{vat:.2f}',
        'amount_due': None if due is None else f'{due:.2f}',
        'vat_note': vat_note,
        'items': [{k: r[k] for k in ('code', 'name', 'quantity', 'unit', 'price', 'amount')} for r in rows],
        'items_declared': count,
        'expected_warnings': warnings or [],
        'pages': pages,
    }


def make_3pages(expected, name='invoice-3pages.pdf', wordwise=False):
    rows, total, vat = compute(ITEMS_MAIN)
    d = Doc(name, wordwise=wordwise)
    y = requisites_block(d, H - 50, SUPPLIER, BUYER, 'Счёт на оплату № ВТ-2026/1187 от 12 ноября 2026 г.')
    y = conditions(d, y, [
        'Условия поставки и оплаты',
        '1. Счёт действителен в течение 5 банковских дней.',
        '2. Срок поставки — 10 рабочих дней с момента поступления оплаты.',
        '3. Гарантия на оборудование 12 месяцев, на работы 3 месяца.',
        '4. Доставка по адресу: г. Тестовск, пр. Проверочный, 15, склад 2.',
        'Основание: договор поставки № 44/2026 от 01.03.2026.',
    ])
    d.footer(3)
    d.next_page()
    y = table_header(d, H - 60, STD_COLS)
    for i, r in enumerate(rows, 1):
        y = table_row(d, y, STD_COLS, std_values(i, r), 2)
    d.footer(3)
    d.next_page()
    y = totals_block(d, H - 70, total, vat, total, len(rows))
    signatures(d, y - 10)
    d.footer(3)
    d.save()
    expected[name] = expected_entry('ВТ-2026/1187', '2026-11-12', SUPPLIER, BUYER, 'RUB',
                                                    rows, total, vat, total, count=len(rows), pages=3)


ITEMS_LONG = [
    ('SRV-R740', 'Сервер стоечный Условный R740, 2×CPU, 256 ГБ ОЗУ, без дисков, с салазками и кабелем управления', '1', 'шт', '612000.00', 'equipment'),
    ('SSD-3840', 'Накопитель SSD 3,84 ТБ SAS для сервера', '8', 'шт', '41250.00', 'equipment'),
    ('UPS-3000', 'Источник бесперебойного питания 3000 ВА, стоечный', '2', 'шт', '96400.00', 'equipment'),
    ('SW-48P', 'Коммутатор управляемый 48 портов PoE+, 4 порта SFP+', '2', 'шт', '128900.00', 'equipment'),
    ('PATCH-1M', 'Патч-корд медный категории 6, 1 метр', '96', 'шт', '145.00', 'equipment'),
    ('PATCH-3M', 'Патч-корд медный категории 6, 3 метра', '48', 'шт', '210.00', 'equipment'),
    ('RACK-42U', 'Шкаф телекоммуникационный напольный 42U 600×1000', '1', 'шт', '74300.00', 'equipment'),
    ('PDU-16', 'Блок распределения питания 16 розеток', '2', 'шт', '9850.00', 'equipment'),
    ('SW-VIRT', 'Лицензия платформы виртуализации на 2 процессора, подписка на 1 год', '1', 'лиц', '187000.00', 'software'),
    ('SW-BKP', 'Лицензия системы резервного копирования на 10 виртуальных машин', '1', 'лиц', '93500.00', 'software'),
    ('SW-MON', 'Подписка на систему мониторинга, 50 узлов, 12 месяцев', '1', 'лиц', '48000.00', 'software'),
    ('SRV-MNT', 'Монтаж оборудования в шкаф и коммутация', '1', 'усл', '35000.00', 'service'),
    ('SRV-CFG', 'Настройка виртуализации и резервного копирования', '16', 'ч', '3500.00', 'service'),
    ('SRV-DOC', 'Подготовка исполнительной документации', '1', 'усл', '15000.00', 'service'),
    ('KB-RU', 'Клавиатура проводная, русская раскладка', '5', 'шт', '890.50', 'equipment'),
    ('MS-OPT', 'Мышь оптическая проводная', '5', 'шт', '450.25', 'equipment'),
    ('HDMI-2', 'Кабель HDMI 2 метра', '4', 'шт', '320.00', 'equipment'),
    ('', 'Доставка и подъём на этаж', '1', 'усл', '6000.00', 'service'),
]


def make_long_table(expected):
    rows, total, vat = compute(ITEMS_LONG)
    d = Doc('invoice-long-table.pdf')
    y = requisites_block(d, H - 50, SUPPLIER, BUYER, 'Счёт на оплату № 2026-0450 от 3 ноября 2026 г.')
    conditions(d, y, ['Оплата 100% предоплата. Счёт действителен 3 дня.', 'Поставка со склада поставщика, срок 15 рабочих дней.'])
    d.footer(3)
    d.next_page()
    y = table_header(d, H - 60, STD_COLS)
    split = 13
    for i, r in enumerate(rows[:split], 1):
        y = table_row(d, y, STD_COLS, std_values(i, r), 2)
    d.text(40, 44, f'{SUPPLIER["name"]} · счёт № 2026-0450', size=7)  # колонтитул с числом — не позиция
    d.footer(3)
    d.next_page()
    y = table_header(d, H - 60, STD_COLS)                               # заголовок повторяется
    for i, r in enumerate(rows[split:], split + 1):
        y = table_row(d, y, STD_COLS, std_values(i, r), 2)
    y = totals_block(d, y - 20, total, vat, total, len(rows))
    signatures(d, y - 10)
    d.footer(3)
    d.save()
    expected['invoice-long-table.pdf'] = expected_entry('2026-0450', '2026-11-03', SUPPLIER, BUYER, 'RUB',
                                                        rows, total, vat, total, count=len(rows), pages=3)


VAT_COLS = [  # другой порядок: наименование раньше кода, единица перед количеством, колонки НДС
    ('№ п/п', 40, 28, 'c'), ('Наименование', 68, 158, 'l'), ('Код', 226, 52, 'l'), ('Ед. изм.', 278, 34, 'l'),
    ('Количество', 312, 62, 'r'), ('Цена без НДС', 374, 60, 'r'), ('Ставка НДС', 434, 36, 'c'),
    ('Сумма НДС', 470, 40, 'r'), ('Сумма с НДС', 510, 50, 'r'),
]


def make_vat_columns(expected):
    items = [
        ('LIC-DB-1', 'Подписка на СУБД, 1 ядро, 12 месяцев', '4', 'лиц', '350.00'),
        ('LIC-IDE', 'Подписка на среду разработки', '2', 'лиц', '149.00'),
        ('SUP-STD', 'Техническая поддержка, стандарт', '1', 'мес', '1200.00'),
    ]
    rows, total_net, total_vat = [], Decimal('0'), Decimal('0')
    for code, name, q, unit, price in items:
        net = (Decimal(q) * Decimal(price)).quantize(Q2)
        vat = (net * Decimal('0.20')).quantize(Q2, rounding=ROUND_HALF_UP)
        gross = net + vat
        total_net += net
        total_vat += vat
        rows.append({'code': code, 'name': name, 'quantity': q, 'unit': unit, 'price': price,
                     'amount': f'{gross:.2f}', 'vat_rate': '20%', 'vat_amount': f'{vat:.2f}', 'kind': None})
    total = total_net + total_vat
    d = Doc('invoice-vat-columns.pdf')
    y = H - 60
    d.text(40, y, 'Счёт № INV-77/26 от 05.11.2026', size=13, bold=True)
    y -= 24
    d.text(40, y, f'Исполнитель: {SUPPLIER2["name"]}, ИНН {SUPPLIER2["inn"]}, г. Условный', size=9)
    y -= 15
    d.text(40, y, f'Плательщик: {BUYER2["name"]}, ИНН/КПП {BUYER2["inn"]}/{BUYER2["kpp"]}', size=9)
    y -= 15
    d.text(40, y, 'Валюта счёта: USD', size=9)
    y -= 24
    y = table_header(d, y, VAT_COLS)
    for i, r in enumerate(rows, 1):
        vals = [str(i), r['name'], r['code'], r['unit'], qty_str(r['quantity']), ru(r['price']),
                r['vat_rate'], ru(r['vat_amount']), ru(r['amount'])]
        y = table_row(d, y, VAT_COLS, vals, 1)
    y -= 20
    d.text(380, y, 'Итого без НДС:', size=9, bold=True)
    d.text(560, y, ru(total_net), size=9, bold=True, right=True)
    y -= 14
    d.text(380, y, 'Сумма НДС:', size=9, bold=True)
    d.text(560, y, ru(total_vat), size=9, bold=True, right=True)
    y -= 14
    d.text(380, y, 'Итого к оплате:', size=9, bold=True)
    d.text(560, y, ru(total), size=9, bold=True, right=True)
    d.save()
    e = expected_entry('INV-77/26', '2026-11-05', SUPPLIER2, BUYER2, 'USD', rows, total_net, total_vat, total, pages=1)
    for it, r in zip(e['items'], rows):
        it['vat_rate'] = r['vat_rate']
        it['vat_amount'] = r['vat_amount']
    expected['invoice-vat-columns.pdf'] = e


def make_mismatch(expected):
    items = [
        ('CAB-UTP', 'Кабель витая пара, бухта 305 м', '2', 'бух', '9800.00', 'equipment'),
        ('RJ45-100', 'Коннектор RJ-45, упаковка 100 шт', '3', 'уп', '650.00', 'equipment'),
        ('', 'Прокладка кабеля, за метр', '120', 'м', '85.00', 'service'),
    ]
    rows, total, _ = compute(items, vat_mode='none')
    rows[1]['amount'] = '1960.00'                    # в документе ошибка: 3 × 650 = 1950
    wrong_total = Decimal('31800.00')                # и итог не равен сумме строк (31750 / 31760)
    d = Doc('invoice-mismatch.pdf')
    y = requisites_block(d, H - 50, SUPPLIER, BUYER, 'Счёт на оплату № 15 от 20 октября 2026 г.', bank=False)
    y = table_header(d, y, STD_COLS)
    for i, r in enumerate(rows, 1):
        y = table_row(d, y, STD_COLS, std_values(i, r), 2)
    totals_block(d, y - 20, wrong_total, None, wrong_total, len(rows))
    d.save()
    expected['invoice-mismatch.pdf'] = expected_entry(
        '15', '2026-10-20', SUPPLIER, BUYER, 'RUB', rows, wrong_total, None, wrong_total,
        vat_note='Без налога (НДС)', count=len(rows), pages=1,
        warnings=['line_amount', 'items_total'])


def make_scan(expected):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('L', (1240, 1754), 255)
    dr = ImageDraw.Draw(img)
    font = ImageFont.truetype(os.path.join(FONT_DIR, 'DejaVuSans.ttf'), 30)
    lines = ['Счёт на оплату № 99 от 1 ноября 2026 г.', f'Поставщик: {SUPPLIER["name"]}',
             'Монитор 24" — 2 шт × 15 000,00 = 30 000,00', 'Итого: 30 000,00']
    for i, s in enumerate(lines):
        dr.text((80, 120 + 60 * i), s, fill=0, font=font)
    png = io.BytesIO()
    img.save(png, format='PNG', optimize=True)
    png.seek(0)
    from reportlab.lib.utils import ImageReader
    d = Doc('invoice-scan.pdf')
    d.c.drawImage(ImageReader(png), 0, 0, width=W, height=H)
    d.save()
    expected['invoice-scan.pdf'] = {'no_text_layer': True, 'pages': 1}


C1_COLS = [  # заголовки по центру колонки, числа вправо; артикула нет
    ('№', 40, 24, 'c'), ('Товары (работы, услуги)', 64, 266, 'l'), ('Кол-во', 330, 50, 'r'),
    ('Ед.', 380, 34, 'l'), ('Цена', 414, 66, 'r'), ('Сумма', 480, 75, 'r'),
]


def table_header_centered(d, y, cols):
    for title, x, w, _a in cols:
        tw = pdfmetrics.stringWidth(title, 'DVB', 8)
        d.text(x + (w - tw) / 2, y - 12, title, size=8, bold=True)
    bottom = y - 18
    d.line(cols[0][1], y, cols[-1][1] + cols[-1][2], y)
    d.line(cols[0][1], bottom, cols[-1][1] + cols[-1][2], bottom)
    return bottom


def make_1c_centered(expected):
    base = [
        ('Картридж лазерный совместимый', 'шт', '4.00'), ('Бумага офисная А4, 500 листов', 'пач', '389.90'),
        ('Заправка картриджа', '', '650.00'), ('Флеш-накопитель 64 ГБ', 'шт', '719.00'),
        ('Гарнитура USB с микрофоном', 'шт', '2450.00'), ('Удлинитель сетевой 5 розеток, 3 м', 'шт', '980.00'),
        ('Веб-камера Full HD', 'шт', '3290.00'), ('Батарейки AA, упаковка 4 шт', 'уп', '310.00'),
    ]
    items = []
    for k in range(25):
        name, unit, price = base[k % len(base)]
        q = str((k % 5) + 1)
        items.append(('', f'{name} (партия {k + 1})', q, unit, price, None))
    rows, total, _ = compute(items, vat_mode='none')
    d = Doc('invoice-1c-centered.pdf')
    y = H - 60
    d.text(40, y, 'Счет на оплату № 0001-77 от 1 декабря 2026 г.', size=13, bold=True)
    y -= 10
    d.line(40, y, 555, y)
    y -= 18
    d.text(40, y, f'Поставщик (Исполнитель): {SUPPLIER2["name"]}, ИНН {SUPPLIER2["inn"]}, г. Условный', size=9)
    y -= 15
    d.text(40, y, f'Покупатель (Заказчик): {BUYER["name"]}, ИНН {BUYER["inn"]}, КПП {BUYER["kpp"]}', size=9)
    y -= 22
    y = table_header_centered(d, y, C1_COLS)
    split = 17
    for i, r in enumerate(rows[:split], 1):
        vals = [str(i), r['name'], qty_str(r['quantity']), r['unit'], ru(r['price']), ru(r['amount'])]
        y = table_row(d, y, C1_COLS, vals, 1)
    d.footer(2)
    d.next_page()
    y = H - 50                                          # заголовок НЕ повторяется
    for i, r in enumerate(rows[split:], split + 1):
        vals = [str(i), r['name'], qty_str(r['quantity']), r['unit'], ru(r['price']), ru(r['amount'])]
        y = table_row(d, y, C1_COLS, vals, 1)
    y -= 18
    d.text(420, y, 'Итого:', size=9, bold=True)
    d.text(555, y, ru(total), size=9, bold=True, right=True)
    y -= 14
    d.text(420, y, 'НДС не облагается', size=9, bold=True)
    y -= 14
    d.text(400, y, 'Всего к оплате:', size=9, bold=True)
    d.text(555, y, ru(total), size=9, bold=True, right=True)
    y -= 24
    d.text(40, y, f'Всего наименований {len(rows)}, на сумму {ru(total)} руб.', size=9)
    signatures(d, y - 30)
    d.footer(2)
    d.save()
    for r in rows:
        if not r['unit']:
            r['unit'] = None
    expected['invoice-1c-centered.pdf'] = expected_entry(
        '0001-77', '2026-12-01', SUPPLIER2, BUYER, 'RUB', rows, total, None, total,
        vat_note='НДС не облагается', count=len(rows), pages=2)


def _tounicode_map(stream_bytes):
    """ToUnicode CMap → {код: строка}. Нужны bfchar и bfrange — так пишет reportlab."""
    import re as _re
    text = stream_bytes.decode('latin1')
    out = {}
    for block in _re.findall(r'beginbfchar(.*?)endbfchar', text, _re.S):
        for src, dst in _re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            out[int(src, 16)] = bytes.fromhex(dst).decode('utf-16-be')
    for block in _re.findall(r'beginbfrange(.*?)endbfrange', text, _re.S):
        for a, b, dst in _re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            start = int(dst, 16)
            for k, code in enumerate(range(int(a, 16), int(b, 16) + 1)):
                out[code] = chr(start + k)
    return out


def make_cid_variant(expected, src, dst, strip_only=False):
    """Тот же счёт, но шрифты — как у части генераторов PDF:
    strip_only=False — составной шрифт Type0 / Identity-H со встроенным TrueType и БЕЗ
      ToUnicode (коды — номера глифов). pdf.js сам такой текст не читает, приложение
      восстанавливает буквы по таблице cmap встроенного шрифта;
    strip_only=True — у простых шрифтов просто убрана ToUnicode: восстановить буквы
      неоткуда, текст нечитаем, форма должна предложить ручное заполнение."""
    import pikepdf
    from fontTools import subset as ft_subset
    from fontTools.ttLib import TTFont as FTFont
    pdf = pikepdf.open(os.path.join(HERE, src))
    fonts_by_base = {'DejaVuSans': os.path.join(FONT_DIR, 'DejaVuSans.ttf'), 'DejaVuSans-Bold': os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')}
    code_maps = {}   # objgen шрифта -> (база, {код: символ})
    used = {b: set() for b in fonts_by_base}
    for page in pdf.pages:
        for name, f in page.Resources.get('/Font', {}).items():
            if '/ToUnicode' not in f:
                continue
            base = str(f.BaseFont).split('+')[-1]
            code_maps[f.objgen] = (base, _tounicode_map(f.ToUnicode.read_bytes()))
    if strip_only:
        for page in pdf.pages:
            for name, f in page.Resources.get('/Font', {}).items():
                if '/ToUnicode' in f:
                    del f['/ToUnicode']
        pdf.save(os.path.join(HERE, dst), deterministic_id=True)
        expected[dst] = {'pages': len(pdf.pages), 'unreadable': True}
        return
    # Шрифты страниц — до любых замен (словарь ресурсов бывает общим для страниц)
    page_fonts = [{str(k): code_maps.get(f.objgen) for k, f in page.Resources.get('/Font', {}).items()} for page in pdf.pages]
    # Какие символы встречаются — для подмножества шрифта
    for pi, page in enumerate(pdf.pages):
        cur = None
        for operands, op in pikepdf.parse_content_stream(page):
            if str(op) == 'Tf':
                cur = page_fonts[pi].get(str(operands[0]))
            elif str(op) in ('Tj', "'", '"', 'TJ') and cur:
                strs = operands[0] if str(op) == 'TJ' else [operands[-1]]
                for s_ in strs:
                    if isinstance(s_, pikepdf.String):
                        used[cur[0]].update(cur[1].get(b, '') for b in bytes(s_))
    new_fonts = {}
    for base, path in fonts_by_base.items():
        full = FTFont(path, recalcTimestamp=False)
        cmap = full.getBestCmap()
        order = full.getGlyphOrder()
        gid_of = {ch: order.index(cmap[ord(ch)]) for ch in used[base] if ch and ord(ch) in cmap}
        opts = ft_subset.Options()
        opts.retain_gids = True          # номера глифов как в полном шрифте — их и пишем в текст
        opts.name_IDs = []
        opts.drop_tables += ['DSIG']
        sub = ft_subset.Subsetter(opts)
        sub.populate(unicodes=[ord(c) for c in gid_of])
        tt = FTFont(path, recalcTimestamp=False)
        sub.subset(tt)
        bio = io.BytesIO()
        tt.save(bio)
        data = bio.getvalue()
        upm = full['head'].unitsPerEm
        widths = []
        for ch, g in sorted(gid_of.items(), key=lambda kv: kv[1]):
            widths += [g, [round(full['hmtx'][order[g]][0] * 1000 / upm)]]
        ff = pdf.make_stream(data)
        ff.Length1 = len(data)
        descriptor = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.FontDescriptor, FontName=pikepdf.Name('/BCDEFG+' + base), Flags=32,
            FontBBox=[-1021, -463, 1793, 1232], ItalicAngle=0, Ascent=928, Descent=-236, CapHeight=729,
            StemV=80, FontFile2=ff))
        cid = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.CIDFontType2, BaseFont=pikepdf.Name('/BCDEFG+' + base),
            CIDSystemInfo=pikepdf.Dictionary(Registry=pikepdf.String('Adobe'), Ordering=pikepdf.String('Identity'), Supplement=0),
            FontDescriptor=descriptor, DW=600, W=widths, CIDToGIDMap=pikepdf.Name.Identity))
        new_fonts[base] = (pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type0, BaseFont=pikepdf.Name('/BCDEFG+' + base),
            Encoding=pikepdf.Name('/Identity-H'), DescendantFonts=[cid])), gid_of)
    for pi, page in enumerate(pdf.pages):
        cur = None
        ops = []
        for operands, op in pikepdf.parse_content_stream(page):
            if str(op) == 'Tf':
                cur = page_fonts[pi].get(str(operands[0]))
            elif str(op) in ('Tj', "'", '"', 'TJ') and cur:
                gid_of = new_fonts[cur[0]][1]
                def conv(s_):
                    return pikepdf.String(b''.join(gid_of[cur[1][b]].to_bytes(2, 'big') for b in bytes(s_)))
                if str(op) == 'TJ':
                    operands = [pikepdf.Array([conv(x) if isinstance(x, pikepdf.String) else x for x in operands[0]])]
                else:
                    operands = list(operands[:-1]) + [conv(operands[-1])]
            ops.append((operands, op))
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(ops))
        fonts = page.Resources.Font
        for name in list(fonts.keys()):
            entry = page_fonts[pi].get(str(name))
            if entry:
                fonts[name] = new_fonts[entry[0]][0]
    pdf.remove_unreferenced_resources()
    pdf.save(os.path.join(HERE, dst), deterministic_id=True, compress_streams=True)
    expected[dst] = dict(expected[src])


if __name__ == '__main__':
    expected = {}
    make_3pages(expected)
    make_long_table(expected)
    make_vat_columns(expected)
    make_mismatch(expected)
    make_scan(expected)
    make_1c_centered(expected)
    make_3pages(expected, 'invoice-wordwise.pdf', wordwise=True)
    make_cid_variant(expected, 'invoice-3pages.pdf', 'invoice-cid-no-tounicode.pdf')
    make_cid_variant(expected, 'invoice-3pages.pdf', 'invoice-unreadable.pdf', strip_only=True)
    with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as f:
        json.dump(expected, f, ensure_ascii=False, indent=2)
        f.write('\n')
    for name in sorted(expected):
        print(f'{name:28s} {os.path.getsize(os.path.join(HERE, name)):>7d} байт')
