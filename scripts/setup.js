'use strict';

/**
 * Einrichtungs-Assistent: erzeugt die Datei .env mit den wichtigsten Einstellungen.
 * Aufruf:  npm run setup
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const envPath = path.join(__dirname, '..', '.env');

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Zeilen puffern, damit auch schnell (oder per Pipe) eingegebene Antworten nicht verloren gehen.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    if (done) throw new Error('Eingabe beendet – Einrichtung abgebrochen.');
    return value;
  };
  console.log('\n💬 Instamatisierung – Einrichtung\n');

  if (fs.existsSync(envPath)) {
    const answer = (await ask('Es gibt schon eine Einstellungsdatei (.env). Überschreiben? (j/n) ')).trim().toLowerCase();
    if (answer !== 'j' && answer !== 'ja') {
      console.log('Abgebrochen – nichts geändert.');
      rl.close();
      return;
    }
  }

  let password = '';
  while (password.length < 8) {
    password = (await ask('Wähle ein Passwort für das Dashboard (mind. 8 Zeichen): ')).trim();
    if (password.length < 8) console.log('  → Bitte mindestens 8 Zeichen.');
  }

  const modeAnswer = (
    await ask(
      '\nWie sollen neue Kommentare ankommen?\n' +
        '  1 = Abfrage-Modus: das Tool schaut jede Minute selbst nach (empfohlen für deinen eigenen Computer)\n' +
        '  2 = Webhook: Instagram meldet Kommentare sofort (braucht öffentlichen Server + App-Prüfung)\n' +
        'Auswahl [1]: ',
    )
  ).trim();
  const polling = modeAnswer !== '2';

  const content = [
    '# Erzeugt mit "npm run setup". Kann mit einem Texteditor angepasst werden.',
    `ADMIN_PASSWORD=${password}`,
    `POLL_INTERVAL_SECONDS=${polling ? 60 : 0}`,
    'POLL_MEDIA_COUNT=5',
    '',
    '# Nur für den Webhook-Modus nötig:',
    'IG_APP_SECRET=',
    'IG_VERIFY_TOKEN=',
    '',
  ];
  fs.writeFileSync(envPath, content.join('\n'), 'utf8');
  rl.close();

  console.log('\n✓ Gespeichert. Starte das Tool jetzt mit:  npm start');
  console.log('  Danach im Browser öffnen:  http://localhost:3000\n');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
