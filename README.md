# Vault

A personal, encrypted store for photos, videos and documents. It runs as a web app installed
to your iPhone / iPad Home Screen or your Windows PC. There is no subscription, no account, no
server-side storage and no expiry.

## What it does

- **Import** photos and videos from your Photos library, and any file from the Files app
  (iCloud Drive, On My iPhone, OneDrive, Google Drive, USB drives…).
- **Encrypts everything on the device** before storing it. File contents, names, dates,
  thumbnails and folder names are all encrypted.
- **Folders**, nested as deep as you like. Create one with the folder button at the top, tap it
  to go inside, and use the path at the top (Vault › Holidays › 2025) to go back. Anything you
  add while inside a folder goes into it. **Select → Move** moves items or whole folders.
  Deleting a folder never deletes its contents; they move up one level. Search looks in every folder.
- **Quick selecting**: in Select mode, put a finger on a tile and slide sideways, then up or down,
  to select everything in between (like Photos). Hold near the top or bottom edge to keep going.
  Starting on a selected tile deselects instead. On the PC, drag with the mouse.
- **View inside the app**: photos, video and audio playback, PDFs (all pages), and text files.
  Other formats (Word, Excel, Pages…) can be opened in another app via "Save a copy".
- **Encrypted backup export**: `.pvault` files you can save anywhere. Large vaults are saved in
  parts of about 200 MB (an iPhone can't hold a whole multi-GB vault in memory); select all the
  parts together when importing. After a first full backup you can back up just the new items.
  Importing a backup merges it into a vault, which is also how you copy items between iPhone,
  iPad and PC.
- Auto-lock after inactivity, lock when the app is in the background for 30 seconds, and
  content hidden from the iOS app-switcher preview.
- Works fully offline. A Content Security Policy blocks the app from connecting anywhere
  except its own files.

## Working offline

The internet is needed only to install the app and to receive updates. Everything else is on the device:

- **The app itself** is saved by a service worker the first time it opens, so it starts with no connection.
- **Your files** live in the device's own storage (IndexedDB), not online.
- **Encryption** uses the device's built-in crypto, so there's no server to contact.

Exception: photos kept only in iCloud ("Optimise iPhone Storage") or Files items not yet
downloaded need a connection while the picker fetches them. Once imported, they're on the device.

## Security design

| Piece | How |
|---|---|
| Passphrase → key | PBKDF2-SHA256, 600,000 iterations, random 16-byte salt |
| Master key | Random 256-bit AES key, wrapped (AES-256-GCM) by the passphrase key, non-extractable in memory |
| Data | AES-256-GCM, 4 MB chunks, fresh random IV per chunk, each chunk bound to its file id and position |
| Backups | Copy of the encrypted records + wrapped key. Protected by the passphrase at time of export |

There is **no recovery**. If you forget the passphrase, nobody (including you) can decrypt the
vault or its backups.

## Putting it online (one-time, free)

The app has to be served over HTTPS to install on an iPhone. Any free static host works. Pick
one and keep using that address, because each web address has its own separate storage.

**Option A: Cloudflare Pages (drag and drop, no Git needed)**
1. Create a free Cloudflare account, then go to *Workers & Pages → Create → Pages → Upload assets*.
2. Name the project (e.g. `my-vault-xyz`) and drag in **the contents of this `vault` folder**.
3. You get an address like `https://my-vault-xyz.pages.dev`.

**Option B: GitHub Pages**
1. Create a GitHub repository and upload the contents of this folder.
2. *Settings → Pages → Deploy from branch → main / root*.
3. You get `https://<username>.github.io/<repo>/`.

Your files never go to the host. It only serves the app's code. Still, whoever controls the
hosting account could change that code, so protect the account with a strong password and
two-factor authentication.

## Installing

**iPhone / iPad**
1. Open your Vault address in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open Vault **from the Home Screen icon** and create your vault there. (Home Screen apps
   keep their storage separate from Safari tabs, and it is more durable.)

**Windows PC**
Open the address in Edge or Chrome and choose **Install app** (the icon in the address bar,
or *Menu → Apps → Install*).

## Day-to-day

- **+ Photos & videos** opens your photo library. **+ Files** opens the Files app.
- Importing copies the file; the original stays in Photos/Files. Delete it there yourself if
  you want it only in the vault.
- **Back up regularly** (Settings → Export encrypted backup → Save to Files / iCloud Drive /
  USB / PC). Keep all parts of a backup in one folder. The app shows a reminder when items
  aren't in a backup yet. A "new items only" backup needs the earlier full backup to restore everything.
  - Deleting the Vault icon from your Home Screen **deletes everything in it**. So does
    *Settings → Safari → Clear History and Website Data*. Your backups are your safety net.
- To move items between devices: export a backup on one, then **Import a backup** on the other.
  If the two vaults have different passphrases, enter the passphrase the backup was made with;
  items are re-encrypted under the receiving vault's key. Items already present are skipped.
  Folders come across too. Deletions, moves and renames made after an item was copied don't
  carry over; redo them on the other device.
- To restore onto a new phone: install Vault, then choose **Restore from a backup file**. The
  vault takes the backup's passphrase.

## Known limits

- Storage is limited by the browser. Recent iOS lets Home Screen web apps use a large share of
  free space. Check *Settings → Storage* in the app.
- Opening a file decrypts it into memory. Videos over about 1 GB may fail to play on a phone;
  the app warns first.
- HEIC photos and HEVC (iPhone) videos display on Apple devices. On Windows they show only if
  Windows has the HEIF/HEVC codecs installed. Otherwise use "Save a copy".
- iOS doesn't let web apps appear in the Photos "Share" menu, or delete from your library, so
  importing always starts from inside Vault.
- No Face ID unlock (not available to web apps).

## Updating the app

Edit the files, then increase `VERSION` in `sw.js` (e.g. `vault-v4` → `vault-v5`) and re-upload.
Installed copies pick up the update the next time they're opened online. Your stored data is untouched.

To update a device straight away: open Vault while online, go to *Settings → Check for updates*,
then lock it and open it again. *Settings → App* shows which version is installed.

## Testing locally on the PC

```bash
python -m http.server 8765 --bind 127.0.0.1 --directory vault
```

Then open http://localhost:8765. Data created on localhost is separate from your hosted copy.

## Files

- `index.html`, `styles.css`: the interface
- `js/crypto.js`: key derivation, encryption
- `js/db.js`: IndexedDB storage
- `js/vault.js`: add / list / read / delete files
- `js/backup.js`: `.pvault` export and import
- `js/media.js`: thumbnails, PDF rendering
- `js/app.js`: screens, viewer, settings, auto-lock
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and installability
- `vendor/pdfjs/`: Mozilla pdf.js 3.11.174 (Apache-2.0), bundled so PDFs open offline
