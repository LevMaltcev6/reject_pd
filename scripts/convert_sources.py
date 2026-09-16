"""Read original Office XML without third-party Python dependencies. Never edit sources."""
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as E
import json
import re
import hashlib

ROOT = Path(__file__).resolve().parent.parent
S = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
W = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

def spreadsheet(path, headers):
    with ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(n.itertext()) for n in E.fromstring(z.read('xl/sharedStrings.xml'))]
        rows = []
        for row in E.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//s:row', S):
            cells = {}
            for c in row.findall('s:c', S):
                if c.find('s:f', S) is not None:
                    raise ValueError('Formulas in source catalog are not supported')
                value = c.find('s:v', S)
                text = value.text if value is not None else ''
                if c.get('t') == 's': text = strings[int(text)]
                if c.get('t') == 'inlineStr': text = ''.join(c.find('s:is', S).itertext())
                cells[re.sub(r'\d', '', c.get('r'))] = (text or '').strip()
            rows.append(cells)
        if not rows or [rows[0].get(k) for k in 'ABCD'] != headers:
            raise ValueError(f'Unexpected catalog headers in {path.name}')
        return rows[1:]

def addresses(value, name):
    emails = [x.strip() for x in re.split('[,;]', value) if x.strip()]
    if not emails or any(not re.fullmatch(r'[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+', x) for x in emails):
        raise ValueError(f'Invalid address in {name}')
    if len(set(x.lower() for x in emails)) != len(emails):
        raise ValueError(f'Duplicate address in {name}')
    return emails

def update_companies(companies, path):
    """Match the supplied legal entities to existing brands by their email addresses."""
    by_email = {email.lower(): c for c in companies for email in c['emails']}
    matched = set()
    inns = set()
    used_emails = set()
    result = []
    for row in spreadsheet(path, ['Юридическое наименование', 'Почта', 'ИНН', 'ОГРН']):
        if not any(row.values()): continue
        legal_name = row.get('A', '')
        if not legal_name: raise ValueError('Missing legal name in updated catalog')
        emails = addresses(row.get('B', ''), legal_name)
        inn, ogrn = row.get('C', ''), row.get('D', '')
        if not re.fullmatch(r'\d{10}', inn) or not re.fullmatch(r'\d{13}', ogrn):
            raise ValueError(f'Invalid identifier format in {legal_name}')
        if inn in inns or used_emails.intersection(e.lower() for e in emails):
            raise ValueError(f'Duplicate company or address in {legal_name}')
        inns.add(inn)
        used_emails.update(e.lower() for e in emails)
        matches = {by_email[e.lower()]['id'] for e in emails if e.lower() in by_email}
        if len(matches) > 1: raise ValueError(f'Ambiguous company match: {legal_name}')
        if matches:
            identifier = next(iter(matches))
            if identifier in matched: raise ValueError(f'Repeated company match: {legal_name}')
            matched.add(identifier)
            company = next(c.copy() for c in companies if c['id'] == identifier)
        else:
            company = {'id': hashlib.sha256(f'inn:{inn}'.encode()).hexdigest()[:12],
                       'name': legal_name, 'sourceStatus': '', 'notes': '',
                       'special': None, 'withdrawalExtra': ''}
        company.update(legalName=legal_name, inn=inn, ogrn=ogrn, emails=emails)
        result.append(company)
    # Keep any earlier companies absent from a later supplement.
    result.extend(c for c in companies if c['id'] not in matched)
    return result

def paragraphs(path):
    with ZipFile(path) as z:
        root = E.fromstring(z.read('word/document.xml'))
        result = []
        count = 0
        for p in root.findall('.//w:body/w:p', W):
            text = ''.join(n.text or '' for n in p.findall('.//w:t', W)).strip()
            if not text: continue
            if p.find('w:pPr/w:numPr', W) is not None:
                count += 1
                text = f'{count}. {text}'
            result.append(text)
        return result

def template(path, mode):
    p = paragraphs(path)
    start = next(i for i, x in enumerate(p) if x.startswith('Я,'))
    end = next(i for i, x in enumerate(p) if x.startswith('[ДАТА]'))
    body = '\n\n'.join(p[start:end])
    body = body.replace('[ФИО]', '{{ФИО}}').replace('Я, ФИО', 'Я, {{ФИО}}')
    body = body.replace('[Наименование организации]', '{{Компания}}').replace('НАИМЕНОВАНИЕ', '{{Компания}}')
    body = body.replace('[e-mail]', '{{Email}}').replace('_________________', '{{Email}}')
    body = body.replace(' и аналогичного образцу, приложенному к обращению', '')
    if re.search(r'\[[^\]]+\]|_{3,}', body): raise ValueError('Unmapped source placeholders')
    return {'body': body, 'subject': ('Отзыв согласия на обработку персональных данных' if mode == 'withdrawal' else 'Запрос информации об обработке персональных данных') + ' — {{ФИО}}'}

def main():
    xlsx = next(ROOT.glob('Список*.xlsx'))
    updated = ROOT / 'реквизиты.xlsx'
    docs = [p for p in ROOT.glob('*.docx') if not p.name.startswith('~$')]
    withdrawal = next(p for p in docs if 'универсаль' in p.name)
    inquiry = next(p for p in docs if 'запроса' in p.name)
    companies = []
    for row in spreadsheet(xlsx, ['Компания', 'Почта', 'Статус', 'Особенности']):
        name = row.get('A', '')
        if not name: continue
        emails = addresses(row.get('B', ''), name)
        notes = row.get('D', '')
        special = 'pdf' if name == 'Сбер Мобайл' else 'signature' if name == 'СКБ Контур' else None
        extra = ''
        if special == 'pdf':
            extra = notes.split('В электронном письме прописать: "', 1)[1].split('".   К письму', 1)[0]
        companies.append({'id': hashlib.sha256(name.encode()).hexdigest()[:12], 'name': name,
                          'emails': emails, 'sourceStatus': row.get('C', ''), 'notes': '' if notes == '-' else notes,
                          'special': special, 'withdrawalExtra': extra})
    companies = update_companies(companies, updated)
    data = {'companies': companies, 'templates': {'withdrawal': template(withdrawal, 'withdrawal'), 'inquiry': template(inquiry, 'inquiry')},
            'sources': [{'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in [xlsx, updated, withdrawal, inquiry]]}
    out = ROOT / 'src' / 'generated' / 'data.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(f'Converted {len(companies)} companies, {sum(len(c["emails"]) for c in companies)} addresses, 2 templates')

if __name__ == '__main__': main()
