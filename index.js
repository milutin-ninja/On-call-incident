// =============================================================================
//  ON-CALL INCIDENT BOT  —  Slack -> Twilio (pozivi) -> ClickUp (task)
// =============================================================================
//
//  ŠTA OVO RADI (ukratko):
//  1. Klijent u svom Slack kanalu pokrene slash komandu -> otvori se modal
//     forma (incident name / description / video / screenshots).
//                                                       [POST /slack/command]
//  2. Na submit forme: Slack kanal se preslika u ClickUp FOLDER (projekat),
//     iz foldera se izgradi "escalation chain" i krene zvonjava.
//                                                  [POST /slack/interactions]
//  3. Twilio zove ljude po redu (Tier 1 -> 2 -> 3). Ako se neko ne javi,
//     odbije, ili ne pritisne 1 u roku od 2 minuta -> ide sledeći.
//                                    [escalateCall + /twilio/voice /status]
//  4. Prvi ko pritisne 1 preuzima incident: TADA se pravi task u ClickUp-u
//     i link se postuje u Slack.                        [POST /twilio/gather]
//
//  ESKALACIONI LANAC (3 nivoa):
//    Tier 1 = SVI developeri zaduženi za projekat (iz Phone Directory dok.)
//             Može ih biti 2+; redosled među njima nije bitan.
//    Tier 2 = team lead njegovog ClickUp Space-a (iz TEAM_LEADS niže)
//    Tier 3 = CTO (iz CTO konstante niže)
//  Ako neko nema broj telefona, taj nivo se preskače (ne prekida se lanac).
//  Ako NIKO iz celog lanca ne potvrdi, ceo krug se PONAVLJA od početka
//  (vidi scheduleNextRound) dok neko ne pritisne 1.
//
// -----------------------------------------------------------------------------
//  ⚠️  ŠTA SE ODRŽAVA RUČNO — pročitaj ovo pre nego što diraš bilo šta
// -----------------------------------------------------------------------------
//  Postoje 4 mesta koja se ručno ažuriraju kad se doda klijent ili se promeni
//  tim. Detaljna uputstva su u komentarima na samim mestima u kodu:
//
//  (A) Railway env varijabla po klijentu:  SLACK_CHANNEL_<ime>_<CHANNEL_ID>
//      -> vrednost = ClickUp FOLDER ID tog projekta.   [vidi buildEscalationChain]
//  (B) ClickUp "Phone Directory" dokument (telefoni + folderi po developeru)
//      -> živi u ClickUp-u, NE u kodu.                 [vidi getPhoneDirectory]
//  (C) TEAM_LEADS konstanta u ovom fajlu.              [vidi TEAM_LEADS]
//  (D) Lista "Incidents" unutar svakog projektnog foldera u ClickUp-u.
//                                                      [vidi resolveListId]
//
//  ⚠️ SLACK APP SCOPE-OVI: chat:write, commands, files:read
//     `files:read` je OBAVEZAN — bez njega upload videa/screenshotova u
//     formi radi, ali skidanje fajla pada i task ostane bez priloga.
//
//  ⚠️ OPCIONE ENV VARIJABLE (imaju razumne default vrednosti):
//     CLICKUP_INCIDENT_LIST_NAME  ime liste u folderu (default "Incidents")
//     CLICKUP_DEFAULT_LIST_ID     rezervna lista ako folder nema svoju
//     INCIDENT_ROUND_PAUSE_MS     pauza između krugova poziva (default 5 min)
//     INCIDENT_MAX_ROUNDS         limit krugova (default 0 = neograničeno)
// =============================================================================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import twilio from "twilio";

const app = express();
// Slack šalje form-urlencoded, Twilio takođe. JSON je za svaki slučaj.
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// -----------------------------------------------------------------------------
//  ENV VARIJABLE (sve se postavljaju u Railway -> Variables)
// -----------------------------------------------------------------------------
//  SLACK_BOT_TOKEN     Slack app "Bot User OAuth Token" (xoxb-...).
//                      Potrebni scope-ovi: chat:write, commands.
//  TWILIO_ACCOUNT_SID  Twilio Console -> Account Info.
//  TWILIO_AUTH_TOKEN   Twilio Console -> Account Info.
//  TWILIO_FROM_NUMBER  Twilio broj sa kog se zove, u E.164 formatu (+381...).
//  RAILWAY_URL         Javni URL ovog servisa, BEZ kose crte na kraju.
//                      ⚠️ Twilio sa ovog URL-a čita instrukcije za poziv —
//                      ako je pogrešan, pozivi zvone ali niko ne čuje poruku.
//  CLICKUP_API_KEY     ClickUp personal API token (pk_...).
//                      ⚠️ Šalje se kao raw vrednost, BEZ "Bearer " prefiksa.
// -----------------------------------------------------------------------------
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const RAILWAY_URL = process.env.RAILWAY_URL;
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;

// -----------------------------------------------------------------------------
//  RUČNO (B) — lokacija "Phone Directory" dokumenta u ClickUp-u
// -----------------------------------------------------------------------------
//  Hardkodovano jer se ovaj dokument praktično nikad ne menja (menja se njegov
//  SADRŽAJ, ne lokacija). Sadržaj se čita u realnom vremenu pri svakom
//  incidentu, tako da izmena telefona u ClickUp-u odmah radi — BEZ redeploya.
//
//  Kako naći ove ID-jeve: otvori dokument u ClickUp-u i pogledaj URL:
//    .../docs/<CLICKUP_PHONE_DOC_ID>/<CLICKUP_PHONE_PAGE_ID>
//  Ako neko napravi NOVI dokument umesto da edituje postojeći, ove dve
//  vrednosti moraju da se promene ovde i da se odradi redeploy.
// -----------------------------------------------------------------------------
const CLICKUP_PHONE_DOC_ID = "8cn80zu-52054";
const CLICKUP_PHONE_PAGE_ID = "8cn80zu-65534";

// -----------------------------------------------------------------------------
//  RUČNO (C) — TEAM LEADS (Tier 2 eskalacije)
// -----------------------------------------------------------------------------
//  KLJUČ = tačno ime ClickUp SPACE-a u kome projekat živi.
//  ⚠️ Ime mora da se poklapa KARAKTER ZA KARAKTER sa imenom Space-a u ClickUp-u
//     (poredi se bez ikakve normalizacije). Ako neko preimenuje Space u
//     ClickUp-u, Tier 2 tiho prestaje da radi — lanac preskoči team leada i
//     ide direktno na CTO-a. U logu se to vidi kao:  🏢 Space: <novo ime>
//     a "Final escalation chain" nema tier 2.
//
//  clickupId = ClickUp user ID te osobe. Služi da se iz Phone Directory
//     dokumenta izvuče njegov TELEFON i ime.
//  ⚠️ Ako je clickupId = null, ta osoba NEMA telefon u sistemu i Tier 2 se
//     preskače. Da bi team lead počeo da se zove:
//       1. dodaj mu red u Phone Directory dokument (sa @mention i brojem)
//       2. upiši njegov ClickUp user ID ovde umesto null
//
//  Kako naći ClickUp user ID: u Phone Directory dokumentu @mention se u API
//  odgovoru vidi kao "user_mention#42457090" — broj je user ID.
//
//  KAD SE DODAJE NOV TIM: dodaj novi red { "Ime Space-a": { name, clickupId } }
//  i redeployuj (ova konstanta se čita samo pri startu procesa).
// -----------------------------------------------------------------------------
const TEAM_LEADS = {
  "NPD Team": { name: "Andrija Djuric", clickupId: "42457090" },
  "New Cookies Team": { name: "Filip Nicic", clickupId: null },
  "Imperija Team": { name: "Marko Vukic", clickupId: null },
  "Test Team": { name: "Nemanja Vasilevski", clickupId: null },
};

// -----------------------------------------------------------------------------
//  RUČNO (C) — CTO (Tier 3, poslednja instanca)
// -----------------------------------------------------------------------------
//  Zove se uvek kao zadnji nivo, za SVE projekte, bez obzira na Space.
//  ⚠️ Ovo je zadnja mreza u lancu — ako ovde nema važećeg telefona (tj. ako
//     clickupId ne postoji u Phone Directory dokumentu), incident može da
//     prođe bez ijednog odgovora. Proveri posle svake promene CTO-a.
// -----------------------------------------------------------------------------
const CTO = { name: "Stefan Mikic", clickupId: "42457093" };

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// -----------------------------------------------------------------------------
//  activeIncidents — IN-MEMORY skladište aktivnih incidenata
// -----------------------------------------------------------------------------
//  Ključ = incidentId ("INC-<timestamp>"), vrednost = ceo objekat incidenta.
//  ⚠️ OGRANIČENJE KOJE TREBA ZNATI: ovo je običan objekat u RAM-u.
//     Redeploy ili restart Railway servisa BRIŠE sve aktivne incidente.
//     Posledica: ako se incident desi tokom deploya, poziv koji je u toku
//     više ne može da se potvrdi (u /twilio/gather incident bude undefined,
//     task se ne napravi). Zato: ne deployuj dok je incident aktivan.
//     Ako ovo ikad postane problem — zamena je Redis ili ClickUp kao izvor
//     istine, ali za trenutni obim (nekoliko incidenata mesečno) je OK.
//  Napomena: incidenti se nikad ne brišu iz memorije (mali leak, ali proces
//     se restartuje na svaki deploy pa se u praksi ne akumulira).
// -----------------------------------------------------------------------------
const activeIncidents = {};

// -----------------------------------------------------------------------------
//  getPhoneDirectory()
// -----------------------------------------------------------------------------
//  Čita ClickUp dokument "Phone Directory" i parsira ga kao markdown tabelu.
//
//  ⚠️ RUČNO (B) — OVAJ DOKUMENT JE JEDINI IZVOR TELEFONA. Format tabele mora
//     da ostane isti jer se parsira po REDOSLEDU KOLONA (ne po imenu kolone):
//
//       | Profil (@mention) | Ime i prezime | Telefon      | Folder ID-jevi |
//       |-------------------|---------------|--------------|----------------|
//       | @Pera Peric       | Pera Peric    | +3816...     | 90141..,90142..|
//
//     kolona 0 -> @mention osobe (odavde se regexom vadi ClickUp user ID)
//     kolona 1 -> ime koje se izgovara u pozivu i prikazuje u Slacku
//     kolona 2 -> telefon; MORA biti u E.164 formatu (+381...) da Twilio radi
//     kolona 3 -> ClickUp FOLDER ID-jevi projekata za koje je taj čovek
//                 zadužen, razdvojeni zapazom. Jedan čovek može imati više
//                 projekata. Ovo je ono što ga čini "Tier 1" za taj projekat.
//
//  ⚠️ ZAMKE PRI EDITOVANJU DOKUMENTA:
//     - Kolona 0 mora sadržati pravi @mention (ne samo tekst imena), inače
//       regex ne nađe user ID i CEO RED se tiho ignoriše.
//     - Redovi zaglavlja se preskaču tako što se filtrira reč "Profil" —
//       ako preimenuješ prvu kolonu, zaglavlje će biti parsirano kao osoba.
//     - Telefon bez "+" i pozivnog broja = Twilio odbija poziv.
//
//  Vraća tri mape:
//    phoneMap[clickupId] -> telefon        (za TEAM_LEADS i CTO)
//    nameMap[clickupId]  -> ime i prezime  (za TEAM_LEADS i CTO)
//    folderMap[folderId] -> NIZ developera (za Tier 1, po projektu)
//
//  Ako čitanje padne, vraća prazne mape — lanac tada ostane bez telefona i
//  incident prođe bez poziva, pa greška "❌ Error reading Phone Directory"
//  u logu je kritična i traži hitnu reakciju.
// -----------------------------------------------------------------------------
async function getPhoneDirectory() {
  try {
    // ⚠️ 9014871034 je Flow Ninja ClickUp WORKSPACE (team) ID — hardkodovan.
    //    Menja se samo ako se ceo workspace menja. Ovo je ClickUp API v3
    //    (docs endpoint živi samo na v3; taskovi niže koriste v2).
    const response = await axios.get(
      `https://api.clickup.com/api/v3/workspaces/9014871034/docs/${CLICKUP_PHONE_DOC_ID}/pages/${CLICKUP_PHONE_PAGE_ID}`,
      { headers: { Authorization: CLICKUP_API_KEY } }
    );
    const content = response.data.content;
    const phoneMap = {};
    const folderMap = {};
    const nameMap = {};

    // Dijagnostika: prvih 600 karaktera sirovog sadržaja dokumenta. Ovo je
    // najbrži način da se vidi da li ClickUp uopšte vraća tabelu i u kom
    // obliku vraća @mention (od toga zavisi regex ispod).
    console.log(
      "📄 Phone Directory raw content (first 600 chars):\n" +
        String(content || "").slice(0, 600)
    );

    // Zadrži samo redove tabele: počinju sa "|", nisu separator "---",
    // i nisu zaglavlje (prepoznaje se po reči "Profil").
    const rows = content.split("\n").filter(row => row.trim().startsWith("|") && !row.includes("---") && !row.includes("Profil"));
    console.log(`📄 Table rows found: ${rows.length}`);

    for (const row of rows) {
      // ⚠️ NE koristi filter(Boolean) ovde! Prazna ćelija je legitimna
      //    (npr. team lead bez Folder ID-ja), a filter(Boolean) je izbaci i
      //    POMERI sve kolone ulevo — telefon bi postao Folder ID i obrnuto.
      //    Zato se skidaju samo vodeći i završni "|", pa se deli, a prazne
      //    ćelije unutar reda se ČUVAJU da kolone ostanu poravnate.
      const cells = row
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map(c => c.trim());

      // Potpuno prazan red u tabeli (ClickUp ih drži kao rezervu) — preskoči.
      if (cells.every(c => c === "")) continue;

      if (cells.length < 3) {
        console.warn(`⚠️ Skipped row (needs at least 3 columns): ${row.trim()}`);
        continue;
      }

      const profileCell = cells[0];
      const fullName = cells[1];
      const phone = cells[2];
      // Kolona sa folderima je opciona — osoba bez foldera je i dalje
      // dostupna kao team lead / CTO preko phoneMap, samo nije Tier 1.
      const folderIds = cells[3] ? cells[3].split(",").map(id => id.trim()).filter(Boolean) : [];
      // Iz @mention-a ClickUp vraća oblik "user_mention#42457090".
      const match = profileCell.match(/user_mention#(\d+)/);

      if (!match) {
        // Najčešći uzrok: u prvoj koloni je OBIČAN TEKST, ne pravi @mention.
        console.warn(
          `⚠️ Skipped row for "${fullName}": no @mention found in first column ` +
            `(got: "${profileCell}")`
        );
        continue;
      }

      const clickupId = match[1];

      // Telefon je OBAVEZAN za svakoga (i za team leada i za CTO-a) —
      // bez njega se taj nivo eskalacije preskače.
      if (!phone) {
        console.warn(
          `⚠️ "${fullName}" (ID ${clickupId}) has NO phone number — this person will be skipped when calling.`
        );
      }

      phoneMap[clickupId] = phone;
      nameMap[clickupId] = fullName;

      // Jedan folder MOŽE imati više developera — svi se skupljaju u
      // niz i svi postaju Tier 1 (redosled nije bitan, vidi
      // buildEscalationChain). Upiši istog Folder ID kod više ljudi
      // u Phone Directory tabeli i svi će biti zvani u prvom krugu.
      for (const folderId of folderIds) {
        if (!folderMap[folderId]) folderMap[folderId] = [];
        folderMap[folderId].push({ clickupId, phone, name: fullName });
      }
    }

    console.log("📋 Phone Directory loaded:", phoneMap);
    console.log("📋 Folder Map loaded:", folderMap);
    return { phoneMap, folderMap, nameMap };
  } catch (err) {
    console.error("❌ Error reading Phone Directory:", err.message);
    return { phoneMap: {}, folderMap: {}, nameMap: {} };
  }
}

// -----------------------------------------------------------------------------
//  getFolderInfo(folderId)
// -----------------------------------------------------------------------------
//  Jedan ClickUp poziv koji nam daje dve stvari koje su nam obe potrebne:
//    spaceName -> da nađemo team leada u TEAM_LEADS (Tier 2)
//    lists     -> da nađemo u koju listu ide task (vidi resolveListId)
//  Namerno spojeno u jedan zahtev da ne trošimo dva API poziva na isti folder.
//  Ako padne, vraća prazno -> Tier 2 se preskoči i lista se ne razreši.
// -----------------------------------------------------------------------------
async function getFolderInfo(folderId) {
  try {
    const response = await axios.get(
      `https://api.clickup.com/api/v2/folder/${folderId}`,
      { headers: { Authorization: CLICKUP_API_KEY } }
    );
    return {
      spaceName: response.data.space?.name || null,
      lists: Array.isArray(response.data.lists) ? response.data.lists : [],
    };
  } catch (err) {
    console.error("❌ Error getting folder info:", err.message);
    return { spaceName: null, lists: [] };
  }
}

// -----------------------------------------------------------------------------
//  resolveListId(lists, folderId)
// -----------------------------------------------------------------------------
//  ⚠️ RUČNO (D) — ODLUČUJE U KOJU CLICKUP LISTU IDE TASK.
//
//  Konvencija: svaki projektni folder treba da ima listu pod imenom
//  "Incidents". Tako ne mora da se održava mapiranje po projektu — samo
//  napraviš listu sa tim imenom u ClickUp-u i radi.
//
//  Redosled odlučivanja (fallback lanac):
//    1. lista u folderu čije ime je == CLICKUP_INCIDENT_LIST_NAME
//       (env varijabla, default "Incidents"; poredi se case-insensitive)
//    2. ako te liste nema -> PRVA lista u folderu (loguje ⚠️ warning)
//    3. ako folder nema nijednu listu -> env CLICKUP_DEFAULT_LIST_ID
//    4. ako ni to nije postavljeno -> null, task se NE pravi
//       (createClickUpTask baca jasnu grešku)
//
//  ⚠️ Korak 2 je namerno "tih" fallback da incident nikad ne propadne zbog
//     administracije, ALI znači da task može da završi u pogrešnoj listi.
//     Zato posle dodavanja klijenta proveri log liniju:
//       📁 Folder <id>: koristim listu "Incidents" (<listId>)
//     Ako vidiš ⚠️ umesto 📁 — nedostaje "Incidents" lista u tom folderu.
//
//  Preporuka: postavi CLICKUP_DEFAULT_LIST_ID na neku "Incidents – Uncategorized"
//  listu, da task uvek ima gde da padne i ništa se ne izgubi.
// -----------------------------------------------------------------------------
function resolveListId(lists, folderId) {
  const wanted = (process.env.CLICKUP_INCIDENT_LIST_NAME || "Incidents").toLowerCase();

  if (lists.length > 0) {
    const named = lists.find(l => (l.name || "").toLowerCase() === wanted);
    if (named) {
      console.log(`📁 Folder ${folderId}: using list "${named.name}" (${named.id})`);
      return named.id;
    }
    console.warn(
      `⚠️ Folder ${folderId}: no list named "${wanted}", falling back to first list "${lists[0].name}" (${lists[0].id})`
    );
    return lists[0].id;
  }

  const fallback = process.env.CLICKUP_DEFAULT_LIST_ID || null;
  console.warn(`⚠️ Folder ${folderId}: has no lists at all, falling back to CLICKUP_DEFAULT_LIST_ID=${fallback}`);
  return fallback;
}

// -----------------------------------------------------------------------------
//  INCIDENT_PRIORITY — ClickUp priority za SVE incidente
// -----------------------------------------------------------------------------
//  Polje "Severity" je izbačeno iz forme, pa nema više po čemu da se priority
//  razlikuje od incidenta do incidenta. Svaki incident dobija istu vrednost.
//
//  ClickUp priority skala: 1 = Urgent, 2 = High, 3 = Normal, 4 = Low.
//  Postavljeno na 1 (Urgent) jer je po definiciji reč o incidentu koji je
//  digao ljude telefonom — tako taskovi vizuelno iskaču u ClickUp listi.
//
//  Ako želiš drugu vrednost, promeni SAMO ovaj broj (npr. 2 za High).
//  Ako ne želiš da se priority uopšte postavlja, stavi null — tada se polje
//  ne šalje i ClickUp koristi svoj default.
// -----------------------------------------------------------------------------
const INCIDENT_PRIORITY = 1;

// -----------------------------------------------------------------------------
//  FAJLOVI IZ SLACK FORME (video zapis + screenshotovi)
// -----------------------------------------------------------------------------
//  ⚠️ ZAŠTO OVO NIJE SAMO LINK U OPISU:
//     Fajlovi koje klijent uploaduje kroz Slack modal su PRIVATNI. Njihov
//     `url_private` link zahteva Slack token, pa ga ClickUp ne može otvoriti
//     ni prikazati — u opisu taska bi bila mrtva slika / mrtav link za svakoga
//     kome se task otvori bez Slack sesije.
//     Zato radimo dva koraka:
//       1. fajl se skine sa Slacka (sa bot tokenom) i UPLOADUJE na ClickUp task
//          kao pravi attachment -> vidljiv svima na tasku, trajno
//       2. u opis taska ide Slack permalink (koristan timu koji je u Slacku)
//
//  ⚠️ SLACK SCOPE: `file_input` element i skidanje fajlova zahtevaju
//     `files:read` scope na Slack app-u. Bez njega upload u formi radi ali
//     skidanje pada sa 403, i task ostane bez priloga (vidi log).
//  ⚠️ LIMITI: Slack file_input do 100 MB po fajlu; ClickUp attachment do 1 GB.
//  ⚠️ Zahteva Node 18+ (koristi globalni FormData i Blob). Railway to ima.
// -----------------------------------------------------------------------------

// Skida sadržaj jednog Slack fajla kao Buffer.
async function downloadSlackFile(file) {
  const url = file.url_private_download || file.url_private;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    responseType: "arraybuffer",
  });
  return Buffer.from(response.data);
}

// Prebacuje listu Slack fajlova na ClickUp task kao attachmente.
// Nikad ne baca grešku — task je važniji od priloga, pa se neuspeli fajl
// samo loguje i preskoči.
async function attachFilesToClickUpTask(taskId, files) {
  if (!taskId || !files || files.length === 0) return;

  for (const file of files) {
    try {
      const buffer = await downloadSlackFile(file);
      const form = new FormData();
      // ClickUp očekuje polje "attachment" u multipart/form-data zahtevu.
      // Content-Type sa boundary axios postavlja sam kad mu se da FormData —
      // NE postavljaj ga ručno, inače boundary fali i ClickUp vrati grešku.
      form.append(
        "attachment",
        new Blob([buffer], { type: file.mimetype || "application/octet-stream" }),
        file.name || "attachment"
      );

      await axios.post(
        `https://api.clickup.com/api/v2/task/${taskId}/attachment`,
        form,
        { headers: { Authorization: CLICKUP_API_KEY } }
      );

      console.log(`📎 Attached to task ${taskId}: ${file.name}`);
    } catch (err) {
      console.error(
        `❌ Error attaching file "${file.name}" to task ${taskId}:`,
        err.response?.data || err.message
      );
    }
  }
}

// -----------------------------------------------------------------------------
//  createClickUpTask(incident, person)
// -----------------------------------------------------------------------------
//  Pravi task u ClickUp-u. Poziva se SAMO kad neko potvrdi poziv sa "1".
//  (Ranije je ovaj korak radio Make webhook — Make je izbačen, sve ide odavde.)
//
//  person = osoba koja je potvrdila incident; ona postaje assignee.
//  Ako ta osoba nema clickupId, task se pravi BEZ assignee-a (ne pada).
// -----------------------------------------------------------------------------
async function createClickUpTask(incident, person) {
  // Bez liste nema gde da se napravi task — bacamo grešku sa folderom u
  // tekstu da se u logu odmah vidi koji projekat nije podešen.
  if (!incident.listId) {
    throw new Error(`No ClickUp list resolved for incident ${incident.id} (folder ${incident.folderId})`);
  }

  // Opis taska. `markdown_description` (ne `description`) je ClickUp polje
  // koje renderuje markdown — zato **bold** radi.
  const lines = [
    `**Incident ID:** ${incident.id}`,
    `**Reported by (Slack):** ${incident.user}`,
    `**Acknowledged by:** ${person?.name || "N/A"}`,
    `**Created:** ${incident.createdAt}`,
    ``,
    `**Description:**`,
    incident.description || "No description",
  ];

  // Video zapis (opciono). Permalink je koristan timu u Slacku; sam fajl se
  // posle dodaje kao attachment na task (vidi attachFilesToClickUpTask).
  if (incident.videoFiles?.length > 0) {
    lines.push(``, `**Video record:**`);
    for (const f of incident.videoFiles) {
      lines.push(`- [${f.name || "video"}](${f.permalink})`);
    }
  }

  // Screenshotovi (opciono, može ih biti više).
  if (incident.screenshotFiles?.length > 0) {
    lines.push(``, `**Screenshots (${incident.screenshotFiles.length}):**`);
    for (const f of incident.screenshotFiles) {
      lines.push(`- [${f.name || "screenshot"}](${f.permalink})`);
    }
  }

  if (incident.videoFiles?.length > 0 || incident.screenshotFiles?.length > 0) {
    lines.push(``, `_Files are also uploaded as attachments on this task._`);
  }

  const markdown_description = lines.join("\n");

  const body = {
    // Ime taska = "Incident name" koje je klijent uneo u formu.
    // Fallback postoji samo za slučaj da polje nekako dođe prazno.
    name: incident.name || `Incident ${incident.id}`,
    markdown_description,
  };

  // Priority se šalje samo ako je INCIDENT_PRIORITY postavljen (nije null).
  if (INCIDENT_PRIORITY !== null) {
    body.priority = INCIDENT_PRIORITY;
  }

  // ⚠️ ClickUp očekuje assignees kao niz BROJEVA, a user ID-jevi se kroz
  //    ceo ovaj fajl vuku kao stringovi (iz regexa / TEAM_LEADS) — zato Number().
  if (person?.clickupId) {
    body.assignees = [Number(person.clickupId)];
  }

  // Napomena: v2 endpoint za taskove (Phone Directory gore koristi v3).
  const response = await axios.post(
    `https://api.clickup.com/api/v2/list/${incident.listId}/task`,
    body,
    {
      headers: {
        Authorization: CLICKUP_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );

  console.log(`✅ ClickUp task created for ${incident.id}: ${response.data?.id}`);
  return response.data; // { id, url, ... }
}

// -----------------------------------------------------------------------------
//  buildEscalationChain(channelId)
// -----------------------------------------------------------------------------
//  Od Slack kanala pravi listu ljudi koje treba zvati, po redu.
//
//  ⚠️ RUČNO (A) — MAPIRANJE SLACK KANAL -> CLICKUP FOLDER
//  ---------------------------------------------------------------------------
//  Radi se preko Railway env varijabli po konvenciji imena:
//
//      IME:      SLACK_CHANNEL_<bilo koji opis>_<SLACK_CHANNEL_ID>
//      VREDNOST: <ClickUp FOLDER ID tog projekta>
//
//    Primer (postojeći):
//      SLACK_CHANNEL_inc_client_test_C0AC5VCLAG2 = 90141234567
//
//  Kako se traži: uzima se prva env varijabla koja počinje sa
//  "SLACK_CHANNEL_" i čije ime SADRŽI ID kanala. Zato deo pre ID-ja može biti
//  šta god ti je čitljivo — samo ID mora biti tačan.
//
//  KAKO DODATI NOVOG KLIJENTA (3 koraka):
//    1. U Slacku: uzmi Channel ID (Channel details -> dole "Channel ID",
//       oblik C0ABC123DEF).
//    2. U ClickUp-u: uzmi Folder ID projekta (otvori folder, ID je u URL-u)
//       i napravi u njemu listu "Incidents".
//    3. U Railway-u: dodaj varijablu SLACK_CHANNEL_<ime>_<CHANNEL_ID> sa
//       vrednošću Folder ID. Railway se sam redeployuje.
//    + Ne zaboravi developera: njegov red u Phone Directory dokumentu mora
//      imati taj isti Folder ID u koloni "Folder ID-jevi" (inače nema Tier 1).
//
//  ⚠️ ZAMKE:
//    - ID kanala je case-sensitive i mora biti TAČAN. Ako fali mapiranje,
//      funkcija vraća null i incident ne pokrene NIJEDAN poziv (log:
//      "❌ No mapping for channel ..."). Slack poruka se i dalje pošalje,
//      pa izgleda kao da radi — obavezno proveri log posle dodavanja.
//    - Ako dva imena varijabli sadrže isti ID, koristi se prvo nađeno.
//
//  Vraća { chain, folderId, listId } ili null ako kanal nije mapiran.
// -----------------------------------------------------------------------------
async function buildEscalationChain(channelId) {
  console.log(`🔍 Building escalation chain for channel: ${channelId}`);
  // Ovaj log ispisuje SVE SLACK_CHANNEL_* varijable — najkorisnija stvar za
  // debug kad neki kanal "ne radi": vidiš odmah da li mapiranje postoji.
  console.log(`🔍 All env vars with SLACK_CHANNEL:`, Object.keys(process.env).filter(k => k.startsWith("SLACK_CHANNEL_")));

  const envVar = Object.keys(process.env).find(
    key => key.startsWith("SLACK_CHANNEL_") && key.includes(channelId)
  );
  const folderId = envVar ? process.env[envVar] : null;

  console.log(`🔍 Found env var: ${envVar} → folder: ${folderId}`);

  if (!folderId) {
    console.error(`❌ No mapping for channel ${channelId}`);
    return null;
  }

  // Čita se pri SVAKOM incidentu (namerno) — promena telefona u ClickUp
  // dokumentu odmah stupa na snagu, bez redeploya.
  const { phoneMap, folderMap, nameMap } = await getPhoneDirectory();

  // Svi developeri upisani na ovaj folder (može ih biti 2+).
  const developers = folderMap[folderId] || [];
  console.log(`👤 Developers for folder ${folderId} (${developers.length}):`, developers);

  const { spaceName, lists } = await getFolderInfo(folderId);
  console.log("🏢 Space:", spaceName);

  // U koju listu ide task kad neko potvrdi (vidi resolveListId).
  const listId = resolveListId(lists, folderId);

  // Space ime -> team lead. Ako se ime Space-a ne nalazi u TEAM_LEADS,
  // teamLead je undefined i Tier 2 se preskače (ide se pravo na CTO).
  const teamLead = spaceName ? TEAM_LEADS[spaceName] : null;
  const cto = CTO;
  const chain = [];

  // Tier 1 — Developeri (može ih biti više)
  // Redosled unutar Tier 1 NIJE bitan — zovu se jedan po jedan, u onom
  // redosledu u kom su upisani u Phone Directory tabeli. Bitno je samo da
  // SVI developeri prođu pre nego što se pređe na team leada.
  // Ako nema ni jednog developera za projekat, lanac počinje od team leada.
  for (const developer of developers) {
    chain.push({
      name: developer.name,
      phone: developer.phone,
      clickupId: developer.clickupId,
      tier: 1,
    });
  }

  // Tier 2 — Team Lead
  // Telefon i ime se traže u Phone Directory po clickupId iz TEAM_LEADS.
  // Ako clickupId nije upisan (null), phone ostaje null -> escalateCall
  // preskoči ovaj nivo, ali ga svejedno dodajemo u lanac radi logovanja.
  if (teamLead) {
    const phone = teamLead.clickupId ? phoneMap[teamLead.clickupId] : null;
    const name = teamLead.clickupId ? nameMap[teamLead.clickupId] : teamLead.name;
    chain.push({
      name: name || teamLead.name,
      phone: phone || null,
      clickupId: teamLead.clickupId || null,
      tier: 2,
    });
  }

  // Tier 3 — CTO
  // Uvek se dodaje, bez uslova — poslednja instanca za svaki projekat.
  const ctoPhone = cto.clickupId ? phoneMap[cto.clickupId] : null;
  const ctoName = cto.clickupId ? nameMap[cto.clickupId] : cto.name;
  chain.push({
    name: ctoName || cto.name,
    phone: ctoPhone || null,
    clickupId: cto.clickupId || null,
    tier: 3,
  });

  // Ovaj log je "zlatni" za debug — pokazuje tačno koga će sistem zvati i
  // ko nema telefon (phone: null).
  console.log("✅ Final escalation chain:", JSON.stringify(chain));
  return { chain, folderId, listId };
}

// -----------------------------------------------------------------------------
//  escalateCall(incidentId, tierIndex)
// -----------------------------------------------------------------------------
//  Zove osobu na poziciji `tierIndex` u lancu. Rekurzivna je: svaki način na
//  koji poziv "ne uspe" poziva samu sebe sa tierIndex + 1.
//
//  Tri načina da se eskalira na sledeći nivo:
//    1. osoba nema telefon               -> odmah, bez zvonjave
//    2. Twilio odbije poziv (greška)     -> odmah
//    3. ne javi se / odbije / ne pritisne 1 u 2 minuta -> preko timera ispod
//       (+ /twilio/status hvata no-answer / busy / failed i pre isteka timera)
//
//  Lanac se "istroši" kad tierIndex pređe dužinu lanca — tada niko nije
//  potvrdio u ovom krugu, pa scheduleNextRound zakazuje PONOVNI krug od
//  Tier 1. Tako se zvonjava ponavlja dok neko ne pritisne 1.
//  Log "Tier X did not confirm" + "ceo lanac je pozvan bez potvrde" su
//  normalni koraci, ne greške.
// -----------------------------------------------------------------------------
//  postToSlack(channel, text)
// -----------------------------------------------------------------------------
//  Mali helper za poruke u Slack. Nikad ne baca grešku — ako Slack padne,
//  samo se loguje, jer nijedan Slack problem ne sme da prekine tok incidenta.
//
//  ⚠️ Slack chat.postMessage na grešku vraća HTTP 200 sa telom
//     { ok: false, error: "..." } — axios to NE tretira kao grešku i catch se
//     ne aktivira. Zato se `ok` proverava ručno; bez toga bi poruke tiho
//     padale (npr. channel_not_found, not_in_channel, invalid_auth) a u logu
//     ne bi bilo ničega.
//
//  ⚠️ Nema fallback kanala. Ako channel nije poznat, poruka se NE šalje nego
//     se loguje — slanje u hardkodovan kanal je nekad išlo na "#inc-client-test",
//     ali takav kanal može biti obrisan/preimenovan i poruka bi otišla u prazno.
//     Opciono: postavi env INCIDENT_FALLBACK_CHANNEL (ID kanala) da poruke bez
//     poznatog kanala imaju gde da padnu.
// -----------------------------------------------------------------------------
async function postToSlack(channel, text) {
  const target = channel || process.env.INCIDENT_FALLBACK_CHANNEL;

  if (!target) {
    console.error("❌ postToSlack: unknown channel, message not sent:", text);
    return;
  }

  try {
    const response = await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel: target, text },
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.data?.ok) {
      console.error(
        `❌ Slack rejected message for channel ${target}:`,
        response.data?.error
      );
    }
  } catch (err) {
    console.error("Error posting to Slack:", err.response?.data || err.message);
  }
}

// -----------------------------------------------------------------------------
//  scheduleNextRound(incidentId)
// -----------------------------------------------------------------------------
//  Poziva se kad ceo lanac (svi developeri + team lead + CTO) prođe a NIKO
//  nije pritisnuo 1. Zakazuje NOVI KRUG od početka lanca.
//
//  Ponavlja se dok neko ne potvrdi — to je i bila namera: incident ne sme
//  da "propadne" u tišini.
//
//  Podešavanja (Railway env, oba opciona):
//    INCIDENT_ROUND_PAUSE_MS  pauza između krugova u ms. Default 300000 (5 min).
//                             ⚠️ Ne stavljaj premalo — bez pauze ljudima zvoni
//                             telefon bez prestanka i Twilio račun raste.
//    INCIDENT_MAX_ROUNDS      maksimalan broj krugova. Default 0 = NEOGRANIČENO
//                             (zvoni dok se neko ne javi).
//                             ⚠️ Preporuka: postavi neku vrednost (npr. 10).
//                             Sa 0, zaboravljen TEST incident zvoni ljude u
//                             krug dok se servis ne restartuje.
//
//  ⚠️ BEZBEDNOSNA PROVERA: ako NIKO u lancu nema telefon, krugovi se NE
//     ponavljaju. Bez ovoga bi se sistem vrtio zauvek u prazno (svaki nivo se
//     preskoči -> lanac se istroši -> novi krug -> isto), trošeći log i
//     ne zoveći nikoga. U tom slučaju ide glasan alarm u Slack.
// -----------------------------------------------------------------------------
function scheduleNextRound(incidentId) {
  const incident = activeIncidents[incidentId];
  if (!incident || incident.acknowledged) return;

  const chain = incident.escalationChain || [];

  // Ako niko nema broj, ponavljanje je besmisleno — prekini i javi.
  if (!chain.some(p => p.phone)) {
    console.error(
      `❌ Incident ${incidentId}: NOBODY in the escalation chain has a phone number — stopping retries!`
    );
    postToSlack(
      incident.channel,
      `🆘 *Incident ${incidentId} — NOBODY WAS CALLED*\n` +
        `No one in the escalation chain has a phone number in the Phone Directory document.\n` +
        `Retries have been stopped. *Please respond manually.*`
    );
    return;
  }

  const maxRounds = parseInt(process.env.INCIDENT_MAX_ROUNDS || "0", 10);
  const pauseMs = parseInt(process.env.INCIDENT_ROUND_PAUSE_MS || "300000", 10);

  incident.round = (incident.round || 1) + 1;

  // maxRounds = 0 znači neograničeno, pa se ovaj uslov nikad ne aktivira.
  if (maxRounds > 0 && incident.round > maxRounds) {
    console.error(
      `❌ Incident ${incidentId}: reached the limit of ${maxRounds} rounds, stopping.`
    );
    postToSlack(
      incident.channel,
      `🆘 *Incident ${incidentId} — NO ANSWER*\n` +
        `${maxRounds} rounds of calls completed without acknowledgement. Retries have been stopped.\n` +
        `*Please respond manually.*`
    );
    return;
  }

  const pauseMin = Math.round(pauseMs / 60000);
  console.log(
    `🔁 Incident ${incidentId}: round ${incident.round - 1} ended without acknowledgement. ` +
      `Round ${incident.round} starts in ${pauseMs} ms.`
  );

  postToSlack(
    incident.channel,
    `🔁 *Incident ${incidentId} — no answer yet*\n` +
      `Restarting calls from the top (round ${incident.round}) in ~${pauseMin} min.`
  );

  // Timer se pamti na incidentu da bi se otkazao na potvrdu (u /twilio/gather).
  incident.roundTimer = setTimeout(() => {
    if (!activeIncidents[incidentId]?.acknowledged) {
      escalateCall(incidentId, 0);
    }
  }, pauseMs);
}

async function escalateCall(incidentId, tierIndex = 0) {
  const incident = activeIncidents[incidentId];
  if (!incident) {
    // Najčešći uzrok: servis je restartovan/redeployovan dok je incident bio
    // aktivan, pa je in-memory zapis izgubljen (vidi activeIncidents gore).
    console.error(`❌ Incident ${incidentId} not found!`);
    return;
  }

  const chain = incident.escalationChain;

  // Lanac istrošen = niko u ovom krugu nije potvrdio -> zakaži NOVI KRUG
  // od početka (Tier 1). Ovo je ono "ponavljati proces ispočetka".
  if (!chain || tierIndex >= chain.length) {
    console.log(
      `⚠️ Incident ${incidentId}: entire chain called without acknowledgement (round ${incident.round || 1}).`
    );
    scheduleNextRound(incidentId);
    return;
  }

  const person = chain[tierIndex];
  const tierName = `Tier ${person.tier}`;

  // Nema broja u Phone Directory -> preskoči nivo (ovo je ono "ukoliko nema
  // broj za tu osobu ovaj korak se preskače" iz specifikacije).
  if (!person.phone) {
    console.error(`❌ ${person.name} has no phone number in Phone Directory!`);
    escalateCall(incidentId, tierIndex + 1);
    return;
  }

  console.log(`📞 Calling ${tierName} — ${person.name}: ${person.phone}`);

  try {
    const call = await twilioClient.calls.create({
      to: person.phone,
      from: TWILIO_FROM_NUMBER,
      // Twilio pozove OVAJ URL kad se poziv javi, da dobije šta da izgovori.
      // incidentId i tier idu kao query da bismo znali kontekst u handleru.
      url: `${RAILWAY_URL}/twilio/voice?incidentId=${incidentId}&tier=${tierIndex}`,
      // Twilio ovde javlja ISHOD poziva (javljeno / ne javlja se / zauzeto).
      statusCallback: `${RAILWAY_URL}/twilio/status?incidentId=${incidentId}&tier=${tierIndex}`,
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
      // Koliko sekundi zvoni pre nego što Twilio odustane (no-answer).
      timeout: 30,
    });

    console.log(`✅ Call initiated for ${tierName}: ${call.sid}`);
    activeIncidents[incidentId].callSid = call.sid;
    activeIncidents[incidentId].currentTier = tierIndex;

    // ⚠️ SIGURNOSNI TIMER: 120000 ms = 2 minuta.
    //    Pokriva slučaj kad se čovek javi ali NE pritisne 1 (npr. javio se
    //    pa prekinuo, ili je poziv otišao na govornu poštu koja "prihvati"
    //    poziv). Bez ovoga bi lanac stao na tom nivou.
    //    Ako menjaš ovu vrednost: mora biti veća od `timeout: 30` iznad,
    //    inače eskalira dok telefon još zvoni.
    //    Timer se briše (clearTimeout) na potvrdu u /twilio/gather.
    activeIncidents[incidentId].escalationTimer = setTimeout(() => {
      if (!activeIncidents[incidentId]?.acknowledged) {
        console.log(`⏰ ${tierName} did not confirm, escalating...`);
        escalateCall(incidentId, tierIndex + 1);
      }
    }, 120000);

  } catch (err) {
    // Npr. nevažeći broj, nepokriven region, potrošen Twilio kredit.
    console.error(`❌ Twilio error for ${tierName}:`, err.message);
    escalateCall(incidentId, tierIndex + 1);
  }
}

// =============================================================================
//  TWILIO WEBHOOK ENDPOINTS
//  ⚠️ Ova tri endpointa ne poziva čovek nego Twilio. URL-ovi se grade iz
//     RAILWAY_URL u escalateCall — ako preimenuješ rute, promeni ih i tamo.
// =============================================================================

// -----------------------------------------------------------------------------
//  POST/GET /twilio/voice — šta se izgovara kad se osoba javi
// -----------------------------------------------------------------------------
//  Vraća TwiML (XML) koji Twilio "odigra" na liniji.
//  <Gather numDigits="1"> čeka jedan taster i onda poziva /twilio/gather.
//
//  ⚠️ Tekst je na engleskom (voice="alice", language="en-US") i čita se
//     naglas — uključujući OPIS koji je klijent uneo u Slack formu.
//  ⚠️ U TwiML-u & mora biti escape-ovan kao &amp; (zato "&amp;tier=") —
//     inače Twilio ne uspe da parsira XML i poziv se prekine.
//  ⚠️ app.all (ne app.post) je namerno: Twilio zna da pogodi i GET-om.
// -----------------------------------------------------------------------------
app.all("/twilio/voice", (req, res) => {
  const { incidentId, tier } = req.query;
  const incident = activeIncidents[incidentId];
  const chain = incident?.escalationChain;
  const person = chain?.[parseInt(tier)];
  const tierName = person ? `Tier ${person.tier}` : `Tier ${parseInt(tier) + 1}`;

  // Fallback vrednosti postoje da poziv ne bi pukao ako je incident izgubljen
  // iz memorije (restart) — čovek će čuti "Unknown" umesto tišine.
  const description = incident?.description || "No description";
  const name = incident?.name || "Unnamed incident";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" action="${RAILWAY_URL}/twilio/gather?incidentId=${incidentId}&amp;tier=${tier}" method="POST" timeout="10"><Say voice="alice" language="en-US">Alert. New incident reported. ${name}. Description ${description}. This is ${tierName} escalation. Press 1 to acknowledge and take ownership of this incident.</Say></Gather><Say voice="alice">No input received. Escalating to next tier.</Say></Response>`;

  res.type("text/xml");
  res.send(twiml);
});

// -----------------------------------------------------------------------------
//  POST/GET /twilio/gather — obrada pritisnutog tastera
// -----------------------------------------------------------------------------
//  OVO JE NAJVAŽNIJI DEO FLOW-A: pritisak na "1" = preuzimanje incidenta.
//  Kad se to desi, redom:
//    1. incident se markira kao acknowledged i timer se otkazuje
//       (time se zaustavlja dalja eskalacija)
//    2. napravi se ClickUp task (ranije je ovo radio Make)
//    3. u Slack ide potvrda + link ka tasku
//    4. čoveku na liniji se izgovori "thank you"
//
//  Bilo koji drugi taster (ili ništa) -> eskalacija na sledeći nivo.
// -----------------------------------------------------------------------------
app.all("/twilio/gather", async (req, res) => {
  const { incidentId, tier } = req.query;
  // Twilio pošalje Digits u body-ju (POST); query je fallback za GET.
  const digit = req.body?.Digits || req.query?.Digits;
  const incident = activeIncidents[incidentId];
  const chain = incident?.escalationChain;
  // person = ko je javio se na ovom nivou; on postaje assignee taska.
  const person = chain?.[parseInt(tier)];

  if (digit === "1" && incident) {
    // Ovaj flag gasi i timer proveru i /twilio/status eskalaciju.
    incident.acknowledged = true;
    clearTimeout(incident.escalationTimer);
    // ⚠️ Bitno: otkazuje i zakazani NOVI KRUG poziva. Bez ovoga bi ljudima
    //    ponovo zvonio telefon i posle uspešne potvrde.
    clearTimeout(incident.roundTimer);

    console.log(`✅ Incident ${incidentId}: ${person?.name} acknowledged!`);

    // Napravi task direktno u ClickUp-u (bez Make-a)
    // ⚠️ Greška se hvata i SAMO loguje — namerno. Ako ClickUp padne, poziv
    //    ostaje potvrđen i eskalacija se ne nastavlja (ne želimo da budimo
    //    CTO-a zato što je ClickUp API imao 500). Task se u tom slučaju
    //    pravi ručno; u Slack poruci tada nema linka ka tasku.
    let taskUrl = null;
    try {
      const task = await createClickUpTask(incident, person);
      taskUrl = task?.url || null;
      incident.clickupTaskId = task?.id || null;

      // Prilozi (video + screenshotovi) se dodaju POSLE kreiranja taska,
      // jer ClickUp attachment endpoint traži task ID.
      await attachFilesToClickUpTask(incident.clickupTaskId, [
        ...(incident.videoFiles || []),
        ...(incident.screenshotFiles || []),
      ]);
    } catch (err) {
      console.error(
        "❌ Error creating ClickUp task:",
        err.response?.data || err.message
      );
    }

    // Slack poruka
    await postToSlack(
      incident.channel,
      `✅ *Incident acknowledged!*\n` +
        `*Incident ID:* ${incidentId}\n` +
        `*Acknowledged by:* ${person?.name || "N/A"}\n` +
        `*Status:* 🟡 In Progress` +
        (taskUrl ? `\n*ClickUp task:* ${taskUrl}` : ``)
    );

    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Thank you. You have acknowledged the incident. Please check Slack for details. Good luck.</Say></Response>`;
    res.type("text/xml");
    res.send(twiml);
  } else {
    // Pogrešan taster: prvo odgovori Twiliju (da se poruka izgovori), pa
    // onda pokreni sledeći nivo.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Invalid input. Escalating to next tier.</Say></Response>`;
    res.type("text/xml");
    res.send(twiml);
    escalateCall(incidentId, parseInt(tier) + 1);
  }
});

// -----------------------------------------------------------------------------
//  POST /twilio/status — ishod poziva (Twilio status callback)
// -----------------------------------------------------------------------------
//  Ovo je "brzi put" za eskalaciju: kad Twilio javi da se čovek NIJE javio,
//  da je zauzet ili da je poziv pao, ne čekamo 2-minutni timer nego odmah
//  zovemo sledećeg.
//  ⚠️ Uslov !incident?.acknowledged je bitan: status "completed" dolazi i
//     posle USPEŠNE potvrde, i bez te provere bi sistem zvao sledeći nivo
//     iako je incident već preuzet.
// -----------------------------------------------------------------------------
app.post("/twilio/status", (req, res) => {
  const { incidentId, tier } = req.query;
  const callStatus = req.body.CallStatus;
  const incident = activeIncidents[incidentId];
  const chain = incident?.escalationChain;
  const person = chain?.[parseInt(tier)];

  console.log(`📋 Incident ${incidentId} ${person?.name || "Tier " + (parseInt(tier) + 1)} status: ${callStatus}`);

  if (
    !incident?.acknowledged &&
    (callStatus === "no-answer" || callStatus === "busy" || callStatus === "failed")
  ) {
    clearTimeout(incident?.escalationTimer);
    escalateCall(incidentId, parseInt(tier) + 1);
  }

  // Twilio-u je dovoljan 200 — telo odgovora ga ne zanima.
  res.status(200).send();
});

// =============================================================================
//  SLACK ENDPOINTS
//  ⚠️ Oba URL-a se podešavaju u Slack App konfiguraciji (api.slack.com):
//     /slack/command      -> Slash Commands -> Request URL
//     /slack/interactions  -> Interactivity & Shortcuts -> Request URL
//     Ako se promeni RAILWAY_URL, OVA DVA URL-A SE MORAJU RUČNO PROMENITI
//     u Slack app-u — inače forma prestane da se otvara.
// =============================================================================

// -----------------------------------------------------------------------------
//  POST /slack/command — otvara modal formu za prijavu incidenta
// -----------------------------------------------------------------------------
//  Slack zahteva odgovor u roku od 3 sekunde, zato se prvo pošalje 200
//  (res.status(200).send()) a modal se otvara posle, preko views.open.
//
//  ⚠️ RUČNO — OPCIJE U FORMI SU HARDKODOVANE OVDE:
//     - Severity: P1 / P2 / P3
//       `value` mora da postoji u PRIORITY_MAP (gore), inače ClickUp
//       priority tiho padne na Normal.
//     - Incident Type: Layout / JS / Forms
//       Slobodno se dodaju nove opcije, nigde drugo se ne proverava —
//       vrednost se samo prepisuje u ime i opis taska.
//
//  ⚠️ private_metadata: channel_id — OVAKO se pamti iz kog je kanala forma
//     pokrenuta. To je jedini način da posle znamo koji je projekat
//     (Slack ne šalje kanal u view_submission payloadu). NE dirati.
// -----------------------------------------------------------------------------
app.post("/slack/command", async (req, res) => {
  const { trigger_id, channel_id } = req.body;
  // Prvi log koji mora da se pojavi kad se ukuca /incident. Ako ovoga NEMA
  // u Railway logu, Slack ne stiže do servera (pogrešan Request URL u Slack
  // app konfiguraciji, ili servis ne radi).
  console.log(
    `⚡ /incident invoked | channel: ${channel_id} | trigger_id: ${trigger_id ? "ok" : "MISSING"}`
  );
  res.status(200).send();

  try {
    const response = await axios.post(
      "https://slack.com/api/views.open",
      {
        // trigger_id važi samo ~3 sekunde od komande.
        trigger_id,
        view: {
          type: "modal",
          callback_id: "incident_modal",
          private_metadata: channel_id,
          title: { type: "plain_text", text: "New Incident" },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            // ⚠️ block_id i action_id se čitaju u /slack/interactions
            //    (values.name_block.name_action...). Ako ih preimenuješ
            //    ovde, MORAŠ i tamo — inače submit pukne.

            // Ime incidenta -> postaje IME TASKA u ClickUp-u.
            {
              type: "input",
              block_id: "name_block",
              label: { type: "plain_text", text: "Incident name" },
              element: {
                type: "plain_text_input",
                action_id: "name_action",
                placeholder: {
                  type: "plain_text",
                  text: "e.g. Contact form is not submitting data",
                },
              },
            },
            {
              type: "input",
              block_id: "desc_block",
              label: { type: "plain_text", text: "Description" },
              element: {
                type: "plain_text_input",
                action_id: "desc_action",
                multiline: true,
              },
            },

            // ⚠️ file_input zahteva `files:read` scope na Slack app-u.
            //    `optional: true` znači da klijent može da submituje bez fajla.
            //    Limit je 100 MB po fajlu (Slack ograničenje).
            //
            // ⚠️ NAMERNO BEZ `filetypes`. Ne dodavaj ga!
            //    Slack prihvata samo tačno određene stringove za tipove fajlova
            //    i odbija CEO modal sa "invalid_arguments" ako ijedan nije na
            //    njegovoj listi (greška: "unsupported filetype provided").
            //    Rezultat: forma se klijentu NE OTVORI, i to upravo u trenutku
            //    incidenta. Cena filtriranja je previsoka — bez `filetypes`
            //    Slack prihvata sve, a fajl se ionako prilaže tasku kakav je.
            //    Ako ti filtriranje ipak zatreba, prvo proveri svaki string
            //    protiv Slack liste tipova pa testiraj otvaranje modala.
            {
              type: "input",
              block_id: "video_block",
              optional: true,
              label: { type: "plain_text", text: "Video record (optional)" },
              element: {
                type: "file_input",
                action_id: "video_action",
                max_files: 1,
              },
            },
            {
              type: "input",
              block_id: "shots_block",
              optional: true,
              label: { type: "plain_text", text: "Screenshots (optional)" },
              element: {
                type: "file_input",
                action_id: "shots_action",
                // Više screenshotova je podržano — 10 je Slack maksimum.
                max_files: 10,
              },
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    // ⚠️ views.open na grešku vraća HTTP 200 sa { ok: false, error, ... }.
    //    axios to NE tretira kao grešku, pa catch ispod NIKAD ne bi opalio i
    //    modal bi se "tiho" ne otvarao. Zato se `ok` proverava ručno.
    //    response_metadata.messages sadrži tačan opis šta u blokovima ne štima.
    if (!response.data?.ok) {
      console.error("❌ views.open rejected:", response.data?.error);
      console.error(
        "❌ details:",
        JSON.stringify(response.data?.response_metadata || {})
      );
    } else {
      console.log("✅ Modal opened");
    }
  } catch (err) {
    // Najčešće: istekao trigger_id ili token bez scope-a.
    console.error("Error opening modal:", err.response?.data || err.message);
  }
});

// -----------------------------------------------------------------------------
//  POST /slack/interactions — submit forme, POČETAK INCIDENTA
// -----------------------------------------------------------------------------
//  Ovde se incident rađa: pročitaju se polja forme, izgradi se eskalacioni
//  lanac, incident se upiše u memoriju, pošalje se Slack najava i krene
//  prvi poziv.
//
//  ⚠️ Slack šalje payload kao STRING unutar form polja "payload" — zato
//     JSON.parse. Nije JSON body.
//  ⚠️ Odgovor { response_action: "clear" } zatvara modal. Mora da stigne
//     brzo, zato se šalje PRE Slack poruke i poziva.
// -----------------------------------------------------------------------------
app.post("/slack/interactions", async (req, res) => {
  const payload = JSON.parse(req.body.payload);

  if (payload.type === "view_submission") {
    // ⚠️ Putevi ispod moraju da odgovaraju block_id/action_id iz
    //    /slack/command modala.
    const values = payload.view.state.values;
    const name = values.name_block.name_action.value;
    const description = values.desc_block.desc_action.value;
    // file_input vraća niz Slack file objekata u `.files`. Polja su opciona,
    // pa kad klijent ne uploaduje ništa dobijamo prazan niz (ili undefined).
    const videoFiles = values.video_block?.video_action?.files || [];
    const screenshotFiles = values.shots_block?.shots_action?.files || [];
    const user = payload.user.name;
    // Kanal iz koga je forma pokrenuta (upisan u private_metadata) —
    // ovo je ključ za mapiranje na ClickUp projekat.
    const channel = payload.view.private_metadata;

    console.log(
      `📥 Incident submit: "${name}" | video: ${videoFiles.length} | screenshots: ${screenshotFiles.length}`
    );

    // ID incidenta = INC- + timestamp u ms. Jedinstven je u praksi i koristi
    // se kao ključ u activeIncidents i u query-jima ka Twiliju.
    const incidentId = `INC-${Date.now()}`;
    const result = await buildEscalationChain(channel);

    activeIncidents[incidentId] = {
      id: incidentId,
      // Ime iz forme -> ime taska u ClickUp-u.
      name,
      description,
      // Slack file objekti (id, name, mimetype, url_private, permalink...).
      videoFiles,
      screenshotFiles,
      user,
      channel,
      // Postaje true kad neko pritisne 1; gasi svaku dalju eskalaciju.
      acknowledged: false,
      // Brojač krugova poziva (vidi scheduleNextRound). Prvi krug = 1.
      round: 1,
      escalationChain: result?.chain || null,
      // Razrešena ClickUp lista (po folderu projekta). Poslednji fallback je
      // env CLICKUP_DEFAULT_LIST_ID — ako je i to prazno, task se ne pravi.
      listId: result?.listId || process.env.CLICKUP_DEFAULT_LIST_ID || null,
      folderId: result?.folderId || null,
      createdAt: new Date().toISOString(),
    };

    // Zatvori modal odmah (Slack ima kratak timeout).
    res.json({ response_action: "clear" });

    // Najava u kanalu — ide UVEK, čak i ako lanac ne postoji.
    // ⚠️ Zato prisustvo ove poruke NIJE dokaz da su pozivi krenuli;
    //    za to gledaj log.
    const fileNote = [
      videoFiles.length > 0 ? `🎥 ${videoFiles.length} video` : null,
      screenshotFiles.length > 0 ? `🖼️ ${screenshotFiles.length} screenshot(s)` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    await postToSlack(
      channel,
      `🚨 *New Incident — ${incidentId}*\n` +
        `*Name:* ${name}\n` +
        `*Reported by:* @${user}\n` +
        `*Description:* ${description}` +
        (fileNote ? `\n*Attachments:* ${fileNote}` : ``) +
        `\n\n_Initiating call escalation..._`
    );

    // Kreni od nivoa 0 (Tier 1). Namerno BEZ await — poziv i eskalacija
    // traju minutima, a HTTP odgovor je već poslat.
    if (result?.chain && result.chain.length > 0) {
      escalateCall(incidentId, 0);
    } else {
      // Najčešći uzrok: kanal nije mapiran na folder (vidi RUČNO (A)).
      console.error(`❌ Incident ${incidentId}: No escalation chain for channel ${channel}`);
    }

    return;
  }

  // Ostali tipovi interakcija (klik na dugme i sl.) se trenutno ne koriste.
  res.status(200).send();
});

// Health check — Railway ga koristi da proveri da li servis živi.
app.get("/", (req, res) => {
  res.status(200).send("Server is healthy ✅");
});

// ⚠️ Railway sam dodeljuje PORT preko env varijable — ne hardkoduj ga.
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
