# CourseShelf

A local course viewer for your own folders. Point it at any folder and it shows your videos, PDFs, and text files in a sidebar like Udemy — with persistent progress tracking, video resume, and ffmpeg transcoding for non-native formats.

---

## Requirements

- [Node.js](https://nodejs.org/) (v18 or higher)
- [ffmpeg](https://ffmpeg.org/download.html) — required for playing `.mkv`, `.avi`, `.wmv`, `.flv`, `.mov` files

### Install ffmpeg

**Windows**
```
choco install ffmpeg
```
Or download from https://ffmpeg.org/download.html and add to PATH.

**Mac**
```
brew install ffmpeg
```

**Linux**
```
sudo apt install ffmpeg
```

Verify: `ffmpeg -version`

---

## Setup

1. **Install dependencies** (first time only)
```
cd course-viewer
npm install
```

2. **Start the server**
```
node server.js
```

3. **Open in browser**
```
http://localhost:3737
```

4. **Load a folder** — paste any absolute folder path into the input bar and press Enter or click LOAD.

---

## Folder Structure

CourseShelf reads your folder structure and numbers it automatically:

```
My Course/
  01-Introduction/          → Section 1
    01-welcome.mp4          →   file
    02-setup.mp4            →   file
  02-Basics/                → Section 2
    01-variables/           → Section 2.1
      01-lesson.mp4         →   file
    02-functions/           → Section 2.2
      01-lesson.mp4         →   file
```

Folders are numbered `1, 2, 3...` at the top level and `1.1, 1.2...` for nested folders. Files are sorted naturally so `2-foo` comes before `10-bar`.

---

## Supported File Types

| Type   | Extensions                                      | Opens in       |
|--------|-------------------------------------------------|----------------|
| Video  | `.mp4` `.webm` `.m4v`                           | Built-in player (native) |
| Video  | `.mkv` `.avi` `.mov` `.wmv` `.flv`              | Built-in player (transcoded via ffmpeg) |
| PDF    | `.pdf`                                          | Built-in viewer |
| Text   | `.txt` `.md` `.markdown`                        | Built-in viewer |

---

## Features

- **Progress tracking** — tick/untick files manually; video completion auto-ticks on end
- **Video resume** — position saved every 5 seconds, resumes where you left off
- **Overall progress circle** — shows % complete for the entire loaded folder
- **Per-section progress bar** — shows done/total for each section
- **ffmpeg transcoding** — non-native video formats streamed via ffmpeg on the fly
- **Persistent state** — progress and positions stored in `progress.db` (SQLite), survives restarts
- **Last path memory** — remembers the last folder you loaded

---

## Desktop Shortcut (Windows)

Create a `.bat` file on your Desktop:

```bat
@echo off
start http://localhost:3737
node C:\path\to\course-viewer\server.js
```

Closing the window stops the server.

---

## Auto-start on Login (Windows)

Run in PowerShell:

```powershell
schtasks /create /tn "CourseShelf" /tr "node C:\path\to\course-viewer\server.js" /sc onlogon /f
```

To stop it:
```powershell
schtasks /end /tn "CourseShelf"
```

---

## File Structure

```
course-viewer/
  server.js        ← Express backend, SQLite, ffmpeg transcoding
  package.json     ← Dependencies (express, better-sqlite3)
  progress.db      ← Auto-created on first run, do not delete
  public/
    index.html     ← React frontend (CDN, no build step)
```

---

## .gitignore

```
node_modules/
progress.db
```