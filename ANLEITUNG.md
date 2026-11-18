# 🆓 Kostenlose Einrichtung für dein eigenes Instagram-Konto

Diese Anleitung bringt Instamatisierung **komplett kostenlos** zum Laufen:

- Das Tool läuft **auf deinem eigenen Computer**. Du brauchst also kein Hosting und keinen Server.
- Neue Kommentare holt es im **Abfrage-Modus** selbst ab, jede Minute. Du brauchst also keine öffentliche Adresse, keinen Webhook und keine App-Prüfung durch Meta.
- Es nutzt nur **dein eigenes** Instagram-Konto.

**Zeitaufwand:** ca. 45 Minuten, einmalig.

> **Gut zu wissen:** Das Tool arbeitet, solange es auf deinem Computer läuft. Ist der Computer aus, holt es beim nächsten Start die verpassten Kommentare nach (bis 7 Tage alt, aus deinen 5 neuesten Beiträgen und allen Beiträgen, die du in einer Automation ausgewählt hast). Wenn du später willst, dass es rund um die Uhr läuft, ziehen wir es auf einen Server um. Die Einrichtung hier bleibt dabei gleich.

---

## Teil 1 – Instagram-Konto vorbereiten (5 Min.)

In der **Instagram-App** auf dem Handy:

1. **Professionelles Konto:** Profil → ☰ (oben rechts) → *Kontotyp und Tools* → *Zu professionellem Konto wechseln* → **Creator** oder **Business** wählen. Das ist kostenlos und lässt sich jederzeit rückgängig machen.
   *(Steht dort schon „Zu privatem Konto wechseln“, bist du bereits fertig.)*
2. **Öffentliches Konto:** ☰ → *Kontoprivatsphäre* → „Privates Konto“ muss **aus** sein.
3. **Nachrichten für Tools erlauben:** ☰ → *Nachrichten und Story-Antworten* → *Nachrichtensteuerung* → unter *Verbundene Tools* **„Zugriff auf Nachrichten erlauben“** einschalten.

✅ **Fertig, wenn:** Dein Konto ist professionell und öffentlich.

---

## Teil 2 – Meta-Entwicklerkonto anlegen (5 Min.)

1. Öffne <https://developers.facebook.com> und melde dich mit deinem **Facebook-Konto** an. Hast du keins, legst du kostenlos eins an. Es muss nicht mit Instagram verknüpft sein.
2. Klicke auf **„Loslegen“ / „Get Started“** und folge der Registrierung (E-Mail bzw. Telefonnummer bestätigen, als Rolle z. B. „Developer“).

✅ **Fertig, wenn:** Oben rechts siehst du **„Meine Apps“ / „My Apps“**.

> Das Meta-Portal ist oft auf Englisch. Hier stehen deshalb beide Bezeichnungen.

---

## Teil 3 – Meta-App anlegen und Zugangsschlüssel holen (15 Min.)

### 3.1 App erstellen

1. **Meine Apps → App erstellen** (*My Apps → Create App*).
2. **App-Name:** z. B. `Instamatisierung` (darf nicht „Instagram“ enthalten), dazu deine E-Mail-Adresse → *Weiter*.
3. **Anwendungsfall** (*Use case*): **„Nachrichten und Inhalte auf Instagram verwalten“** (*Manage messaging & content on Instagram*) → *Weiter*.
4. **Unternehmen** (*Business*): Wenn du schon ein Unternehmensportfolio hast, wähle es aus. Bei neuen Apps ist es später ohnehin Pflicht (siehe B1). Sonst *„Ich möchte noch kein Unternehmensportfolio verbinden“* → *Weiter*.
5. Übersicht prüfen → **App erstellen** (*Create app*). Eventuell musst du dein Facebook-Passwort nochmal eingeben.

### 3.2 Welche Variante hat deine App?

Links auf **Anwendungsfälle** → beim Instagram-Anwendungsfall auf **Anpassen**. Im linken Kasten siehst du einen dieser Einträge:

- **„API setup with Unified login“** → weiter mit **Variante B**. Das ist bei allen Apps so, die seit Ende Oktober 2026 erstellt wurden.
- **„API-Einrichtung mit Instagram-Login“** → weiter mit **Variante A** (ältere Apps).

Das Tool funktioniert mit beiden und erkennt die Token-Art automatisch.

---

### Variante A – „API-Einrichtung mit Instagram-Login“ (ältere Apps)

**A1. Berechtigungen prüfen:** Unter *Berechtigungen und Features* sollten diese drei stehen (sonst *Hinzufügen*):
`instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`

**A2. Dein Instagram-Konto als Tester eintragen:**
1. Links: **App-Rollen → Rollen** → **Personen hinzufügen**.
   ⚠️ Nicht **„Testnutzer“** nehmen: Das sind simulierte Facebook-Konten, die wir nicht brauchen.
2. Rolle **„Instagram-Tester“** wählen, deinen Instagram-Benutzernamen eingeben → *Hinzufügen*.
3. Einladung annehmen: <https://www.instagram.com/accounts/manage_access/> → Reiter **„Tester-Einladungen“** → **Annehmen**.

**A3. Token erzeugen:** *API-Einrichtung mit Instagram-Login* → **„1. Zugriffsschlüssel generieren“** → **Konto hinzufügen** → mit Instagram anmelden → **Token generieren** → kopieren (beginnt mit `IGAA…`).

---

### Variante B – „API setup with Unified login“ (neue Apps)

> Meta hat diesen Ablauf erst Ende Oktober 2026 eingeführt. Die Schritte unten stammen aus ersten Erfahrungsberichten anderer Entwickler. Wenn bei dir etwas anders aussieht, schick einen Screenshot.

**B1. Unternehmensportfolio (kostenlos):** Bei Unified login ist ein Meta-Unternehmensportfolio Pflicht.
1. Auf <https://business.facebook.com> ein Portfolio anlegen, falls du noch keins hast.
2. Dort unter **Einstellungen → Konten → Instagram-Konten** dein Instagram-Konto hinzufügen.
3. Die App muss zu diesem Portfolio gehören. Meta fragt das bei der Einrichtung meist ab („Business portfolio selection is mandatory“).

**B2. Konfiguration anlegen:** In **API setup with Unified login** bei *„1. Deine App konfigurieren“* auf **„Neue Konfiguration erstellen“** klicken und die vorgeschlagenen Werte übernehmen:
- **Login-Option:** Allgemein
- **Zugriffstoken:** *Systemnutzer-Zugriffstoken (SUAT)*, **Ablaufdatum:** *Nie*
- **Business-Assets:** dein **Instagram-Konto** (Werbekonto nicht nötig)
- **Berechtigungen:** wie vorgeschlagen (enthält `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`)

Danach die **Konfigurations-ID** notieren (lange Zahl).

**B3. `business_management` ergänzen:** Laut Berichten funktionieren die Instagram-Abfragen ohne diese Berechtigung nicht (Fehler „100/33“). Sie fehlt im Unified-login-Editor. Links unter **Facebook Login for Business → Konfigurationen** die Konfiguration **bearbeiten** und `business_management` hinzufügen.

**B4. Weiterleitungs-URL registrieren:** Meta akzeptiert dort nur echte https-Adressen (kein `localhost`). Trag unter **„Neue Weiterleitungs-URL registrieren“** diese Meta-eigene Adresse ein und klick **Speichern**:
```
https://www.facebook.com/connect/login_success.html
```
Wird auch die abgelehnt, nimm `https://example.com/callback`. Wichtig: Im Tool muss später **genau dieselbe** Adresse im Feld „Weiterleitungs-URL“ stehen.

**B5. App-ID und App-Geheimschlüssel notieren:** Links **App-Einstellungen → Grundlegendes**: **App-ID** und **App-Geheimschlüssel** (*App Secret*, auf **Anzeigen** klicken). Den Token holst du dir später direkt aus dem Tool (Teil 5).

---

✅ **Fertig, wenn:** Variante A: Du hast einen Token kopiert. Variante B: Du hast App-ID, App-Geheimschlüssel und Konfigurations-ID. **Gib Token und Geheimschlüssel niemandem weiter**, sie sind wie Passwörter.

> Die Schritte „Webhooks konfigurieren“ und „Business Login einrichten“ **überspringst** du. Die braucht man im Abfrage-Modus nicht.

---

## Teil 4 – Tool auf deinem Computer installieren (10 Min.)

### 4.1 Node.js installieren

Lade auf <https://nodejs.org> die Version **„LTS“** herunter und installiere sie (einfach immer *Weiter* klicken).

### 4.2 Tool herunterladen

1. Lade den Code als ZIP herunter:
   <https://github.com/fabulousteaching/Instamatisierung/archive/refs/heads/claude/charming-archimedes-mdvv6l.zip>
   *(Du musst bei GitHub angemeldet sein, falls das Repository privat ist.)*
2. Entpacke die ZIP-Datei an einen festen Ort, z. B. in *Dokumente*. Der Ordner heißt dann etwa `Instamatisierung-claude-charming-archimedes-mdvv6l`. Du darfst ihn umbenennen, z. B. in `Instamatisierung`.

### 4.3 Terminal im Ordner öffnen

- **Windows:** Öffne den Ordner im Explorer, klicke oben in die **Adresszeile**, tippe `cmd` und drücke **Enter**.
- **Mac:** Rechtsklick auf den Ordner im Finder → *Dienste* → **Neues Terminal beim Ordner**.
  *(Falls der Eintrag fehlt: Terminal öffnen, `cd ` tippen, mit Leerzeichen, den Ordner ins Fenster ziehen, Enter.)*

### 4.4 Installieren und einrichten

Tippe diese Befehle nacheinander ins Terminal und drücke jeweils **Enter**:

```
npm install
```

```
npm run setup
```

Der Assistent fragt nach einem **Passwort** für dein Dashboard (mind. 8 Zeichen, merken!). Bei der Frage nach dem Modus einfach **Enter** drücken (= Abfrage-Modus).

```
npm start
```

✅ **Fertig, wenn:** Im Terminal steht `Instamatisierung läuft – Dashboard: http://localhost:3000`.

**Lass dieses Fenster offen.** Solange es offen ist, läuft das Tool.

---

## Teil 5 – Verbinden und erste Automation (5 Min.)

1. Öffne im Browser **<http://localhost:3000>** und melde dich mit deinem Passwort an.
2. Reiter **Einstellungen**:
   - **Variante A:** Bei **„Access Token eintragen“** den Token aus Teil 3 einfügen → **Speichern & prüfen**.
   - **Variante B:** Im Kasten **„Mit Meta verbinden“**:
     1. App-ID, App-Geheimschlüssel und Konfigurations-ID eintragen. Bei **Weiterleitungs-URL** genau die Adresse aus B4 eintragen.
     2. **Schritt 1 – „Bei Meta anmelden“**: Es öffnet sich ein neuer Tab. Dort bei Meta anmelden, dein Instagram-Konto auswählen und bestätigen.
     3. Danach landet dieser Tab auf der Weiterleitungs-Adresse. Die Seite ist evtl. leer oder zeigt „Success“ bzw. einen Fehler. **Das ist normal!**
     4. **Schritt 2**: Die komplette Adresse aus der Adresszeile dieses Tabs kopieren (sie enthält `?code=`), im Dashboard-Tab einfügen und **„Verbinden“** klicken.
     Meldet das Tool „Instagram-Konto nicht automatisch gefunden“, schick mir einen Screenshot.
   ✅ Oben rechts erscheint jetzt **`@deinkonto`**, und beim Abfrage-Modus steht **„aktiv (alle 60 s)“**.
3. Reiter **Automationen** → **+ Neue Automation**, zum Beispiel:
   - **Name:** Freebie per DM
   - **Auslöser:** Kommentar enthält `freebie, info, link`
   - **Für welche Beiträge:** erst mal *Alle Beiträge*
   - **DM:** `Hey {username}! 👋 Hier ist dein Link:` + Button „Zum Download“ → deine URL
   - **Öffentliche Antwort** (eine Variante pro Zeile):
     ```
     Schau in deine DMs, @{username}! 📩
     Ist unterwegs, check dein Postfach ✨
     ```
   - **Speichern**
4. Reiter **Testen** → z. B. `Info bitte 😍` eingeben → du siehst genau, was verschickt würde.

> Wichtig: Es werden nur Kommentare beantwortet, die **nach** dem Verbinden geschrieben werden. Alte Kommentare bekommen keine nachträglichen Antworten.

---

## Teil 6 – Echt ausprobieren (10 Min.)

Du brauchst ein **zweites Instagram-Konto** zum Kommentieren, z. B. von einer Freundin oder ein Zweitkonto. Eigene Kommentare ignoriert das Tool absichtlich.

1. **Variante A:** Das zweite Konto auch als Instagram-Tester eintragen (wie in A2) und die Einladung mit diesem Konto annehmen. Solange die App im Entwicklungsmodus ist, lässt Meta DMs oft nur an Tester zu.
   **Variante B:** Erst einmal ohne diesen Schritt testen.
2. Mit dem zweiten Konto unter einem deiner Beiträge **„Info“** kommentieren.
3. Nach **höchstens ca. 1 Minute** plus deiner eingestellten Verzögerung sollte die **DM** ankommen und die **öffentliche Antwort** erscheinen.
4. Im Reiter **Aktivität** siehst du, was passiert ist. Bei einem Fehler steht dort die Meldung von Instagram, die kannst du mir einfach schicken.

---

## Teil 7 – Für alle Follower freischalten

Klappt im Test alles, probierst du es mit einem Konto, das **kein** Tester ist:

- **Öffentliche Antworten** sollten sofort für alle funktionieren.
- **DMs:** Falls sie bei Nicht-Testern mit einem Fehler scheitern, schalte die App auf **Live**. Das ist kostenlos:
  1. Im App-Dashboard: **App-Einstellungen → Grundlegendes** (*App settings → Basic*): eine **Datenschutzrichtlinien-URL** (*Privacy Policy URL*) eintragen, dazu **Kategorie** und **App-Symbol**, dann *Änderungen speichern*.
     *(Für die Datenschutzerklärung reicht eine öffentlich abrufbare Seite, z. B. ein freigegebenes Google-Doc oder die Datenschutzseite deiner Website.)*
  2. Oben im Dashboard den Schalter **App-Modus** von *Entwicklung* auf **Live** stellen.

> Ob Meta für DMs an alle zusätzlich eine App-Prüfung verlangt, hängt von Metas aktuellen Regeln ab. Wir sehen es beim Testen und kümmern uns dann darum.

---

## Im Alltag

- **Starten:** Terminal im Ordner öffnen (Teil 4.3) → `npm start` → Fenster offen lassen.
- **Beenden:** Im Terminal **Strg + C** drücken oder das Fenster schließen.
- **Dashboard:** <http://localhost:3000>
- **Token:** Variante B (Unified login): läuft nicht ab. Variante A: wird automatisch alle 7 Tage verlängert, solange das Tool zwischendurch läuft. War es über 60 Tage aus, erzeugst du einfach einen neuen Token (A3) und trägst ihn ein.
- **Rund um die Uhr, ohne dass dein Computer an sein muss:** Das geht auch kostenlos, z. B. mit Oracle Cloud „Always Free“, ist aber technischer und braucht eine Kreditkarte zur Verifizierung. Sag Bescheid, wenn du das möchtest.

## Hilfe

| Problem | Lösung |
| --- | --- |
| `npm` wird nicht gefunden | Node.js installieren (Teil 4.1), danach das Terminal **neu öffnen**. |
| „Token konnte nicht gespeichert werden“ | Token neu erzeugen (A3) bzw. erneut bei Meta anmelden (Teil 5) und vollständig kopieren, ohne Leerzeichen am Anfang oder Ende. |
| „Konto hinzufügen“ klappt nicht | Ist das Konto professionell und öffentlich (Teil 1)? Variante A: Hast du die Tester-Einladung angenommen (A2)? Variante B: Ist das Konto im Unternehmensportfolio (B1)? |
| Fehler „100/33“ (Variante B) | `business_management` fehlt in der Konfiguration (B3). Danach erneut „Bei Meta anmelden & verbinden“. |
| Meta meldet „URL blockiert“ / „redirect_uri“ (Variante B) | Die Weiterleitungs-URL bei Meta (B4) muss **exakt** mit der im Tool übereinstimmen. |
| Kommentar wird nicht erkannt | Läuft das Terminal-Fenster noch? Steht im Reiter **Aktivität** etwas? Unter **Testen** prüfen, ob das Schlüsselwort passt. |
| DM fehlgeschlagen | Fehlermeldung im Reiter **Aktivität** ansehen. Meist ist die kommentierende Person kein Tester (siehe Teil 6/7). |
