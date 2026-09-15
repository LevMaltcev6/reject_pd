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

def spreadsheet(path):
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
        if [rows[0].get(k) for k in 'ABCD'] != ['Компания', 'Почта', 'Статус', 'Особенности']:
            raise ValueError('Unexpected catalog headers')
        return rows[1:]

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
    xlsx = next(ROOT.glob('*.xlsx'))
    docs = list(ROOT.glob('*.docx'))
    withdrawal = next(p for p in docs if 'универсаль' in p.name)
    inquiry = next(p for p in docs if 'запроса' in p.name)
    companies = []
    for row in spreadsheet(xlsx):
        name = row.get('A', '')
        if not name: continue
        emails = [x.strip() for x in re.split('[,;]', row.get('B', '')) if x.strip()]
        if not emails or any(not re.fullmatch(r'[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+', x) for x in emails):
            raise ValueError(f'Invalid address in {name}')
        notes = row.get('D', '')
        special = 'pdf' if name == 'Сбер Мобайл' else 'signature' if name == 'СКБ Контур' else None
        extra = ''
        if special == 'pdf':
            extra = notes.split('В электронном письме прописать: "', 1)[1].split('".   К письму', 1)[0]
        companies.append({'id': hashlib.sha256(name.encode()).hexdigest()[:12], 'name': name,
                          'emails': emails, 'sourceStatus': row.get('C', ''), 'notes': '' if notes == '-' else notes,
                          'special': special, 'withdrawalExtra': extra})
    data = {'companies': companies, 'templates': {'withdrawal': template(withdrawal, 'withdrawal'), 'inquiry': template(inquiry, 'inquiry')},
            'sources': [{'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in [xlsx, withdrawal, inquiry]]}
    out = ROOT / 'src' / 'generated' / 'data.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(f'Converted {len(companies)} companies, {sum(len(c["emails"]) for c in companies)} addresses, 2 templates')

if __name__ == '__main__': main()
