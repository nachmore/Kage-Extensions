import { describe, expect, it } from 'vitest';
import { baseName, canonicalUrl, findPaths, findUrls, isDocPath, isDocUrl, normalizePath, urlHost, urlTitleGuess } from './url.js';

describe('findUrls', () => {
  it('trims trailing punctuation and keeps balanced parentheses', () => {
    const text = 'See (https://example.com/a_(b)) and https://example.org/y). Also www.example.com/z, ok; https://example.com/q?x=1.';
    const found = findUrls(text);
    expect(found.map((u) => u.url)).toEqual(['https://example.com/a_(b)', 'https://example.org/y', 'https://www.example.com/z', 'https://example.com/q?x=1']);
    for (const u of found) expect(text.slice(u.start, u.end)).toBe(u.raw);
    expect(found[2].raw).toBe('www.example.com/z');
  });

  it('ignores non-http schemes and bare words', () => {
    expect(findUrls('mailto:dana@example.com ftp://example.com example.com and/or')).toEqual([]);
  });
});

describe('canonicalUrl', () => {
  it('drops www, case, default port, trailing slash, tracking and plain fragments', () => {
    const f1 = canonicalUrl('https://wiki.example.com/mtcs/design-review');
    expect(f1).toBe('wiki.example.com/mtcs/design-review');
    expect(canonicalUrl('https://WWW.wiki.example.com/mtcs/design-review/?utm_source=mail#top')).toBe(f1);
    expect(canonicalUrl('http://wiki.example.com:80/mtcs/design-review?fbclid=1&gclid=2&ref=x&si=3')).toBe(f1);
    expect(canonicalUrl('https://example.com/')).toBe('example.com');
    expect(canonicalUrl('example.com/a')).toBe('example.com/a');
  });

  it('keeps single-page-app routes, other ports and sorts the remaining query', () => {
    expect(canonicalUrl('https://example.com/app#/route/1')).toBe('example.com/app#/route/1');
    expect(canonicalUrl('https://example.com/app#!/x')).toBe('example.com/app#!/x');
    expect(canonicalUrl('https://example.com:8443/p?b=2&a=1&utm_medium=x')).toBe('example.com:8443/p?a=1&b=2');
    expect(canonicalUrl('https://example.com/Case/Path')).toBe('example.com/Case/Path');
  });

  it('never keeps credentials and rejects other schemes', () => {
    expect(canonicalUrl('https://user:pw@example.com/x')).toBe('example.com/x');
    expect(canonicalUrl('ftp://example.com/x')).toBeNull();
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('')).toBeNull();
  });
});

describe('isDocUrl, urlHost, urlTitleGuess', () => {
  it('recognizes document extensions, doc hosts and /wiki/ paths', () => {
    expect(isDocUrl('https://example.com/files/plan.pdf')).toBe(true);
    expect(isDocUrl('https://example.com/a/Report.DOCX')).toBe(true);
    for (const ext of ['pptx', 'xlsx', 'key', 'pages', 'numbers', 'md']) expect(isDocUrl(`https://example.com/x.${ext}`), ext).toBe(true);
    expect(isDocUrl('https://docs.example.com/d/1')).toBe(true);
    expect(isDocUrl('https://sheets.example.com/x')).toBe(true);
    expect(isDocUrl('https://slides.example.com/x')).toBe(true);
    expect(isDocUrl('https://wiki.example.com/mtcs/design-review')).toBe(true);
    expect(isDocUrl('https://example.org/wiki/Page')).toBe(true);
    expect(isDocUrl('https://example.com/blog/mtcs-intro')).toBe(false);
    expect(isDocUrl('https://example.org/pricing')).toBe(false);
    expect(isDocUrl('https://example.com/wikipedia')).toBe(false);
  });

  it('derives a host and a readable title guess', () => {
    expect(urlHost('https://WWW.Example.com/x')).toBe('example.com');
    expect(urlHost('nope')).toBeNull();
    expect(urlTitleGuess('https://example.com/blog/mtcs-intro')).toBe('example.com › mtcs-intro');
    expect(urlTitleGuess('https://example.com/')).toBe('example.com');
    expect(urlTitleGuess('https://example.com/a/hello%20world/')).toBe('example.com › hello world');
  });
});

describe('findPaths', () => {
  const only = (text) => findPaths(text).map(({ path, style }) => [path, style]);

  it('finds home, Windows, UNC, file URL and POSIX paths', () => {
    expect(only('~/Documents/MTCS capacity notes.pdf')).toEqual([['~/Documents/MTCS capacity notes.pdf', 'home']]);
    expect(only('see ~/Docs/a b.pdf and ~/x.txt')).toEqual([['~/Docs/a b.pdf', 'home'], ['~/x.txt', 'home']]);
    expect(only('C:\\x\\y.docx is it')).toEqual([['C:\\x\\y.docx', 'win']]);
    expect(only('\\\\srv\\share\\deck.pptx')).toEqual([['\\\\srv\\share\\deck.pptx', 'unc']]);
    expect(only('file:///Users/x/y.pdf')).toEqual([['file:///Users/x/y.pdf', 'fileurl']]);
    expect(only('open /Users/dana/Projects then')).toEqual([['/Users/dana/Projects', 'posix']]);
    expect(only('D:/Work/Plan v2.xlsx tomorrow')).toEqual([['D:/Work/Plan v2.xlsx', 'win']]);
  });

  it('reports offsets into the text', () => {
    const text = 'notes in ~/Docs/a b.pdf.';
    const [p] = findPaths(text);
    expect(text.slice(p.start, p.end)).toBe('~/Docs/a b.pdf');
  });

  it('does not see paths in "and/or", fractions or URLs', () => {
    expect(findPaths('and/or 1/2 w/ the team')).toEqual([]);
    expect(findPaths('https://example.com/wiki/x/y.pdf')).toEqual([]);
    expect(findPaths('/single')).toEqual([]);
  });
});

describe('normalizePath, baseName, isDocPath', () => {
  it('normalizes file URLs, Windows case and trailing separators; keeps ~', () => {
    expect(normalizePath('file:///Users/x/y%20z.pdf')).toBe('/Users/x/y z.pdf');
    expect(normalizePath('file:///C:/Docs/A.pdf')).toBe('c:\\docs\\a.pdf');
    expect(normalizePath('file://srv/share/x')).toBe('\\\\srv\\share\\x');
    expect(normalizePath('C:\\X\\Y\\')).toBe('c:\\x\\y');
    expect(normalizePath('C:/X//Y')).toBe('c:\\x\\y');
    expect(normalizePath('C:\\')).toBe('c:\\');
    expect(normalizePath('~/Docs/')).toBe('~/Docs');
    expect(normalizePath('~/Documents/MTCS capacity notes.pdf')).toBe('~/Documents/MTCS capacity notes.pdf');
    expect(normalizePath('/')).toBe('/');
  });

  it('baseName and isDocPath', () => {
    expect(baseName('~/Documents/MTCS capacity notes.pdf')).toBe('MTCS capacity notes.pdf');
    expect(baseName('C:\\x\\y.docx')).toBe('y.docx');
    expect(baseName('/Users/x/folder/')).toBe('folder');
    expect(baseName('file:///Users/x/a%20b.pdf')).toBe('a b.pdf');
    expect(isDocPath('~/a.pdf')).toBe(true);
    expect(isDocPath('~/folder')).toBe(true);
    expect(isDocPath('~/folder/')).toBe(true);
    expect(isDocPath('~/a.png')).toBe(false);
    expect(isDocPath('')).toBe(false);
  });
});
