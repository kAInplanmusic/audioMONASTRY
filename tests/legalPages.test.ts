/**
 * PROD-P0-005: Impressum und Datenschutz als oeffentliche Seiten.
 *
 * Warum es diese Tests gibt: Rechtstexte sind der einzige Teil der Anwendung,
 * dessen Fehlen oder Falschsein unmittelbar haftungsrelevant ist. Deshalb pruefen
 * sie nicht "rendert irgendwas", sondern die Eigenschaften, die hier zaehlen:
 *
 *   1. BEIDE Pfade rendern vollstaendiges HTML (sonst ist die Seite nicht da).
 *   2. Die Pflichtinhalte stehen drin (par. 5 DDG, Art. 13 DSGVO, Datenfluss,
 *      Betroffenenrechte) - nicht nur eine Überschrift.
 *   3. FEHLT eine Pflichtangabe, wird das SICHTBAR gesagt. Es wird keine leere
 *      oder erfundene Anschrift gerendert: eine erfundene Anschrift waere
 *      schlimmer als keine.
 *   4. Die Werte kommen aus der Umgebung und muessen HTML-escaped werden - sonst
 *      waere LEGAL_NAME ein XSS-Pfad.
 *   5. Die Seiten laden NICHTS Externes. Eine Datenschutzerklaerung, die beim
 *      Aufruf eine Verbindung zu Google Fonts aufbaut, widerlegt sich selbst.
 *   6. Sie liegen NICHT unter /api - dort greift die Token-Sperre, und eine
 *      unzugaengliche Datenschutzerklaerung waere wertlos.
 *
 * Lauf: npx vitest run tests/legalPages.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  LEGAL_PATHS,
  escapeHtml,
  isLegalPath,
  missingMandatoryFields,
  operatorFromEnv,
  registerLegalRoutes,
  renderDatenschutz,
  renderImpressum,
  renderLegalPage,
} from '../server/legalPages';

const VOLLSTAENDIG = {
  LEGAL_NAME: 'Max Beispiel',
  LEGAL_STREET: 'Beispielweg 1',
  LEGAL_CITY: '12345 Beispielstadt',
  LEGAL_COUNTRY: 'Deutschland',
  LEGAL_EMAIL: 'kontakt@example.org',
  LEGAL_PHONE: '+49 30 1234567',
  LEGAL_REPRESENT: 'Max Beispiel',
  LEGAL_SUPERVISORY: 'Landesbeauftragte für Datenschutz, Beispielstadt',
};

describe('Rechtstexte: Inhalt', () => {
  it('rendert beide Seiten als vollstaendiges HTML-Dokument', () => {
    for (const path of LEGAL_PATHS) {
      const html = renderLegalPage(path, operatorFromEnv({}));
      expect(html, `${path} liefert nichts`).toBeTruthy();
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain('<html lang="de">');
      expect(html).toContain('</html>');
      expect(html).toContain('<meta charset="utf-8">');
    }
  });

  it('Impressum nennt die Pflichtgrundlage und die Kontaktwege', () => {
    const html = renderImpressum(operatorFromEnv(VOLLSTAENDIG));
    expect(html).toContain('§ 5 DDG');
    expect(html).toContain('Streitschlichtung');
    expect(html).toContain('Verantwortlich für den Inhalt');
    // Der Kontaktweg muss als solcher anklickbar sein.
    expect(html).toContain('mailto:kontakt@example.org');
  });

  it('Datenschutz ist nach Art. 13 DSGVO gegliedert und nennt die Rechte', () => {
    const html = renderDatenschutz(operatorFromEnv({}));
    expect(html).toContain('Art. 13 DSGVO');
    expect(html).toContain('Verantwortlicher');
    expect(html).toContain('Drittländer');
    expect(html).toContain('Rechtsgrundlagen');
    expect(html).toContain('Speicherdauer');
    // Die Betroffenenrechte muessen einzeln stehen, nicht als Sammelbegriff.
    for (const recht of ['Art. 15', 'Art. 16', 'Art. 17', 'Art. 18', 'Art. 20', 'Art. 21', 'Art. 77']) {
      expect(html, `${recht} fehlt`).toContain(recht);
    }
  });

  it('nennt den tatsaechlichen Datenfluss statt einer Vorlage', () => {
    const html = renderDatenschutz(operatorFromEnv({}));
    for (const stelle of ['Browser', 'Cloudflare R2', 'Supabase', 'Hetzner', 'RunPod']) {
      expect(html, `${stelle} fehlt im Datenfluss`).toContain(stelle);
    }
    expect(html).toContain('ausschließlich im Browser');
  });
});

describe('Rechtstexte: fehlende Pflichtangaben werden sichtbar gemacht', () => {
  it('listet jede fehlende Pflichtangabe auf, wenn nichts gesetzt ist', () => {
    const html = renderImpressum(operatorFromEnv({}));
    expect(html).toContain('noch unvollständig');
    for (const feld of ['LEGAL_NAME', 'LEGAL_STREET', 'LEGAL_CITY', 'LEGAL_COUNTRY', 'LEGAL_EMAIL']) {
      expect(html, `${feld} wird nicht als fehlend genannt`).toContain(feld);
    }
  });

  it('zeigt keinen Platzhaltertext als waere er die Anschrift', () => {
    const html = renderImpressum(operatorFromEnv({}));
    expect(html).toContain('Noch nicht eingetragen');
    // Kein erfundener Wert, keine leere Anschrift-Zeile die wie eine echte aussieht.
    expect(html).not.toMatch(/Musterstra|Musterstadt|Lorem|XXX|N\/A/);
  });

  it('verschwindet, sobald die Pflichtangaben gesetzt sind', () => {
    const html = renderImpressum(operatorFromEnv(VOLLSTAENDIG));
    expect(html).not.toContain('noch unvollständig');
    expect(html).toContain('Max Beispiel');
    expect(html).toContain('Beispielweg 1');
    expect(html).toContain('12345 Beispielstadt');
    expect(html).toContain('Deutschland');
    expect(html).toContain('kontakt@example.org');
  });

  it('meldet Telefon NICHT als Pflichtfeld', () => {
    const ohneTelefon = { ...VOLLSTAENDIG, LEGAL_PHONE: '' };
    expect(missingMandatoryFields(operatorFromEnv(ohneTelefon))).toEqual([]);
  });

  it('zaehlt jede einzelne Luecke', () => {
    expect(missingMandatoryFields(operatorFromEnv({}))).toHaveLength(5);
    expect(missingMandatoryFields(operatorFromEnv({ ...VOLLSTAENDIG, LEGAL_STREET: '' }))).toEqual([
      'Straße und Hausnummer (LEGAL_STREET)',
    ]);
  });
});

describe('Rechtstexte: Werte aus der Umgebung werden escaped', () => {
  it('entschaerft HTML in escapeHtml', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b "c" \'d\'')).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
  });

  it('laesst keinen Skript-Tag aus einer Betreiber-Angabe entstehen', () => {
    const boese = { ...VOLLSTAENDIG, LEGAL_NAME: '<script>alert(1)</script>', LEGAL_REPRESENT: '"><img src=x onerror=alert(2)>' };
    const html = renderImpressum(operatorFromEnv(boese));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('schuetzt auch den mailto-Link durch Escaping', () => {
    const html = renderImpressum(operatorFromEnv({ ...VOLLSTAENDIG, LEGAL_EMAIL: 'a"onmouseover="x@b.de' }));
    expect(html).not.toContain('onmouseover="x');
  });
});

describe('Rechtstexte: keine externen Ressourcen', () => {
  it('laedt keine Schriftart, kein Skript, kein Bild von aussen', () => {
    for (const path of LEGAL_PATHS) {
      const html = renderLegalPage(path, operatorFromEnv(VOLLSTAENDIG))!;
      // Keine nachladenden Elemente ueberhaupt.
      expect(html, `${path}: <script> gefunden`).not.toMatch(/<script/i);
      expect(html, `${path}: <link> gefunden`).not.toMatch(/<link/i);
      expect(html, `${path}: <img> gefunden`).not.toMatch(/<img/i);
      expect(html, `${path}: @import gefunden`).not.toMatch(/@import/i);
      expect(html, `${path}: url(http…) gefunden`).not.toMatch(/url\(\s*['"]?https?:/i);
    }
  });

  it('erlaubt genau einen fremden Verweis: die OS-Plattform im Impressum', () => {
    // Ein <a href> auf einen fremden Host ist eine Navigation, kein Abruf - und
    // par. 5 DDG nennt die OS-Plattform ausdruecklich. Genau EIN solcher Verweis
    // ist zulaessig; jeder weitere waere erklaeerungsbeduerftig.
    const impressum = renderImpressum(operatorFromEnv(VOLLSTAENDIG));
    const fremd = [...impressum.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(fremd).toEqual(['https://ec.europa.eu/consumers/odr/']);

    // Der Datenschutz-Text braucht keinen fremden Verweis - er kommt ohne aus.
    const datenschutz = renderDatenschutz(operatorFromEnv(VOLLSTAENDIG));
    expect([...datenschutz.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1])).toEqual([]);
  });
});

describe('Rechtstexte: oeffentlich erreichbar', () => {
  it('liegt nicht unter /api, wo die Token-Sperre greift', () => {
    for (const p of LEGAL_PATHS) {
      expect(p.startsWith('/api'), `${p} laege hinter der Token-Sperre`).toBe(false);
    }
  });

  it('erkennt genau die beiden Pfade', () => {
    expect(isLegalPath('/impressum')).toBe(true);
    expect(isLegalPath('/datenschutz')).toBe(true);
    expect(isLegalPath('/impressum/')).toBe(false);
    expect(isLegalPath('/api/impressum')).toBe(false);
    expect(isLegalPath('/')).toBe(false);
  });

  it('liefert fuer unbekannte Pfade nichts (kein stiller Fallback)', () => {
    expect(renderLegalPage('/impressumx', operatorFromEnv({}))).toBeNull();
  });
});

describe('Rechtstexte: Routen-Registrierung', () => {
  /** Minimaler Express-Ersatz, der die Handler sammelt und aufrufbar macht. */
  function fakeApp() {
    const routes = new Map<string, (req: unknown, res: unknown) => void>();
    return {
      routes,
      get(paths: string[], handler: (req: unknown, res: unknown) => void) {
        for (const p of paths) routes.set(p, handler);
      },
    };
  }

  function fakeRes() {
    const headers: Record<string, string> = {};
    return {
      headers,
      statusCode: 200,
      body: '',
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type() {
        return this;
      },
      send(payload: string) {
        this.body = payload;
        return this;
      },
    };
  }

  it('haengt beide Pfade ein und liefert HTML mit passenden Kopfzeilen', () => {
    const app = fakeApp();
    // @ts-expect-error minimaler Ersatz fuer den Express-Typ
    registerLegalRoutes(app, VOLLSTAENDIG);
    expect([...app.routes.keys()].sort()).toEqual(['/datenschutz', '/impressum']);

    for (const p of LEGAL_PATHS) {
      const res = fakeRes();
      app.routes.get(p)!({ path: p }, res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.body).toContain('<html lang="de">');
    }
  });
});
